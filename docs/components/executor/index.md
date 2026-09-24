# Executor Component

> `TSFuncExecutor` provides agent guidance and orchestrates catalog, checking, workspace, cwd, control validation, and cleanup around the JSON function contract.

## Overview

`TSFuncExecutor` is the package's only executor; there is no base class or internal core. It owns a mutable module registry, but registration captures fixed discovery metadata and every catalog, checking, or execution operation captures a frozen ordered snapshot before asynchronous work begins. It returns fixed agent instructions. Workspaces are private directories at `resolutionRoot/.ts-executor/runs/run-<unique>/` and are removed when an operation settles. Generated host packages live independently until their module handles are disposed. Shared directory scaffolding is retained. Execution requires an independent absolute working directory. Deadlines and output limits belong to the caller; the program is untrusted for correctness but not contained (see [Execution-context Constraints](#execution-context-constraints)).

## Provided APIs

### Model-facing tools

- `executor.listModules({ query? }?): Promise<readonly ModuleSummary[]>` — lists the current snapshot in registration order, optionally filtering case-insensitively across specifier and description. Each entry contains `{ specifier, packageRoot, description? }`, with an absolute package directory for inspecting `package.json` and interface declarations. It returns no declaration contents and performs no filesystem work or materialization.
- `executor.execute(...)` — checks (by default) and runs a single TypeScript program under the JSON function contract below.

The harness exposes these two methods as tools and supplies filesystem access for exploring the returned package roots.

The [harness adapter example](../../../examples/harness-adapter.mjs) supplies JSON input schemas, argument validation, and model-visible error responses. It accepts string-only absolute `cwd`, fixes checking on, preserves input omission, and shows the caller owning limits: a deadline via `AbortSignal.timeout` combined with the per-call signal, byte-bounded buffers fed by `onStdout`/`onStderr`, and a `## Limits` section appended to the instructions and repeated in the `execute` tool description. [The runnable flow](../../../examples/04-agent-harness.mjs) demonstrates discovery, file inspection, a failed check, and corrected execution. These are harness examples, not executor APIs.

### Harness API and shared types

- `new TSFuncExecutor({ resolutionRoot })` — `resolutionRoot` is a non-empty path string or local `file:` URL. Relative strings resolve against the constructor call's host working directory. Operations reject a missing or non-directory root. The root controls workspace placement, ambient package ancestry, checking, and runtime ESM resolution; it is not the guest working directory.
- `executor.getInstructions(): string` — synchronously returns fixed Markdown describing only how to use `listModules` and `execute`, including inspection of package files and the JSON function contract. It takes no options, states no limits, performs no filesystem or module operation, and embeds no catalog state or harness API instructions. A harness appends its own limits.
- `executor.modules.register(module): void` — adds one exact package specifier and rejects duplicates, invalid package names, missing or non-absolute discovery roots, or missing materializers. Registry changes affect only later snapshots. Host-module dispatch capabilities survive metadata capture; registering a disposing/disposed host module rejects.
- `executor.modules.snapshot(): readonly Module[]` — returns a frozen ordered copy whose membership and discovery metadata cannot be altered by later registration. Module-owned external state remains outside this immutability guarantee. Checks and executions acquire leases on captured host modules synchronously before awaiting anything; disposing modules reject new operations. Existing leases remain valid until run cleanup completes.
- `executor.check({ source }): Promise<CheckResult>` — checks one `main.ts` with strict ES2022, Node-only, no-emit NodeNext settings, synchronously in the caller's process, and returns stable, one-based diagnostics with workspace-relative file paths.
- `ExecutorOptions` — `{ readonly resolutionRoot: string | URL }`.
- `TypeCheckError` — thrown by checked execution when `check` returns errors; exposes the immutable diagnostics array.
- `ModuleSummary` — `{ readonly specifier: string; readonly packageRoot: string; readonly description?: string }`. Discovery roots belong to the module and remain readable between operations during its lifetime; they are not temporary executor workspaces. `hostModule.dispose()` ends that lifetime, and listing an executor containing a closing host module rejects.

### Execution control

- `ExecutionControl` — optional request fields `signal?: AbortSignal`, `env?: Readonly<Record<string, string>>`, `onStdout?: (text: string) => void`, `onStderr?: (text: string) => void`. Invalid values (a non-`AbortSignal` signal, a non-function sink, a bad `env`) reject with `TypeError` before any lease, workspace, or check.
- Abort semantics — right after the control values are validated, an already-aborted signal rejects with `ExecutionAbortedError` (`durationMs` 0), before any lease, workspace, cwd check, or type-check. Checking is synchronous and cannot be interrupted, so the signal is checked again immediately before spawning: an abort during workspace preparation or checking starts no guest. During execution an abort first closes the guest's host-call bridge (running host calls see their `signal` abort; no further request is dispatched), then sends SIGTERM to the guest's process group and SIGKILL after a fixed 2 s grace, waits for the direct child's exit, removes the workspace, releases host-module leases, and rejects. Only an abort before the guest's exit is observed counts: a later one leaves its result intact. For a deadline, combine signals: `AbortSignal.any([signal, AbortSignal.timeout(ms)])`.
- Reaping — after every direct-child exit, and after its output is delivered, the host SIGKILLs the remainder of the process group (best effort, `ESRCH` ignored) before workspace cleanup. A descendant that moved to its own session or group survives.
- Output sinks — stdout/stderr are delivered as UTF-8 text as written; the executor keeps none of it. A stream without a sink is not piped. A sink that throws aborts the execution (group terminated as on abort) and `execute` rejects with that error; that sink receives nothing further. See the [runtime output contract](../runtime/index.md#provided-apis).
- `ExecutionAbortedError` — carries only `durationMs`. Effects the guest already had are not rolled back.
- `env` semantics — extra variables for one guest, merged over the inherited environment between `process.env` and the executor's own variables, so a name may shadow an inherited value but never `RESERVED_ENVIRONMENT_NAMES` (`TSX_TSCONFIG_PATH` and the private restore variable); naming one throws. The host's `process.env` is never mutated, so concurrent executions are independent and nothing persists into a later run. Names must be non-empty without `=` or NUL; values strings without NUL. An empty object resolves to no additions. See [Decision 0007](../../decisions/0007-per-execution-environment.md).

### JSON function contract

- `execute<Input extends JsonValue, Output extends JsonValue>({ source, cwd, input?, check?, ...ExecutionControl }): Promise<TSFuncExecuteResult<Output>>` — calls sync or async `main(input)`. Omitted input still invokes `main(undefined)`. Supplied input and results must be strict `JsonValue`; a `main` that returns nothing (`undefined`) resolves to `null`. Success returns the frozen `{ value, durationMs }`.
- `cwd` is required: an absolute native path string or query- and fragment-free local `file:` URL naming an existing directory. Checking is skipped only when `check === false`.
- `TSFuncExecuteRequest<Input>` — the request above.
- `TSFuncExecuteResult<Output>` — `{ readonly value: Output; readonly durationMs: number }`.
- `JsonValue` — `null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }`. Runtime validation additionally requires finite numbers, standard-prototype dense arrays without extra or symbol properties, acyclic data, enumerable data properties, and plain object prototypes. It rejects BigInt, `undefined`, functions, symbols, accessors, hidden properties, unsupported property values, and non-plain objects instead of applying permissive JSON coercions.
- Runtime failures — a reported guest error is rethrown with its name, message, and stack. Early exits, signals, and missing or mismatched envelopes are plain `Error`s. A throwing sink's error and `ExecutionAbortedError` take precedence. No output is attached to errors.

## Consumed APIs

- [Package materialization and host-module lifecycle](../modules/index.md#provided-apis) — builds the physical package graph for a registry snapshot and keeps generated packages alive through operation leases. Arbitrary custom materializers retain per-operation semantics; only generated host artifacts are reused.
- [Fresh subprocess execution](../runtime/index.md#provided-apis) — supplies the subprocess primitive, output sinks, termination, and the TSFunc protocol.
- [Host-subprocess execution boundary](../../boundaries/host-subprocess-execution.md) — constrains file modes, arguments, the result envelope, output, errors, and lifecycle.
- [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) — performs NodeNext resolution and diagnostics in the caller's process.

## Workflows

### Prepare an agent and inspect modules

1. The harness adds `getInstructions()` plus its own limits to the agent prompt and exposes `listModules` and `execute` as tools.
2. `listModules` freezes the registry view and filters metadata, including absolute package roots, without materializing packages.
3. The model uses filesystem access to read `package.json` at a returned root and follow package `types` and `exports` to relevant declarations and referenced files.
4. The model submits TypeScript to `execute`, which checks by default, and repairs any reported diagnostics before retrying.

### Check or execute source

1. `execute` validates the `ExecutionControl` fields and rejects a pre-aborted signal with `ExecutionAbortedError` before doing anything else. It then captures a registry snapshot and synchronously acquires its host-module leases, and strictly validates and encodes optional input. Failure at any stage releases every acquired lease.
2. It validates and normalizes required `cwd` independently from `resolutionRoot`.
3. It materializes every package into a new run workspace below `resolutionRoot/.ts-executor/runs/` and writes source, configuration, and package files. Each run has its own node_modules links to the captured roots, including unchanged generated host packages. If parallel initialization fails, every sibling filesystem operation settles before cleanup begins.
4. It runs strict NodeNext diagnostics synchronously. Execution proceeds unless diagnostics fail or `check === false`.
5. The TSFunc runner writes `input.json` and calls the subprocess primitive with the resolved control; if the signal has aborted by then, nothing is spawned. The guest starts in its own process group; only streams with a sink are piped, and their text goes to the sinks. If the captured graph includes host modules, an execution-scoped IPC channel dispatches calls to those modules' `call` functions; otherwise no IPC channel is opened. An abort or a throwing sink closes that channel, then terminates the group; after exit the rest of the group is killed.
6. The runner throws `ExecutionAbortedError` or the sink's error if either occurred, otherwise returns the JSON value or rethrows the guest error.
7. A `finally` path removes the complete operation directory, then releases module leases. Shared artifacts are not deleted by run cleanup. If cleanup also fails during a primary operation failure, the primary failure is preserved with best-effort `cleanupError` metadata. A post-spawn IPC error does not shorten direct-child ownership: cleanup still waits for child exit.

## Execution-context Constraints

`resolutionRoot` determines ambient package authority and resolution; `cwd` only determines subprocess-relative behavior. The registry is not an access-control list. The subprocess receives the inherited environment after bootstrap restoration and has normal filesystem, network, built-in-module, and subprocess authority. The executor owns its operation workspace and direct child; it terminates the child's process group on abort and kills what remains of it after exit (POSIX; on Windows only the direct child is killed). It is not a security boundary.

The caller and its host-module `call` functions are trusted; the program is untrusted for correctness (its data is validated and its failures reported) but not contained. The executor enforces no deadline, output cap, result size, or other resource limit and has no mechanisms that exist only to survive a hostile program: type-checking runs in the caller's process and can block it for as long as a type takes, a result is read whole, and a guest can write raw bytes to its IPC descriptor. Resource use is for the caller (its signal and sinks) and the environment to limit and monitor.
