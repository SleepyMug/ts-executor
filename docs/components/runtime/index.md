# Runtime Component

> A neutral spawn primitive supports separate JSON-function and stdout-process bootstraps and host-side interpreters.

## Overview

Every execution starts exactly one Node subprocess with `spawn(process.execPath, ...)`. An operation containing host modules gets one additional IPC descriptor; other operations have no message channel. A neutral primitive owns startup, the executor-owned `tsx` preload, regular-file stream capture, direct-child reaping, and raw termination metadata. It returns exit code, signal, stdout, and stderr without knowing whether the caller expects JSON or stdout.

Flavor-specific host runners choose distinct compiled JavaScript bootstraps and interpret distinct private envelopes. Ordinary package code, including network clients, runs entirely in the subprocess. Generated host-package proxies route asynchronous calls to the captured host dispatch table without owning a transport or embedding per-run endpoints. Freshness is a lifecycle guarantee, not a sandbox.

## Provided APIs

### Neutral process primitive

- `runSubprocess(workspace, cwd, bootstrap, arguments): Promise<SubprocessResult>` — internal primitive that opens output files, starts one direct child without a shell, attaches an optional host bridge, waits for its `exit`, closes parent handles, reads both output files, and returns `exitCode`, `signal`, `stdout`, `stderr`, and any startup/output or handle-close failures. It never interprets a flavor status envelope. Spawn failures have no child to reap; errors after a successful spawn are recorded but do not release files or module leases before the child's exit.
- Freshness invariant — every call starts and reaps a distinct process, so globals, singleton state, ESM module instances, and package clients do not survive execution.
- Output contract — fd 1 and fd 2 are mode-`0o600` private regular files rather than inherited pipes. Writes flushed by the direct child before publication are included. Descendant writes racing direct-child exit may or may not be observed and never delay the host's wait. ANSI color escapes are preserved, not stripped; inherited `FORCE_COLOR` can affect console inspection even with file-backed stdout. Use explicit string writes for deterministic machine output; see the [forced-color finding](../../experiment_journal/node-child-process-files.md#2026-09-14-forced-console-colors-survive-regular-file-stdout-capture).

### TSFunc runtime

- `runTSFuncProcess(workspace, cwd, inputEnvelope): Promise<{ value, stdout, stderr }>` — internal flavor runner that writes a private strict-JSON input file, selects `ts-func-subprocess.js`, validates its result envelope against exit status, and returns JSON value plus both streams.
- Program contract — the module exports sync or async `main(input)`. Omitted input is represented separately and passed as `undefined`; supplied input and every successful result must be strict JSON.
- Failure contract — reported guest/import/input/result-validation failures use a serialized error envelope. Runtime errors receive captured stdout/stderr.

### Proc runtime

- `runProcProcess(workspace, cwd): Promise<string>` — internal flavor runner that selects `proc-subprocess.js`, validates its private status envelope against exit status, and returns exact stdout.
- Program contract — the module exports sync or async `main()`; it receives no arguments and must resolve to exactly `undefined`. A returned value is a reported guest-contract failure.
- Failure contract — every classified post-start failure becomes exported `ProcExecutionError` with captured stdout/stderr and exact nullable exit code/signal. Serialized guest errors preserve useful name/message/stack.
- Success output contract — only stdout is returned. Captured stderr is deliberately discarded after success and is not merged into stdout.

### Shared bootstrap completion

Both compiled flavor entrypoints load shared executor-owned completion support before guest import. It captures stdout/stderr terminal `end` capabilities and `process.exit`, initializes the optional host client, restores the caller-visible loader environment, closes the client on completion, terminally ends both streams, atomically renames one private envelope, and invokes captured exit. Terminal ending fully uncorks queued writes without reading guest-shadowable cork counters. Guest-retained timers and replacement of `process.exit` therefore do not retain a completed direct child.

### Host-call bridge

- `attachHostBridge(child, invoke): () => void` — synchronously attaches JSON-text request dispatch after spawn. Dispatch is concurrent, limited to the operation's captured module identities, and never retries. Close is idempotent, stops new dispatch, aborts one shared execution signal, detaches listeners, and does not await running handlers. It also runs on disconnect/error/exit.
- `initializeHostClient()` — both bootstraps initialize a shared compiled guest client before guest import; it creates no channel if `process.send` is absent.
- `callHost(moduleId, method, input): Promise<JsonValue>` — generated proxies return this promise directly. Strict JSON validation precedes sending, IDs correlate concurrent calls, and serialized host failures become catchable rejections. The original promise has an internal rejection observer so abandoned calls do not derail terminal publication.
- `closeHostClient()` — called when main settles, before flush/publication. Rejects outstanding requests, prevents later calls, and disconnects. Main must await desired host work; effects from unawaited calls are not guaranteed and already-started host work may continue.

## Consumed APIs

- [Materialized packages](../modules/index.md#provided-apis) — packages are imported through ordinary Node ESM lookup from the absolute generated entrypoint.
- [Host-subprocess execution boundary](../../boundaries/host-subprocess-execution.md) — defines common arguments/output/lifecycle and both private flavor protocols.
- [`node:child_process.spawn`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options) — starts the direct child without a shell, optionally with an IPC descriptor, and applies operation `cwd`.
- [`node:fs`](https://nodejs.org/api/fs.html) — supplies private regular output files and same-directory atomic rename for terminal publication.
- [`tsx`](https://tsx.is/) — preloads TypeScript support from an executor-owned absolute path; it does not replace package resolution.
- [Node child-process file execution journal](../../experiment_journal/node-child-process-files.md) — records the plain-spawn, file-output, terminal stream-ending, environment-restoration, rename, descendant-output, and reaping behavior verified on Node v24.15.0, Linux x64.

- [Host functions](../host-functions/index.md#provided-apis) — validates JSON/schema input and results, invokes captured host callbacks, and receives the execution AbortSignal.
- [Node child-process IPC journal](../../experiment_journal/node-child-process-ipc.md) — records JSON-text IPC with file output, nested TypeScript entrypoints, disconnection, and backpressure behavior on the tested runtime.

## Workflows

### Run a TSFunc entrypoint

1. The runner writes `input.json`, then the primitive opens stdout/stderr and starts Node with `ts-func-subprocess.js` plus absolute entrypoint/input/result/temporary paths.
2. The bootstrap restores the caller-visible environment, parses input, imports `main.ts`, verifies `main`, and awaits `main(input)`.
3. It validates the JSON result or serializes a thrown value, flushes both streams, atomically publishes `result.json`, and exits 0 or 1.
4. The primitive returns raw termination/output; the TSFunc runner validates status/envelope agreement and returns or throws.

### Run a Proc entrypoint

1. The primitive opens stdout/stderr and starts Node with `proc-subprocess.js` plus absolute entrypoint/status/temporary paths. There is no input file.
2. The bootstrap restores the environment, imports `main.ts`, verifies `main`, and awaits `main()` with no arguments.
3. Exactly `undefined` publishes success; a returned value or thrown error publishes serialized failure. Both streams are flushed before atomic `proc-status.json` publication.
4. The primitive returns raw termination/output; the Proc runner validates status/envelope agreement, returns stdout alone on success, or throws `ProcExecutionError` containing both streams and termination fields.

## Execution-context Constraints

Subprocess code has normal Node authority, including built-ins, filesystem, working-directory changes, child processes, network, dynamic import, and environment access. The executor owns and reaps only the direct child; it neither kills nor awaits descendants. A hostile descendant can interfere with filesystem cleanup. The package declares Node 18.19 or newer for the `tsx` `--import` path, while relied-on subprocess file behavior has been exercised here only on Node v24.15.0, Linux x64. There is no public backend/mode/plugin abstraction, execution timeout/cancellation, environment filtering, process pool, or process-tree manager. Host-call abort notification is cooperative, not an execution-cancellation API.
