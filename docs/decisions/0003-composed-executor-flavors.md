# 0003: Composed Executor Flavors

> Distinct JSON-function and stdout-process APIs share internal orchestration and a neutral spawn primitive without a public mode abstraction.

## Status

Superseded by [Decision 0008](0008-one-executor-callers-own-limits-host-modules-carry-declarations.md) (2026-09-24). `ProcExecutor` and the internal `ExecutorCore` are removed; `TSFuncExecutor` is the only executor.

## Context

Decision 0002 established a plain subprocess, strict JSON files, physical package graph, independent `resolutionRoot` and `cwd`, and deterministic direct-child completion. That contract is appropriate for calls that exchange JSON, but process-style programs often define success entirely as stdout. Returning a composite JSON execution object for those programs exposes irrelevant input/value concepts and makes stdout consumers unpack a mode they did not request.

The catalog, declaration traversal, strict checking, package materialization, cwd validation, workspace cleanup, spawn lifecycle, and output capture are identical. The guest invocation and successful result contract are not. Combining both behind a public mode flag would make request/result types conditional and expose an extensibility abstraction the package does not need.

## Decision

Replace the prior public executor with two final public classes:

- `TSFuncExecutor` accepts optional strict `JsonValue` input, invokes sync or async `main(input)`, requires a strict `JsonValue` result, and returns `{ value, stdout, stderr, durationMs }`.
- `ProcExecutor` accepts no input, invokes sync or async `main()` with no arguments, requires the resolved value to be exactly `undefined`, and returns exact captured stdout as `Promise<string>`.

Both classes own an internal `ExecutorCore` by composition. The core owns module registration/snapshots, `listModules`, `getTypes`, `check`, common workspace construction, required-cwd validation, pre-execution checking, and cleanup. There is no public base class and no public plugin/contract abstraction.

Use one neutral internal subprocess primitive that chooses no result semantics. It starts and reaps a fresh Node child, captures regular-file stdout/stderr, and returns exit code, signal, and both streams. Separate compiled bootstrap entrypoints and host interpreters own TSFunc input/result envelopes and Proc status/error envelopes.

The common workspace contains source, TypeScript configuration, package metadata, and the physical package graph. TSFunc creates its private input/result paths; Proc creates only private status paths. Proc success output never enters its status envelope.

Export `ProcExecutionError` for Proc failures classified after subprocess startup. It carries `stdout`, `stderr`, `exitCode`, and `signal`; serialized guest failures preserve useful name, message, and stack on the error instance. On successful Proc execution, captured stderr is deliberately discarded and never merged into stdout.

Remove `NodeTypeScriptExecutor` and its type names entirely. No compatibility alias or facade is provided.

## Relationship to Prior Decisions

The later [Decision 0004](0004-model-discovery-and-execution.md) supersedes this decision's declaration-retrieval API: discovery returns stable package paths, and the model-facing surface is `listModules` and `execute`.

Decision 0002 remains the historical basis for subprocess lifecycle, strict JSON behavior in the TSFunc flavor, independent cwd/resolution roots, regular-file capture, physical packages, and removal of parent callbacks. This decision supersedes only its assumption of one public JSON execution flavor and one compiled bootstrap.

Decision 0001 remains historical. Its package-native conclusion continues to apply equally to both flavors; its specialized bridge was already superseded by Decision 0002.

## Alternatives Considered

- Add `mode: "json" | "proc"` to one executor — rejected because it creates conditional request/result contracts and makes each caller carry the other flavor's concepts.
- Add a public execution-contract plugin interface — rejected because exactly two fixed contracts are required and public extensibility would expose bootstrap/protocol internals.
- Derive both classes from a public or protected base — rejected because inheritance would turn orchestration internals into subclass surface. Composition keeps the shared core private.
- Return `{ stdout, stderr }` from Proc — rejected because the process flavor's successful value is specifically stdout. Stderr remains useful only for failure diagnostics.
- Merge stderr into successful stdout — rejected because inter-stream ordering is not represented by separate files and merging would corrupt exact stdout.
- Allow Proc to ignore returned values — rejected because accidental returns usually indicate use of the wrong flavor or a broken guest contract.

## Consequences

- Call sites choose a type-safe contract at construction and receive an unconditional result type.
- Module discovery, strict checking, NodeNext resolution, physical packages, process freshness, cwd behavior, output mechanics, and cleanup cannot drift between flavors because their orchestration and spawn primitive are shared.
- Flavor bootstraps and envelope interpreters can evolve independently without public mode flags.
- Proc callers receive exact stdout on success and structured process diagnostics on failure, but successful stderr is unavailable by design.
- The breaking rename is reflected as a pre-1.0 minor version increase with no deprecated alias.
