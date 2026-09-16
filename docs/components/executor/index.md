# Executor Component

> `TSFuncExecutor` and `ProcExecutor` provide agent guidance and compose shared catalog, checking, workspace, cwd, and cleanup orchestration while enforcing separate execution contracts.

## Overview

Each public executor owns an internal `ExecutorCore`; neither inherits from a public base class. The core owns a mutable module registry, but registration captures fixed discovery metadata and every catalog, checking, or execution operation captures a frozen ordered snapshot before asynchronous work begins. It also holds deterministic agent guidance assembled from shared text segments and one flavor-specific segment. Common workspaces are private directories at `resolutionRoot/.ts-executor/runs/run-<unique>/` and are removed when an operation settles. Generated host packages live independently until their module handles are disposed. Shared directory scaffolding is retained. Execution requires an independent absolute working directory.

## Provided APIs

### Model-facing tools

- `executor.listModules({ query? }?): Promise<readonly ModuleSummary[]>` — lists the current snapshot in registration order, optionally filtering case-insensitively across specifier and description. Each entry contains `{ specifier, packageRoot, description? }`, with an absolute package directory for inspecting `package.json` and interface declarations. It returns no declaration contents and performs no filesystem work or materialization.
- `executor.execute(...)` — runs a single TypeScript program, checking it by default. The selected executor defines the input/output contract below.

The harness exposes these two methods as tools and supplies filesystem access for exploring the returned package roots.

The [harness adapter example](../../../examples/harness-adapter.mjs) supplies JSON input schemas, argument validation, and model-visible error responses. It accepts string-only absolute `cwd`, fixes pre-execution checking on, preserves TSFunc input omission, and forwards diagnostics and captured runtime output. [The runnable flow](../../../examples/05-agent-harness.mjs) demonstrates discovery, file inspection, a failed check, and corrected execution. These are harness examples, not additional executor APIs.

### Harness API and shared types

- `new TSFuncExecutor({ resolutionRoot })` and `new ProcExecutor({ resolutionRoot })` — create separate executors. `resolutionRoot` is a non-empty path string or local `file:` URL. Relative strings resolve against the constructor call's host working directory. Operations reject a missing or non-directory root. The root controls workspace placement, ambient package ancestry, checking, and runtime ESM resolution; it is not the guest working directory.
- `executor.getInstructions(): string` — synchronously returns deterministic Markdown describing only how to use `listModules` and `execute`, including inspection of package files and the selected executor's execution contract. It performs no filesystem or module operation and embeds no catalog state or harness API instructions.
- `executor.modules.register(module): void` — adds one exact package specifier and rejects duplicates, invalid package names, missing or non-absolute discovery roots, or missing materializers. Registry changes affect only later snapshots. Host-module dispatch capabilities survive metadata capture; registering a disposing/disposed host module rejects.
- `executor.modules.snapshot(): readonly Module[]` — returns a frozen ordered copy whose membership and discovery metadata cannot be altered by later registration. Module-owned external state remains outside this immutability guarantee. Checks and executions acquire leases on captured host modules synchronously before awaiting anything; disposing modules reject new operations. Existing leases remain valid until run cleanup completes.
- `executor.check({ source }): Promise<CheckResult>` — checks one `main.ts` with strict ES2022, Node-only, no-emit NodeNext settings and returns stable, one-based diagnostics.
- `ExecutorOptions` — `{ readonly resolutionRoot: string | URL }`, shared by both constructors.
- `TypeCheckError` — thrown by either checked execution when `check` returns errors; exposes the immutable diagnostics array.
- `ModuleSummary` — `{ readonly specifier: string; readonly packageRoot: string; readonly description?: string }`. Discovery roots belong to the module and remain readable between operations during its lifetime; they are not temporary executor workspaces. `hostModule.dispose()` ends that lifetime, and listing an executor containing a closing host module rejects.

Both `execute` methods require `cwd` as an absolute native path string or query- and fragment-free local `file:` URL naming an existing directory. Both check by default and skip checking only when `check === false`.

### Cancellation and output limits (both flavors)

- `ExecutionControl` — optional request fields shared by both flavors: `signal?: AbortSignal`, `timeoutMs?: number` (positive integer; wall-clock from the `execute` call, covering checking; omitted means no deadline), `maxOutputBytes?: number` (positive integer; bytes retained per stream; default `DEFAULT_MAX_OUTPUT_BYTES` = 4 MiB), `killGraceMs?: number` (positive integer; default `DEFAULT_KILL_GRACE_MS` = 2000), `killGroupOnExit?: boolean` (default false), and `env?: Readonly<Record<string, string>>`. Invalid values reject synchronously with `TypeError` before any lease, workspace, or check.
- `env` semantics — extra variables for one guest, merged over the inherited environment between `process.env` and the executor's own variables, so a name may shadow an inherited value but never `RESERVED_ENVIRONMENT_NAMES` (`TSX_TSCONFIG_PATH` and the private restore variable); naming one throws. The host's `process.env` is never mutated, so concurrent executions are independent and nothing persists into a later run. Names must be non-empty without `=` or NUL; values strings without NUL. An empty object resolves to no additions. See [Decision 0007](../../decisions/0007-per-execution-environment.md).
- Abort semantics — an already-aborted signal or an already-passed deadline rejects with `ExecutionAbortedError` before checking, and again immediately before spawning (checking is synchronous and cannot be interrupted). During execution the signal or the deadline timer sends SIGTERM to the guest's process group, SIGKILL after `killGraceMs`, waits for the direct child's exit, removes the workspace, releases host-module leases, and rejects. A normal completion terminates descendants only when `killGroupOnExit` is set: after the direct child exits and its output is captured, the host SIGKILLs the remainder of the group (best effort, `ESRCH` ignored) before workspace cleanup. Left at its default, descendants survive the execution.
- `ExecutionAbortedError` — `reason: "signal" | "timeout"`, `stdout`, `stderr`, `truncated`, `exitCode`, `signal`, `durationMs`. Exported for both flavors. Effects the guest already had are not rolled back.
- `OutputTruncation` — `{ stdout: boolean; stderr: boolean }`. Bytes beyond `maxOutputBytes` are read and discarded (the guest never blocks on a full pipe); the retained prefix ends at a byte boundary and is decoded as UTF-8.
- `getInstructions(options?: InstructionsOptions)` — `{ timeoutMs?, maxOutputBytes?, killGroupOnExit? }` makes the deterministic Markdown state the effective cap (always; the default when omitted), the deadline (only when supplied), and, when `killGroupOnExit` is set, that processes the program starts are killed when it finishes — all in a `## Limits` section, so the model reads the limits the harness enforces.

### JSON function flavor

- `TSFuncExecutor.execute<Input extends JsonValue, Output extends JsonValue>({ source, cwd, input?, check?, ...ExecutionControl }): Promise<TSFuncExecuteResult<Output>>` — calls sync or async `main(input)`. Omitted input still invokes `main(undefined)`. Supplied input and successful values must be strict `JsonValue`. Success returns `{ value, stdout, stderr, truncated, durationMs }`.
- `TSFuncExecuteRequest<Input>` — the request above, including optional JSON input.
- `TSFuncExecuteResult<Output>` — the frozen composite success result above.
- `JsonValue` — `null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }`. Runtime validation additionally requires finite numbers, standard-prototype dense arrays without extra or symbol properties, acyclic data, enumerable data properties, and plain object prototypes. It rejects BigInt, `undefined`, functions, symbols, accessors, hidden properties, unsupported property values, and non-plain objects instead of applying permissive JSON coercions.
- Runtime failures after spawn are `Error` values with enumerable captured `stdout`, `stderr`, and `truncated` properties. Reported guest name, message, and stack are restored when possible. Host-initiated termination is `ExecutionAbortedError` instead.

### Stdout process flavor

- `ProcExecutor.execute({ source, cwd, check?, ...ExecutionControl }): Promise<string>` — calls sync or async `main()` with no arguments. Its resolved value must be exactly `undefined`; every returned value, including `null`, strings, numbers, and objects, is an execution failure. Success is the exact captured stdout string, with no input and no composite result. When stdout exceeded `maxOutputBytes` the exact string no longer exists, so `execute` rejects with `ProcExecutionError` (`truncated.stdout` true, `exitCode` 0) rather than returning a silently incomplete value.
- `ProcExecutor.executeDetailed(request): Promise<ProcExecuteResult>` — same request; returns `{ stdout, truncated, durationMs }` and never rejects merely because output was capped. Successful stderr is still discarded (only its truncation flag is reported).
- `ProcExecuteRequest` — contains `source`, `cwd`, optional `check`, and the `ExecutionControl` fields.
- `ProcExecutionError` — every failure classified after the Proc subprocess starts is this exported `Error` subclass, constructed from a `CapturedTermination` details object. It carries `stdout: string`, `stderr: string`, `truncated: OutputTruncation`, `exitCode: number | null`, and `signal: NodeJS.Signals | null`. A reported guest error supplies useful standard `name`, `message`, and `stack` while preserving `instanceof ProcExecutionError`. Pre-spawn validation/materialization/check failures retain their specific error types; host-initiated termination is `ExecutionAbortedError`.
- Successful stderr rule — stderr is captured to preserve failure diagnostics. On success it is intentionally discarded, is not returned, and is never merged into stdout.

## Consumed APIs

- [Package materialization and host-module lifecycle](../modules/index.md#provided-apis) — builds the physical package graph for a registry snapshot and keeps generated packages alive through operation leases. Arbitrary custom materializers retain per-operation semantics; only generated host artifacts are reused.
- [Fresh subprocess execution](../runtime/index.md#provided-apis) — supplies neutral process capture plus separate TSFunc and Proc protocols.
- [Host-subprocess execution boundary](../../boundaries/host-subprocess-execution.md) — constrains file modes, arguments, flavor envelopes, output, errors, and lifecycle.
- [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) — performs NodeNext resolution and diagnostics.

## Workflows

### Prepare an agent and inspect modules

1. The harness adds `getInstructions()` to the agent prompt and exposes `listModules` and `execute` as tools.
2. `listModules` freezes the registry view and filters metadata, including absolute package roots, without materializing packages.
3. The model uses filesystem access to read `package.json` at a returned root and follow package `types` and `exports` to relevant declarations and referenced files.
4. The model submits TypeScript to `execute`, which checks by default, and repairs any reported diagnostics before retrying.

### Check or execute source

1. The core validates the `ExecutionControl` fields, starts the deadline clock, and rejects a pre-aborted signal or an already-elapsed deadline with `ExecutionAbortedError` before doing anything else. It then captures a registry snapshot and synchronously acquires its host-module leases. TSFunc also strictly validates and encodes optional input before asynchronous work. Failure at any stage releases every acquired lease.
2. For execution, the core validates and normalizes required `cwd` independently from `resolutionRoot`.
3. It materializes every package into a new run workspace below `resolutionRoot/.ts-executor/runs/` and writes common source/configuration/package files. Each run has its own node_modules links to the captured roots, including unchanged generated host packages. If parallel initialization fails, every sibling filesystem operation settles before cleanup begins.
4. The core runs strict NodeNext diagnostics. Execution proceeds unless diagnostics fail or `check === false`. The signal and deadline are re-checked once more before spawning, because checking cannot be interrupted.
5. The flavor runner creates only its needed private paths/files and calls the neutral spawn primitive with its own compiled bootstrap and the resolved control. The guest starts in its own process group; its stdout/stderr pipes are drained into buffers capped at `maxOutputBytes`. If the captured graph includes host modules, an execution-scoped IPC channel dispatches validated calls to those captured handlers; otherwise no IPC channel is opened. An abort or deadline during execution terminates the group and the primitive reports the reason; with `killGroupOnExit` a normal exit also ends the group once output is captured.
6. The flavor interpreter returns a JSON composite or stdout string, or reconstructs the contract-specific runtime error.
7. A `finally` path removes the complete operation directory, then releases module leases. Shared artifacts are not deleted by run cleanup. If cleanup also fails during a primary operation failure, the primary failure is preserved with best-effort `cleanupError` metadata. A post-spawn IPC error does not shorten direct-child ownership: cleanup still waits for child exit.

## Execution-context Constraints

`resolutionRoot` determines ambient package authority and resolution; `cwd` only determines subprocess-relative behavior. The registry is not an access-control list. The subprocess receives the inherited environment after bootstrap restoration and has normal filesystem, network, built-in-module, and subprocess authority. The executor owns its operation workspace and direct child; it terminates the child's process group on abort or timeout, and after a normal exit only when `killGroupOnExit` is set (POSIX; on Windows only the direct child is killed), bounds retained output, and provides no other resource limits and no security boundary.
