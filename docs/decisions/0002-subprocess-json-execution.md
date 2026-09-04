# 0002: Subprocess JSON Execution

> Execution uses one plain subprocess, strict JSON files, independent cwd and resolution roots, and no parent callback channel.

## Context

The original runtime used one Node Worker for fresh state and a message-based parent bridge for a specialized adapter. Workers share the host process current directory and cannot call `process.chdir()`, so they cannot give concurrent executions independent native relative-filesystem behavior. The public value contract also inherited rich structured-clone semantics and adapter-specific complexity that was unnecessary for package-native network clients.

The required design has two independent locations: a package `resolutionRoot` beneath which checking and runtime resolve the generated absolute entrypoint, and a required per-execution `cwd` for native process-relative behavior. It also needs deterministic direct-child completion, captured output that cannot hang on descendant-held pipe descriptors, explicit serialization, and no compatibility obligation to the prior adapter or rich-value behavior.

## Decision

Use exactly one runtime backend. Each execution calls:

```text
spawn(process.execPath, ["--import", absoluteTsx, compiledBootstrap, ...absoluteOperationPaths])
```

The host validates an absolute directory `cwd`, writes a strict JSON input envelope, opens regular-file stdout/stderr descriptors, and starts the child without a shell or message channel. The compiled bootstrap restores the caller-visible TypeScript-loader environment, imports the absolute generated `main.ts`, calls and awaits exported `main`, strictly validates a successful JSON value or serializes an error, flushes direct-child output, atomically renames a private result envelope, and invokes a captured exit function. The parent waits for direct-child `exit`, validates status against the envelope, reads output, and the executor removes the workspace in `finally`.

Rename constructor option `projectRoot` to `resolutionRoot` and require `execute.cwd` as an absolute path or local `file:` URL. `cwd` affects process-relative behavior only. Checking and runtime ESM resolution continue from the generated entrypoint below `resolutionRoot`, preserving the same physical package graph and NodeNext semantics.

Restrict supplied input and successful results to strict JSON data. Reject values that JSON stringification would omit or coerce, cycles, sparse arrays, symbol keys, accessors, hidden properties, and non-plain objects. Distinguish omitted input from supplied input so omission still invokes `main(undefined)`.

Retain only physical package modules. Package-native network clients create their own transports inside each fresh subprocess. Remove every specialized parent-backed adapter, generated host package, message protocol, runtime callback dispatch table, and public type associated with them.

## Supersession

[Decision 0001](0001-package-native-general-rpc.md) remains the historical record for choosing ordinary declaration-bearing packages for general network clients; that package-native conclusion still applies. Its decision to retain a specialized connected-parent adapter and internal bridge is superseded by this decision.

The [Worker current-directory journal](../experiment_journal/node-worker-cwd.md) remains the evidence that motivated the backend change. The [child-process IPC journal](../experiment_journal/node-child-process-ipc.md) remains historical evidence from an abandoned rich-value/message-channel direction; its advanced serialization and pipe/kill conclusions do not define the new backend. The implemented file boundary instead relies only on behavior recorded for the current environment in the [child-process file execution journal](../experiment_journal/node-child-process-files.md).

## Alternatives Considered

- Keep the Worker and emulate relative paths — rejected because Node's current directory is process-wide and native package/filesystem behavior cannot be comprehensively virtualized.
- Use `fork()` with advanced serialization — rejected because no parent callback channel is needed, rich values enlarge the contract, and message transport adds lifecycle and failure modes.
- Add a compatibility facade over both runtimes — rejected because the approved API intentionally requires cwd and JSON, and one backend avoids stale semantics.
- Execute `main.ts` directly — rejected because submitted source exports `main` rather than invoking it; a bootstrap is required for invocation, validation, output ordering, result publication, and forced completion.
- Capture output through pipes — rejected because descendants can inherit descriptors and delay EOF after the direct child exits. Regular files make direct-child `exit` the only lifecycle wait.
- Resolve packages from `cwd` — rejected because it would couple unrelated filesystem and package-resolution concerns and make concurrent execution behavior dependent on caller directories.
- Kill an entire process tree — rejected because cross-platform tree ownership is outside the small API and is not required for direct-child freshness.

## Consequences

- Every execution has fresh process and package state plus an independent native working directory.
- Input and result behavior is portable, inspectable JSON rather than transport-specific object cloning; rich JavaScript values are intentionally unsupported.
- Result publication and direct-child output have explicit ordering and failure classification without a message channel.
- Descendants are outside executor ownership. Their output can race the parent's final read, and hostile descendants can interfere with cleanup.
- The module API is smaller and package-native network clients reconnect for each execution.
- The package continues to declare Node 18.19 or newer for the `tsx` preload route, but this decision claims runtime/file behavior testing only for Node v24.15.0 on Linux x64 as recorded in the journal; no untested platform matrix is asserted.
