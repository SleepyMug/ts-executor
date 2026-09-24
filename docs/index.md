# TypeScript Executor

> One Node executor provides agent-facing usage guidance and strictly checks and runs single-file TypeScript functions against declaration-bearing packages and host-backed modules in fresh subprocesses; callers own deadlines and output limits.

## Overview

TypeScript Executor exposes `TSFuncExecutor`, which calls `main(input)` with strict-JSON input and returns `{ value, durationMs }`. It returns fixed agent usage instructions, captures immutable registry snapshots, uses one physical package graph with NodeNext resolution, requires an independent absolute execution `cwd`, and creates a fresh Node subprocess for every execution.

The model uses two tools: `listModules` returns stable absolute package roots for filesystem inspection of interfaces, and `execute` checks and runs TypeScript. The harness uses `getInstructions`, module registration, and the standalone `check` API.

The executor keeps no output. stdout and stderr go as UTF-8 text to optional `onStdout`/`onStderr` sinks; a stream without a sink is not piped. A stdout-style program is a function that prints and returns nothing, which resolves to `null`. Limits belong to the caller: aborting its `AbortSignal` closes the host-call channel, terminates the guest process group, and rejects with `ExecutionAbortedError`; a deadline is `AbortSignal.timeout`; how much output to keep is the sink's business. After every exit the rest of the guest's process group is killed.

The caller and its host-module `call` functions are trusted; the program is untrusted for correctness (its data is validated, its failures reported) but not contained. The executor has no budgets, caps, or rate limits, and no mechanisms that exist only to survive a hostile program: resource use is for the caller and the environment to limit and monitor.

Minimal v1 deliberately provides no security sandbox. It also excludes custom loaders, alternate runtime backends, source modules, package installation, persistent language services, cross-restart disk caches, environment filtering (a request may *add* variables for its own guest but never remove inherited ones), multi-file user programs, and process pools.

`hostModule` generates a package once from caller-supplied declarations, function names, and one `call` function, for reuse across discovery, checks, and fresh executions. Arguments and results cross as strict JSON; there is no schema validation. Artifacts live under `.ts-executor/modules/` until explicit module disposal; operation files live under `.ts-executor/runs/` and are cleaned after each operation. Host calls retain host state and use an execution-scoped JSON IPC channel; host effects are not transactional.

## Sub-documents

- [Architecture](architecture.md) — One executor composes agent guidance, catalog, checking, workspaces, and a single subprocess runner over a shared physical package graph.
- [Executor component](components/executor/index.md) — `TSFuncExecutor` provides agent guidance and orchestrates catalog, checking, workspace, cwd, control validation, and cleanup around the JSON function contract.
- [Modules component](components/modules/index.md) — Modules expose existing packages, or reusable generated packages whose functions forward JSON arguments to a host `call` function, through ordinary ESM imports.
- [Runtime component](components/runtime/index.md) — A subprocess primitive streams output to caller sinks, closes the host-call bridge and terminates the process group on abort, reaps it after exit, and carries the JSON function bootstrap and host-call bridge.
- [Host-subprocess execution boundary](boundaries/host-subprocess-execution.md) — Process lifecycle, sink-delivered output, the private TSFunc result protocol, and the host-call protocol.
- [Decision 0001: Package-native general RPC](decisions/0001-package-native-general-rpc.md) — Historical decision establishing ordinary declaration-bearing packages for general network clients; its special-adapter conclusion is superseded by Decision 0002.
- [Decision 0002: Subprocess JSON execution](decisions/0002-subprocess-json-execution.md) — Historical decision establishing the strict-JSON subprocess contract, physical files, independent cwd, and no parent callback channel.
- [Decision 0003: Composed executor flavors](decisions/0003-composed-executor-flavors.md) — Superseded by Decision 0008. Distinct JSON-function and stdout-process APIs shared internal orchestration and a neutral spawn primitive.
- [Decision 0004: Model discovery and execution](decisions/0004-model-discovery-and-execution.md) — Two model tools provide package paths and TypeScript execution; harness helpers stay outside the model instructions.
- [Decision 0005: Reusable host-backed modules](decisions/0005-reusable-host-backed-modules.md) — Host functions use reusable physical packages and execution-scoped IPC without reusing child state; its schema-backed contract is superseded by Decision 0008.
- [Decision 0006: Cancellation and bounded output](decisions/0006-cancellation-and-bounded-output.md) — Superseded by Decision 0008. Executions accepted a signal, a deadline, and a per-stream retention cap.
- [Decision 0007: Per-execution environment](decisions/0007-per-execution-environment.md) — A request may add environment variables for its own guest without touching the host's `process.env`.
- [Decision 0008: One executor, caller-owned limits, declaration-carrying host modules](decisions/0008-one-executor-callers-own-limits-host-modules-carry-declarations.md) — The Proc flavor, built-in deadlines and output caps, and schema-backed host functions are removed; the host is trusted and the program is not contained; callers abort a signal, consume output through sinks, and supply host-module declarations and a `call` function.

The `plans/` and `experiment_journal/` directories are managed by the project workflow.
