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
