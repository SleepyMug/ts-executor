# Host-subprocess Execution Boundary

> Process lifecycle, sink-delivered output, the private TSFunc result protocol, and the host-call protocol.

## Overview

Each execution owns one mode-`0o700` workspace under `resolutionRoot/.ts-executor/runs/run-<unique>/` and one direct Node subprocess, started in its own process group, whose native working directory is independently validated `execute.cwd`. There is no shell. A captured graph containing host modules gets one additional IPC descriptor; otherwise there is no message channel. Generated host-package artifacts live independently under their owner's `resolutionRoot/.ts-executor/modules/` until explicit disposal. Command arguments carry only executor-owned code and absolute operation paths. stdout/stderr go to the caller's sinks and are never retained; abort termination and group reaping after exit are part of the process lifecycle; private input/result files belong to the fixed TSFunc bootstrap. This is a lifecycle and serialization boundary, not a security boundary. The host side is trusted; the guest is untrusted for correctness (every value crossing from it is validated) but not contained, and nothing here bounds its resource use.

## Host-to-subprocess Contract

The host starts one command equivalent to:

```text
process.execPath \
  --import <absolute executor-owned tsx entry> \
  <absolute compiled ts-func-subprocess.js> \
  <absolute main.ts> <absolute input.json> <absolute result.json> <absolute result.tmp>
```

No submitted source or JSON value appears in an argument. The host passes normalized request `cwd` and `detached: true` (POSIX) to `spawn`, so the child leads a new process group. Its environment copies the parent, then the request's optional `env` additions, then the executor's own two variables: preload receives operation `TSX_TSCONFIG_PATH` and one private variable encodes the caller's original present/absent config plus any preexisting private value. That order is why `env` can shadow an inherited variable but not an executor-owned one, which control validation also rejects by name. The host's `process.env` is never mutated, so concurrent guests have independent environments. Shared bootstrap support restores both before importing guest code.

### Output

- fd 0 is ignored. fd 1 and fd 2 are pipes only when the request supplied `onStdout` / `onStderr`; otherwise they are `"ignore"`.
- Piped bytes are decoded as UTF-8 with a `StringDecoder` and passed to the sink as text as they arrive. A multibyte character split across chunks is delivered whole; a trailing incomplete sequence is flushed as U+FFFD. The host keeps no output.
- A sink that throws receives nothing further; the host terminates the process group as on abort, and the execution rejects with that error.
- The host waits for direct-child `exit` — never for pipe EOF — then runs one more event-loop poll phase so bytes the child wrote before exiting are delivered, flushes the decoders, and destroys both pipes (later descendant writes get EPIPE).

### Termination on abort

- The caller may pass an `AbortSignal`; deadlines are the caller's, e.g. `AbortSignal.any([signal, AbortSignal.timeout(ms)])`.
- Before spawning, an aborted signal rejects with `ExecutionAbortedError` and nothing is started. The synchronous type-check cannot be interrupted, so the signal is re-checked immediately before spawning: an abort during workspace preparation, checking, or input-file writing starts no guest.
- After spawning, an abort first closes the host-call bridge, if any (see the [host-call protocol](#host-call-protocol)), then sends `SIGTERM` to the process group and `SIGKILL` to the group after a fixed 2 s grace, waits for the direct child's exit, removes the workspace, releases module leases, and rejects with `ExecutionAbortedError { durationMs }` regardless of any envelope the child may have published.
- The signal counts only until the direct child's `exit` is observed. An abort after that neither signals the group nor changes the outcome: the published envelope is read as usual.
- Guest effects are not rolled back.

### Reaping after exit

After every direct-child exit, and after the final poll phase, the host SIGKILLs the remainder of the exited child's process group (best effort; `ESRCH` ignored) before workspace cleanup, so the reaping cannot cut off the child's own bytes and descendants do not outlive the execution. A descendant that moved to its own session or group escapes. On Windows only the direct child is killed.

The primitive returns nullable exit code, nullable signal, whether the caller aborted, and any process or sink error. A failed spawn has no child to reap; post-spawn IPC errors are recorded but do not permit early workspace cleanup or lease release. It does not read or classify the result envelope.

## TSFunc Protocol

Before startup the runner strictly validates optional input and writes mode-`0o600` `input.json`:

```ts
type InputEnvelope =
  | { readonly hasInput: false }
  | { readonly hasInput: true; readonly value: JsonValue };
```

The bootstrap parses input, imports `main.ts`, requires callable `main`, and awaits `main(input)`; omission is represented separately and invokes `main(undefined)`. It publishes exactly one terminal envelope:

```ts
type TSFuncResultEnvelope =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: SerializedError };
```

A resolved `undefined` (a `main` that returns nothing) is sent as `null`; any other resolved value that is not strict JSON becomes an error envelope. Status 0 must pair with valid success. Nonzero status may pair only with valid error. Missing, malformed, partial, or mismatched files are runtime failures. Success returns the value; the executor adds `durationMs`. The host reads the whole result file, whatever its size.

## Shared Terminal Publication

The bootstrap captures stdout/stderr Writable terminal `end` capabilities and `process.exit` before guest import. After `main` settles, it first closes the optional host client (rejecting pending calls and disconnecting without awaiting host work), then:

1. invokes each captured terminal `end` capability once, fully uncorking and flushing prior direct-child writes without guest-shadowable cork counters (for a pipe on Linux these writes are synchronous, so `end` completes only after the host drained them);
2. writes its complete envelope to the mode-`0o600` temporary path;
3. atomically renames that same-directory file over the final path; and
4. invokes captured exit with status 0 for success or 1 for a reported error.

A guest-replaced `process.exit` or retained event-loop handle cannot retain a completed direct child. A guest that calls original exit early bypasses publication and causes host-classified failure.

## JSON Data and Error Contracts

`JsonValue` applies to input, successful values, and host-call arguments/results:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Both sides enforce finite numbers, standard-prototype dense arrays with no extras or symbols, acyclic data, enumerable own data properties, and plain object prototypes. BigInt, `undefined`, symbols, functions, accessors, hidden properties, cycles, typed collections, dates, regular expressions, class instances, and other non-plain objects are rejected. Shared acyclic references are repeated as JSON data; identity is not preserved. Parsed envelopes require exact fields. Validation takes time linear in the size of the value.

Error envelopes use:

```ts
interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}
```

Arbitrary thrown values are manually reduced to safe strings. Class identity and custom properties are not serialized.

## Failure Classification and Ownership

- Caller abort before exit → `ExecutionAbortedError`. A throwing sink → that sink's error. Both take precedence over the envelope.
- Spawn failure, signal exit, envelope/status mismatch, early exit, and missing, partial, or malformed envelopes are runtime failures. A reported guest error is rethrown with its name/message/stack. No output is attached to any error.
- Failures before spawn — control, input, cwd, materialization, or checking — reject before any runtime; checked execution throws `TypeCheckError`.

The host owns the workspace, the direct child, the pipes, abort termination, and killing the rest of the process group after exit. The executor acquires host-module leases synchronously with each operation snapshot and releases them only after workspace cleanup, including after an abort. Module disposal stops new leases and waits for existing operations before removing its generated package; run cleanup never removes shared module artifacts. The bootstrap owns publication and direct-child flush ordering. The executor removes the workspace in `finally`. Initialization waits for sibling filesystem operations to settle before cleanup; a secondary cleanup failure does not replace a primary error and may appear as best-effort `cleanupError` metadata.

The executor never awaits guest-created descendants. Descendant bytes racing direct-child exit may be delivered or not and cannot delay the wait. Direct-child bytes written before bootstrap flush are all delivered to a stream's sink, unless that sink threw. Guest code can tamper with operation files and cleanup, and a descendant that leaves the process group escapes termination, so this is not adversarial isolation.

## Host-call Protocol

The generated package's `index.d.ts` is the caller's declarations text, verbatim. Its `index.js` contains a stable module identity, one forwarder per listed function name, and an import of the executor-owned compiled guest client by absolute file URL. It contains no per-run endpoint. Each forwarder drops trailing `undefined` arguments and sends the remaining arguments as the request's `input` array. Run-local node_modules links select packages from the registry snapshot; the host dispatch table contains only the snapshot's captured module identities. Host closures never enter the child.

When host modules are present, spawn adds an `"ipc"` descriptor (`stdio: ["ignore", stdout, stderr, "ipc"]`, each output entry `"pipe"` or `"ignore"`) with `serialization: "json"`. IPC payloads are prevalidated JSON **text strings**, with exact envelope shapes:

```ts
type HostRequest = {
  type: "ts-executor:host-request:v1";
  id: number; // positive safe integer, unique for this child
  moduleId: string;
  method: string;
  input: JsonValue; // the argument array from a generated forwarder
};
type HostResponse =
  | { type: "ts-executor:host-response:v1"; id: number; ok: true; value: JsonValue }
  | { type: "ts-executor:host-response:v1"; id: number; ok: false; error: SerializedError };
```

- The client and host strictly validate JSON before sending. A non-JSON argument rejects the call in the guest (`Host-call envelope at $.input[1] ...`); a non-JSON `call` result becomes an error reply (`Host-call envelope at $.value ...`). There is no schema validation, with or without `check: false`.
- The host rejects a `method` not in the module's `functions` and an `input` that is not an array, without invoking `call`, because a guest can send requests directly.
- Values are detached JSON snapshots, not shared identities. Functions always return guest promises. Host errors preserve name/message/optional stack, not custom fields or class identity, and may be caught by guest code without failing the execution.

Calls dispatch concurrently and may complete out of order. Repeated request IDs never replay side effects, including after an earlier response. `send() === false` is queued backpressure, not failure or a retry instruction; send callbacks report failures. Unknown modules/methods produce error replies. Invalid protocol JSON, wrong direction/version, malformed exact envelopes, duplicate IDs, or unexpected response IDs close the channel. Unrelated native messages and valid JSON without the protocol namespace are ignored. Node IPC framing is Node-specific, despite language-neutral JSON payloads. Node parses each IPC line in the host before the bridge sees it, so a guest that writes raw non-JSON bytes to its IPC descriptor makes Node throw in the host process ([IPC journal](../experiment_journal/node-child-process-ipc.md#2026-09-24-a-child-can-crash-its-parent-through-nodes-json-ipc-a-plain-fd-3-pipe-cannot)); under the trust model this is accepted, not defended. Nothing bounds the number of concurrent calls or the size of a message.

Closing/disconnecting stops new dispatch, aborts the shared host execution signal, and rejects guest pending promises. Eventual host rejections are observed and replies discarded after close. Main must await its host calls before returning: queued/unawaited effects are not guaranteed, and already-running handlers may continue after child exit or module disposal. Neither child failure nor disconnect rolls back effects. There are no retries, per-call deadlines, streaming, remote object handles, or forced host-work cancellation.

The bootstrap initializes the client before guest import and closes it before terminal publication. The bridge does not change output delivery, require a listening server, or extend direct-child ownership to descendants. On abort, or when a sink throws, the host closes the bridge before it signals the process group: the shared host-call signal fires at once, running handlers can stop, the guest's pending calls are rejected by the disconnect, and no request the guest sends during the grace period is dispatched. See the [IPC journal](../experiment_journal/node-child-process-ipc.md) for tested runtime behavior and [host modules](../components/modules/index.md#host-modules) for the `call` contract.

## Resolution and cwd

The host requires `cwd` to be an absolute native path string or query- and fragment-free local `file:` URL naming an existing directory. `spawn({ cwd })` gives concurrent children independent native relative-path semantics, including child-local `process.chdir()`.

The imported `main.ts` remains an absolute path below `resolutionRoot`. ESM and checking resolve linked operation packages first, ambient ancestors below `resolutionRoot` next, and linked-package dependencies from each package's real location. Changing `cwd` never redirects that package graph. Run-local package.json keeps main.ts in an ESM scope. Strict checking explicitly includes the original resolutionRoot's ambient Node type directory rather than assuming a workspace's immediate parent is the resolution root. Shared storage scaffolding is retained; only unique run directories are removed per operation.
