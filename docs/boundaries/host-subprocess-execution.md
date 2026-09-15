# Host-subprocess Execution Boundary

> Common process lifecycle and regular-file output capture carry separate private TSFunc result and Proc status protocols.

## Overview

Each execution owns one mode-`0o700` workspace under `resolutionRoot/.ts-executor/runs/run-<unique>/` and one direct Node subprocess, started in its own process group, whose native working directory is independently validated `execute.cwd`. There is no shell. A captured graph containing host modules gets one additional IPC descriptor; otherwise there is no message channel. Generated host-package artifacts live independently under their owner's `resolutionRoot/.ts-executor/modules/` until explicit disposal. Command arguments carry only executor-owned code and absolute operation paths. Bounded stdout/stderr pipe capture, abort/deadline termination, and raw process termination are flavor-neutral; private input/result/status files belong to a specific fixed bootstrap. This is a lifecycle and serialization boundary, not a security boundary.

## Common Host-to-subprocess Contract

The host gives the child pipes as fd 1 and fd 2 and drains them into buffers that retain at most `maxOutputBytes` per stream (default 4 MiB); further bytes are consumed and discarded and the stream is flagged `truncated`. It starts one command equivalent to:

```text
process.execPath \
  --import <absolute executor-owned tsx entry> \
  <absolute compiled flavor bootstrap> \
  <absolute flavor operation paths...>
```

No submitted source or JSON value appears in an argument. The host passes normalized request `cwd` and `detached: true` (POSIX) to `spawn`, so the child leads a new process group. Its environment copies the parent except that preload receives operation `TSX_TSCONFIG_PATH` and one private variable encodes the caller's original present/absent config plus any preexisting private value. Shared bootstrap support restores both before importing guest code.

The neutral host primitive waits for direct-child `exit` — never for pipe EOF — then runs one more event-loop poll phase so bytes the child wrote before exiting are read, destroys both pipes (later descendant writes get EPIPE), and returns nullable exit code, nullable signal, both captured streams, per-stream truncation flags, and the abort reason if the host terminated the group. A failed spawn has no child to reap; post-spawn IPC errors are recorded but do not permit early workspace cleanup or lease release. It does not read or classify a flavor envelope.

### Termination on abort or deadline

The caller may pass an `AbortSignal` and a `timeoutMs` deadline measured from the `execute` call. Before spawning, an aborted signal or an elapsed deadline rejects with `ExecutionAbortedError` and nothing is started (the synchronous type-check cannot be interrupted, so the deadline is re-checked after it). After spawning, the host on abort or deadline sends `SIGTERM` to the process group, `SIGKILL` to the group after `killGraceMs` (default 2000 ms), waits for the direct child's exit, drains and destroys the pipes, removes the workspace, releases module leases, and rejects with `ExecutionAbortedError { reason: "signal" | "timeout", stdout, stderr, truncated, exitCode, signal, durationMs }` regardless of any envelope the child may have published. A normal completion never kills the group. Guest effects are not rolled back.

## TSFunc Protocol

Before startup the TSFunc runner strictly validates optional input and writes mode-`0o600` `input.json`:

```ts
type InputEnvelope =
  | { readonly hasInput: false }
  | { readonly hasInput: true; readonly value: JsonValue };
```

It selects `ts-func-subprocess.js` and passes four paths after the bootstrap:

```text
<absolute main.ts>
<absolute input.json>
<absolute result.json>
<absolute result.tmp>
```

The bootstrap parses input, imports `main.ts`, requires callable `main`, and awaits `main(input)`; omission is represented separately and invokes `main(undefined)`. It publishes exactly one terminal envelope:

```ts
type TSFuncResultEnvelope =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: SerializedError };
```

Status 0 must pair with valid success. Nonzero status may pair only with valid error. Missing, malformed, partial, or mismatched files are runtime failures. Successful host output is `{ value, stdout, stderr, truncated }`; the public executor adds duration.

## Proc Protocol

Proc writes no input file and passes three paths after `proc-subprocess.js`:

```text
<absolute main.ts>
<absolute proc-status.json>
<absolute proc-status.tmp>
```

The bootstrap imports `main.ts`, requires callable `main`, and invokes `main()` with no arguments. Sync and async results are awaited. Only a resolved value exactly equal to `undefined` succeeds; every other value produces a `TypeError` failure status. The private envelope carries status, never successful output:

```ts
type ProcStatusEnvelope =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SerializedError };
```

Status 0 must pair with `{ ok: true }`; nonzero reported failure must pair with `{ ok: false, error }`. Success returns the captured stdout with its truncation flag (`executeDetailed`); the exact-stdout `execute` rejects when stdout was truncated. Successful stderr is intentionally discarded and never appended/prepended to stdout. Every classified Proc runtime failure throws `ProcExecutionError` containing captured `stdout`, captured `stderr`, `truncated`, exact `exitCode` (`number | null`), and exact `signal` (`NodeJS.Signals | null`). When the envelope reports a guest error, its useful name, message, and stack become the standard properties of that `ProcExecutionError` instance.

## Shared Terminal Publication

Each flavor bootstrap captures stdout/stderr Writable terminal `end` capabilities and `process.exit` before guest import. After its call settles, it first closes the optional host client (rejecting pending calls and disconnecting without awaiting host work), then:

1. invokes each captured terminal `end` capability once, fully uncorking and flushing prior direct-child writes into the host's pipe without guest-shadowable cork counters (on Linux these writes are synchronous, so `end` completes only after the host drained them);
2. writes its complete envelope to the flavor's mode-`0o600` temporary path;
3. atomically renames that same-directory file over the final path; and
4. invokes captured exit with status 0 for success or 1 for a reported error.

A guest-replaced `process.exit` or retained event-loop handle cannot retain a completed direct child. A guest that calls original exit early bypasses publication and causes host-classified failure.

## JSON Data and Error Contracts

`JsonValue` applies to TSFunc input/successful value and host-call arguments/results (including when used by Proc):

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Both TSFunc sides enforce finite numbers, standard-prototype dense arrays with no extras or symbols, acyclic data, enumerable own data properties, and plain object prototypes. BigInt, `undefined`, symbols, functions, accessors, hidden properties, cycles, typed collections, dates, regular expressions, class instances, and other non-plain objects are rejected. Shared acyclic references are repeated as JSON data; identity is not preserved. Parsed envelopes require exact fields.

Both error envelopes use:

```ts
interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}
```

Arbitrary thrown values are manually reduced to safe strings. Class identity and custom properties are not serialized.

## Failure Classification and Ownership

Spawn failure, signal exit, envelope/status mismatch, early exit, and missing, partial, or malformed envelope are runtime failures. TSFunc reconstructs its existing output-bearing `Error`. Proc normalizes every such post-start classification to `ProcExecutionError`; guest name/message/stack are retained when available. Failures before spawn—input, cwd, materialization, or checking—have no runtime output/termination contract, and checked execution throws `TypeCheckError`.

The host owns workspace, direct child, the pipes and their bounded buffers, the abort/deadline timers, and the process group's termination on abort. The core acquires host-module leases synchronously with each operation snapshot and releases them only after workspace cleanup, including after an abort. Module disposal stops new leases and waits existing operations before removing its generated package; run cleanup never removes shared module artifacts. Bootstrap owns publication and direct-child flush ordering. The core removes the workspace in `finally`. Initialization waits for sibling filesystem operations to settle before cleanup; a secondary cleanup failure does not replace a primary error and may appear as best-effort `cleanupError` metadata.

The executor never awaits guest-created descendants and kills them (as members of the group) only on abort or deadline. Descendant bytes racing direct-child exit may be present or absent and cannot delay the wait. Direct-child bytes completed before bootstrap flush are guaranteed up to `maxOutputBytes` per stream. Guest code can tamper with operation files and cleanup, and a descendant that leaves the process group escapes termination, so this is not adversarial isolation.

## Host-call Protocol

The generated proxy package contains a stable module identity and imports the executor-owned compiled guest client by absolute file URL. It contains no per-run endpoint. Run-local node_modules links select packages from the registry snapshot; the host dispatch table contains only the snapshot's captured module identities and function definitions. Host callbacks and closures never enter the child.

When host modules are present, spawn uses `stdio: ["ignore", stdoutFd, stderrFd, "ipc"]` with `serialization: "json"`. IPC payloads are prevalidated JSON **text strings**, with exact envelope shapes:

```ts
type HostRequest = {
  type: "ts-executor:host-request:v1";
  id: number; // positive safe integer, unique for this child
  moduleId: string;
  method: string;
  input: JsonValue;
};
type HostResponse =
  | { type: "ts-executor:host-response:v1"; id: number; ok: true; value: JsonValue }
  | { type: "ts-executor:host-response:v1"; id: number; ok: false; error: SerializedError };
```

The client and host strictly validate JSON before sending. The host additionally enforces each function's input/output schema, even with `check: false`. Values are detached JSON snapshots, not shared identities. Functions always return guest promises. Host errors preserve name/message/optional stack, not custom fields or class identity, and may be caught by guest code without failing the entire execution.

Calls dispatch concurrently and may complete out of order. Repeated request IDs never replay side effects, including after an earlier response. `send() === false` is queued backpressure, not failure or a retry instruction; send callbacks report failures. Unknown modules/methods produce error replies. Invalid protocol JSON, wrong direction/version, malformed exact envelopes, duplicate IDs, or unexpected response IDs close the channel. Unrelated native messages and valid JSON without the protocol namespace are ignored. Node IPC framing is Node-specific, despite language-neutral JSON payloads.

Closing/disconnecting stops new dispatch, aborts the shared host execution signal, and rejects guest pending promises. Eventual host rejections are observed and replies discarded after close. Main must await its host calls before returning: queued/unawaited effects are not guaranteed, and already-running handlers may continue after child exit or module disposal. Neither child failure nor disconnect rolls back effects. There are no retries, per-call deadlines, streaming, remote object handles, or forced host-work cancellation.

Both bootstraps initialize the client before guest import and close it before terminal publication. The bridge does not change stdout/stderr semantics, require a listening server, or extend direct-child ownership to descendants. On abort the bridge is closed after the child exits, so the shared host-call signal fires and pending guest calls are rejected. See the [IPC journal](../experiment_journal/node-child-process-ipc.md) for tested runtime behavior and [host functions](../components/host-functions/index.md#provided-apis) for the supported schema contract.

## Resolution and cwd

The host requires `cwd` to be an absolute native path string or query- and fragment-free local `file:` URL naming an existing directory. `spawn({ cwd })` gives concurrent children independent native relative-path semantics, including child-local `process.chdir()`.

The imported `main.ts` remains an absolute path below `resolutionRoot`. ESM and checking resolve linked operation packages first, ambient ancestors below `resolutionRoot` next, and linked-package dependencies from each package's real location. Changing `cwd` never redirects that package graph. Run-local package.json keeps main.ts in an ESM scope. Strict checking explicitly includes the original resolutionRoot's ambient Node type directory rather than assuming a workspace's immediate parent is the resolution root. Shared storage scaffolding is retained; only unique run directories are removed per operation.
