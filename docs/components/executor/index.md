# Executor Component

> `TSFuncExecutor` and `ProcExecutor` provide agent guidance and compose shared catalog, checking, workspace, cwd, and cleanup orchestration while enforcing separate execution contracts.

## Overview

Each public executor owns an internal `ExecutorCore`; neither inherits from a public base class. The core owns a mutable module registry, but registration captures fixed discovery metadata and every catalog, checking, or execution operation captures a frozen ordered snapshot before asynchronous work begins. It also holds deterministic agent guidance assembled from shared text segments and one flavor-specific segment. Common workspaces are private directories below `resolutionRoot` and are removed when an operation settles. Execution requires an independent absolute working directory.

## Provided APIs

### Model-facing tools

- `executor.listModules({ query? }?): Promise<readonly ModuleSummary[]>` — lists the current snapshot in registration order, optionally filtering case-insensitively across specifier and description. Each entry contains `{ specifier, packageRoot, description? }`, with an absolute package directory for inspecting `package.json` and interface declarations. It returns no declaration contents and performs no filesystem work or materialization.
- `executor.execute(...)` — runs a single TypeScript program, checking it by default. The selected executor defines the input/output contract below.

The harness exposes these two methods as tools and supplies filesystem access for exploring the returned package roots.

The [harness adapter example](../../../examples/harness-adapter.mjs) supplies JSON input schemas, argument validation, and model-visible error responses. It accepts string-only absolute `cwd`, fixes pre-execution checking on, preserves TSFunc input omission, and forwards diagnostics and captured runtime output. [The runnable flow](../../../examples/05-agent-harness.mjs) demonstrates discovery, file inspection, a failed check, and corrected execution. These are harness examples, not additional executor APIs.

### Harness API and shared types

- `new TSFuncExecutor({ resolutionRoot })` and `new ProcExecutor({ resolutionRoot })` — create separate executors. `resolutionRoot` is a non-empty path string or local `file:` URL. Relative strings resolve against the constructor call's host working directory. Operations reject a missing or non-directory root. The root controls workspace placement, ambient package ancestry, checking, and runtime ESM resolution; it is not the guest working directory.
- `executor.getInstructions(): string` — synchronously returns deterministic Markdown describing only how to use `listModules` and `execute`, including inspection of package files and the selected executor's execution contract. It performs no filesystem or module operation and embeds no catalog state or harness API instructions.
- `executor.modules.register(module): void` — adds one exact package specifier and rejects duplicates, invalid package names, missing or non-absolute discovery roots, or missing materializers. Registry changes affect only later snapshots.
- `executor.modules.snapshot(): readonly Module[]` — returns a frozen ordered copy whose membership and discovery metadata cannot be altered by later registration. Module-owned external state remains outside this immutability guarantee.
- `executor.check({ source }): Promise<CheckResult>` — checks one `main.ts` with strict ES2022, Node-only, no-emit NodeNext settings and returns stable, one-based diagnostics.
- `ExecutorOptions` — `{ readonly resolutionRoot: string | URL }`, shared by both constructors.
- `TypeCheckError` — thrown by either checked execution when `check` returns errors; exposes the immutable diagnostics array.
- `ModuleSummary` — `{ readonly specifier: string; readonly packageRoot: string; readonly description?: string }`. Discovery roots belong to the module and remain readable between operations; they are not temporary executor workspaces.

Both `execute` methods require `cwd` as an absolute native path string or query- and fragment-free local `file:` URL naming an existing directory. Both check by default and skip checking only when `check === false`.

### JSON function flavor

- `TSFuncExecutor.execute<Input extends JsonValue, Output extends JsonValue>({ source, cwd, input?, check? }): Promise<TSFuncExecuteResult<Output>>` — calls sync or async `main(input)`. Omitted input still invokes `main(undefined)`. Supplied input and successful values must be strict `JsonValue`. Success returns `{ value, stdout, stderr, durationMs }`.
- `TSFuncExecuteRequest<Input>` — the request above, including optional JSON input.
- `TSFuncExecuteResult<Output>` — the frozen composite success result above.
- `JsonValue` — `null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }`. Runtime validation additionally requires finite numbers, standard-prototype dense arrays without extra or symbol properties, acyclic data, enumerable data properties, and plain object prototypes. It rejects BigInt, `undefined`, functions, symbols, accessors, hidden properties, unsupported property values, and non-plain objects instead of applying permissive JSON coercions.
- Runtime failures after spawn are `Error` values with enumerable captured `stdout` and `stderr` strings. Reported guest name, message, and stack are restored when possible.

### Stdout process flavor

- `ProcExecutor.execute({ source, cwd, check? }): Promise<string>` — calls sync or async `main()` with no arguments. Its resolved value must be exactly `undefined`; every returned value, including `null`, strings, numbers, and objects, is an execution failure. Success is the exact captured stdout string, with no input and no composite result.
- `ProcExecuteRequest` — contains only `source`, `cwd`, and optional `check`.
- `ProcExecutionError` — every failure classified after the Proc subprocess starts is this exported `Error` subclass. It carries `stdout: string`, `stderr: string`, `exitCode: number | null`, and `signal: NodeJS.Signals | null`. A reported guest error supplies useful standard `name`, `message`, and `stack` while preserving `instanceof ProcExecutionError`. Pre-spawn validation/materialization/check failures retain their specific error types.
- Successful stderr rule — stderr is captured to preserve failure diagnostics. On success it is intentionally discarded, is not returned, and is never merged into stdout.

## Consumed APIs

- [Package materialization](../modules/index.md#provided-apis) — builds the physical package graph for a registry snapshot.
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

1. The core captures a registry snapshot. TSFunc also strictly validates and encodes optional input before asynchronous work.
2. For execution, the core validates and normalizes required `cwd` independently from `resolutionRoot`.
3. It materializes every package into a common workspace below `resolutionRoot` and writes common source/configuration/package files. If parallel initialization fails, every sibling filesystem operation settles before cleanup begins.
4. The core runs strict NodeNext diagnostics. Execution proceeds unless diagnostics fail or `check === false`.
5. The flavor runner creates only its needed private paths/files and calls the neutral spawn primitive with its own compiled bootstrap.
6. The flavor interpreter returns a JSON composite or stdout string, or reconstructs the contract-specific runtime error.
7. A `finally` path removes the complete operation directory. If cleanup also fails during a primary operation failure, the primary failure is preserved with best-effort `cleanupError` metadata.

## Execution-context Constraints

`resolutionRoot` determines ambient package authority and resolution; `cwd` only determines subprocess-relative behavior. The registry is not an access-control list. The subprocess receives the inherited environment after bootstrap restoration and has normal filesystem, network, built-in-module, and subprocess authority. The executor owns only its operation workspace and direct child, and provides neither resource limits nor a security boundary.
