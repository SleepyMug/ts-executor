# Node Child-process IPC

> Records child-process IPC serialization, TypeScript preload, stream, and lifecycle behavior relevant to the execution backend.

## Overview

A separate Node process can provide a per-execution current directory and an IPC channel for the parent-owned MCP client. Its IPC and termination semantics differ from `worker_threads`, so the executor must not assume the existing Worker behavior transfers unchanged.

## 2026-09-03: Advanced fork IPC preserves rich values but reports clone failures differently

### Context

The proposed runtime uses `child_process.fork()` with `serialization: "advanced"` so execution inputs, results, and MCP calls are not reduced to JSON.

### Finding

On Node v24.15.0, advanced fork IPC preserved cycles, `Map`, `Set`, typed arrays, `BigInt`, `Date`, `RegExp`, `Buffer`, and `Error` name/type in a round trip. Sending a function failed synchronously from `child.send()` with an `Error` whose message ended in `could not be cloned`; it was not named `DataCloneError` and had no error code.

The behavior therefore supports the executor's ordinary rich-value cases but is not API-compatible with Worker structured clone errors. Unsupported-value behavior and exact representations still need verification on every supported Node major before migration.

### Implications

The child backend must explicitly select advanced serialization. If `DataCloneError` remains part of the executor contract, clone failures need normalization rather than exposing Node's transport-specific error name. Shared memory and custom prototypes must not be promised without separate verification.

### References

- [Node.js child process advanced serialization](https://nodejs.org/api/child_process.html#advanced-serialization)

## 2026-09-03: ESM child preload and explicit stream flushing work on the current runtime

### Context

The child must import a TypeScript entrypoint through the executor's installed `tsx`, capture complete output, and then be forcibly reaped even when guest handles remain active.

### Finding

On Node v24.15.0, an ESM child started by `fork()` with `execArgv: ["--import", <absolute tsx URL>]` successfully imported and ran a `.ts` module. An explicit `cwd` was visible through `process.cwd()` in the child.

A probe wrote 1 MiB each to piped stdout and stderr, waited for both write callbacks, sent a terminal IPC message, and was immediately killed by the parent with `SIGKILL`. The parent received the full 1 MiB from both streams. This validates the proposed flush-before-terminal ordering on the current runtime, but not yet on Node 18/20, Windows, or with descendant processes holding inherited descriptors.

### Implications

The child bootstrap should flush stdout and stderr before sending its terminal message. The parent should treat that message as permission to kill and reap the direct child, then finish collecting its streams. Cross-version and cross-platform tests remain a migration prerequisite.

### References

- [Node.js `child_process.fork()`](https://nodejs.org/api/child_process.html#child_processforkmodulepath-args-options)
- [Node.js TypeScript support and third-party loaders](https://nodejs.org/api/typescript.html)

## 2026-09-12: JSON-text IPC coexists with file output and nested TypeScript entrypoints

### Context

The host-function bridge needs a per-child channel without replacing regular-file stdout/stderr, independent cwd, or terminal result files. Probes and integration tests ran on Node v24.15.0, Linux x64, with tsx 4.23.13 and TypeScript 5.9.3.

### Finding

- `spawn(process.execPath, ..., { stdio: ["ignore", stdoutFd, stderrFd, "ipc"], serialization: "json" })` exposed `child.send` and `process.send` while preserving regular-file output. Sending prevalidated JSON text as the message avoided rich-value serialization semantics.
- Concurrent request IDs correlated out-of-order responses. Direct child disconnect and forced exit notified the parent while already-started parent promises remained ordinary host work; they were not canceled automatically.
- Terminally disconnecting IPC before stream ending and file publication did not prevent TSFunc or Proc terminal files from being published and their children being reaped. An uncooperative parent callback need not delay child completion.
- A main.ts nested under `.ts-executor/runs/<id>/`, with run-local node_modules symlinks to shared physical package roots, both checked and executed correctly. Explicitly supplying the original resolutionRoot's Node type directory preserved ambient Node declarations. Independent cwd and package realpath resolution continued to work.
- Focused transport tests verified that a false `send()` return must be treated as queued backpressure, not as permission to retry. Callback errors and child error events are not evidence that an already-spawned child has exited; a separate direct-child exit wait is necessary before releasing files.

### Implications

The JSON host-call channel can remain separate from the existing result/output contracts. Keep per-run package links and explicitly retain ambient type lookup when adding directory depth. These observations do not establish support for the untested Node-major or Windows/macOS matrix, and Node's native IPC framing is not a language-neutral transport.

### References

- [Node.js child process send and error events](https://nodejs.org/api/child_process.html)
- [Node.js ESM resolution](https://nodejs.org/api/esm.html#resolution-and-loading-algorithm)
