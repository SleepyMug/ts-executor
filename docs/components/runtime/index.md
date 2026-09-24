# Runtime Component

> A subprocess primitive streams output to caller sinks, closes the host-call bridge and terminates the process group on abort, reaps it after exit, and carries the JSON function bootstrap and host-call bridge.

## Overview

Every execution starts exactly one Node subprocess with `spawn(process.execPath, ...)` in its own process group. An operation containing host modules gets one additional IPC descriptor; other operations have no message channel. The subprocess primitive owns startup, the executor-owned `tsx` preload, delivery of stdout/stderr to the caller's sinks, closing the host-call bridge and then terminating the process group on abort or sink failure, direct-child reaping, and killing the rest of the group after exit. It returns raw termination metadata without interpreting the result envelope.

The TSFunc runner writes the input file, selects the compiled `ts-func-subprocess.js` bootstrap, and interprets its private result envelope. Ordinary package code, including network clients, runs entirely in the subprocess. Generated host-package forwarders route asynchronous calls to the captured host dispatch table without owning a transport or embedding per-run endpoints. Freshness is a lifecycle guarantee, not a sandbox.

## Provided APIs

### Subprocess primitive

- `runSubprocess(workspace, cwd, bootstrap, arguments, control): Promise<SubprocessResult>` — internal primitive that starts one direct child without a shell in its own process group (`detached` on POSIX), pipes only the streams that have a sink, attaches an optional host bridge, arms the caller's abort signal, waits for the child's `exit`, runs one further event-loop poll phase to deliver bytes the child wrote before exiting, SIGKILLs what remains of the group, flushes the decoders, and destroys the pipes. If the signal has already aborted it spawns nothing and returns `aborted` at once, so an abort during the caller's preparation (workspace, type-check, input file) starts no guest. It returns `exitCode`, `signal`, `aborted` (the caller's signal aborted before the child's exit was observed, or before spawn), and `error` (a process-level failure, or the error a sink threw). Spawn failures have no child to reap; errors after a successful spawn are recorded but do not release module leases before the child's exit.
- Termination contract — on abort, or when a sink throws, the primitive first closes the host bridge (running host calls see their `signal` abort, and no further guest request is dispatched), then sends SIGTERM to the group, SIGKILL after a fixed 2 s grace (`KILL_GRACE_MS`, internal), and still waits for the direct child's exit. Termination is armed at most once and never after the child has been reaped. The caller's signal stops counting when the child's `exit` is observed (the primitive's exit listener runs before any other): a later abort neither sets `aborted` nor signals the group, so a guest that completed keeps its result. A sink failure during the final drain is still reported.
- Reaping contract — after every direct-child exit and the final poll phase, the primitive sends SIGKILL to the exited child's process group (best effort; `ESRCH` means nothing remained), so descendants do not outlive the execution. It cannot truncate the child's own output, which was delivered first. A descendant that moved to its own session or group is out of reach.
- Freshness invariant — every call starts and reaps a distinct process, so globals, singleton state, ESM module instances, and package clients do not survive execution.
- Output contract — a stream with a sink is a pipe; one without is `stdio: "ignore"`. Chunks are decoded with a `StringDecoder`, so a multibyte UTF-8 character split across writes or reads is delivered whole; an incomplete sequence at the end of the stream is flushed as U+FFFD. Nothing is retained. A sink that throws is recorded as the execution's error, terminates the group, and receives nothing further. The host waits only for direct-child exit, never for pipe EOF: bytes the direct child wrote before exiting are already in the kernel pipe buffer at `exit` and are read in the following poll phase (two `setImmediate` turns, which also covers a host event loop that was blocked when the child exited) — see the [pipe drain finding](../../experiment_journal/node-child-process-files.md#2026-09-16-pipe-capture-drains-completely-after-direct-child-exit-and-group-kill-reaches-descendants). Descendant writes racing direct-child exit may or may not be delivered and never delay the wait; descendants writing after the host destroys the pipe receive EPIPE. On Linux, Node writes to a pipe-backed `process.stdout` synchronously, so a guest pauses while the host is not draining (for example during another execution's synchronous type-check) and while a sink runs. ANSI color escapes are preserved, not stripped; inherited `FORCE_COLOR` can affect console inspection. Use explicit string writes for deterministic machine output; see the [forced-color finding](../../experiment_journal/node-child-process-files.md#2026-09-14-forced-console-colors-survive-regular-file-stdout-capture).

### TSFunc runtime

- `runTSFuncProcess(workspace, cwd, inputEnvelope, control): Promise<JsonValue>` — internal runner that writes a private strict-JSON input file, selects `ts-func-subprocess.js`, throws `ExecutionAbortedError` when the primitive reports a caller abort, throws a recorded sink or process error, and otherwise reads the result file, validates the result envelope against exit status, and returns the JSON value.
- Program contract — the module exports sync or async `main(input)`. Omitted input is represented separately and passed as `undefined`; supplied input and every successful result must be strict JSON; a result of `undefined` (nothing returned) is sent as `null`.
- Failure contract — reported guest/import/input/result-validation failures use a serialized error envelope and are rethrown with their name, message, and stack. Early exit, signal exit, and missing or mismatched envelopes are host-classified `Error`s. No output is attached.

### Shared bootstrap completion

The compiled entrypoint loads executor-owned completion support before guest import. It captures stdout/stderr terminal `end` capabilities and `process.exit`, initializes the optional host client, restores the caller-visible loader environment, closes the client on completion, terminally ends both streams (for a pipe this completes only once the host has drained the written bytes), atomically renames the private envelope, and invokes captured exit. Terminal ending fully uncorks queued writes without reading guest-shadowable cork counters. Guest-retained timers and replacement of `process.exit` therefore do not retain a completed direct child.

### Host-call bridge

- `attachHostBridge(child, invoke): () => void` — synchronously attaches JSON-text request dispatch after spawn. Dispatch is concurrent, limited to the operation's captured module identities, and never retries. Close is idempotent, stops new dispatch, aborts one shared execution signal, detaches listeners, and does not await running handlers. The primitive calls it on abort or sink failure before signalling the group; it also runs on disconnect/error/exit.
- `initializeHostClient()` — the bootstrap initializes the guest client before guest import; it creates no channel if `process.send` is absent.
- `callHost(moduleId, method, input): Promise<JsonValue>` — generated forwarders return this promise directly, with `input` the argument array. Strict JSON validation precedes sending, IDs correlate concurrent calls, and serialized host failures become catchable rejections. The original promise has an internal rejection observer so abandoned calls do not derail terminal publication.
- `closeHostClient()` — called when main settles, before flush/publication. Rejects outstanding requests, prevents later calls, and disconnects. Main must await desired host work; effects from unawaited calls are not guaranteed and already-started host work may continue.

## Consumed APIs

- [Materialized packages and host calls](../modules/index.md#provided-apis) — packages are imported through ordinary Node ESM lookup from the absolute generated entrypoint; host-module bindings check names and argument arrays and invoke the caller's `call`, which receives the execution AbortSignal.
- [Host-subprocess execution boundary](../../boundaries/host-subprocess-execution.md) — defines arguments, output delivery, lifecycle, and the TSFunc and host-call protocols.
- [`node:child_process.spawn`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options) — starts the direct child without a shell in its own process group, with pipe or ignored stdio and optionally an IPC descriptor, and applies operation `cwd`; `process.kill(-pid, signal)` terminates the group.
- [`node:string_decoder`](https://nodejs.org/api/string_decoder.html) — keeps multibyte characters whole across chunks.
- [`node:fs`](https://nodejs.org/api/fs.html) — supplies same-directory atomic rename for terminal publication.
- [`tsx`](https://tsx.is/) — preloads TypeScript support from an executor-owned absolute path; it does not replace package resolution.
- [Node child-process file execution journal](../../experiment_journal/node-child-process-files.md) — records the plain-spawn, terminal stream-ending, environment-restoration, rename, pipe-drain, group-kill, and reaping behavior verified on Node v24.15.0, Linux x64.
- [Node child-process IPC journal](../../experiment_journal/node-child-process-ipc.md) — records JSON-text IPC with nested TypeScript entrypoints, disconnection, and backpressure behavior on the tested runtime, and that a guest writing raw bytes to its IPC descriptor can crash the host (accepted under the trust model).

## Workflows

### Run a TSFunc entrypoint

1. The runner writes `input.json`, then the primitive (unless the signal has already aborted) starts Node with `ts-func-subprocess.js` plus absolute entrypoint/input/result/temporary paths, piping only streams with a sink and arming the abort signal.
2. The bootstrap restores the caller-visible environment, parses input, imports `main.ts`, verifies `main`, and awaits `main(input)`.
3. It validates the JSON result or serializes a thrown value, flushes both streams, atomically publishes `result.json`, and exits 0 or 1.
4. The primitive waits for exit and one more poll phase, kills the rest of the group, flushes the decoders to the sinks, and returns raw termination. The runner throws `ExecutionAbortedError` if the caller aborted before exit, a sink's error if one threw, otherwise validates status/envelope agreement and returns or throws.

## Execution-context Constraints

Subprocess code has normal Node authority, including built-ins, filesystem, working-directory changes, child processes, network, dynamic import, and environment access. The executor owns and reaps only the direct child and never awaits descendants; it kills the child's process group on abort or sink failure and what remains of it after exit. A hostile descendant can interfere with filesystem cleanup, and a descendant that changes its own process group or session escapes termination. The package declares Node 18.19 or newer for the `tsx` `--import` path, while relied-on subprocess pipe, kill, and reaping behavior has been exercised here only on Node v24.15.0, Linux x64; Windows has no process groups, so only the direct child is killed there. There is no backend/mode/plugin abstraction, deadline, output cap, environment filtering (a request's `env` adds variables for its own guest; inherited ones always pass through), or process pool. Host-call abort notification is cooperative and distinct from execution cancellation. The guest is not contained: its resource use (CPU, memory, output, result size, host-call traffic) is for the caller and the environment to limit.
