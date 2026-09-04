# TypeScript Executor

> Two focused Node executors strictly check and run single-file TypeScript programs against declaration-bearing packages in fresh subprocesses.

## Overview

TypeScript Executor exposes `TSFuncExecutor` for strict-JSON function calls and `ProcExecutor` for stdout-oriented processes. Both compose the same internal catalog/check/workspace core, capture immutable registry snapshots, use one physical package graph with NodeNext resolution, require an independent absolute execution `cwd`, and create a fresh Node subprocess for every execution.

`TSFuncExecutor` calls `main(input)` and returns `{ value, stdout, stderr, durationMs }`. `ProcExecutor` calls no-argument `main()`, requires it to resolve to exactly `undefined`, and returns exact stdout. Proc stderr is captured for failures but intentionally discarded on success; it is never merged into stdout.

Minimal v1 deliberately provides no security sandbox. It also excludes custom loaders, alternate runtime backends, source modules, package installation, persistent language services, custom disk caches, cancellation or timeouts, environment filtering, multi-file user programs, parent callbacks, process pools, and process-tree management.

## Sub-documents

- [Architecture](architecture.md) — Two public flavors compose one catalog/check/workspace core and one neutral subprocess primitive over a shared physical package graph.
- [Executor component](components/executor/index.md) — `TSFuncExecutor` and `ProcExecutor` compose shared catalog, checking, workspace, cwd, and cleanup orchestration while enforcing separate execution contracts.
- [Modules component](components/modules/index.md) — Modules expose existing declaration-bearing packages through ordinary ESM imports.
- [Runtime component](components/runtime/index.md) — A neutral spawn primitive supports separate JSON-function and stdout-process bootstraps and host-side interpreters.
- [Host-subprocess execution boundary](boundaries/host-subprocess-execution.md) — Common process lifecycle and regular-file output capture carry separate private TSFunc result and Proc status protocols.
- [Decision 0001: Package-native general RPC](decisions/0001-package-native-general-rpc.md) — Historical decision establishing ordinary declaration-bearing packages for general network clients; its special-adapter conclusion is superseded by Decision 0002.
- [Decision 0002: Subprocess JSON execution](decisions/0002-subprocess-json-execution.md) — Historical decision establishing the strict-JSON subprocess contract, physical files, independent cwd, and no parent callback channel.
- [Decision 0003: Composed executor flavors](decisions/0003-composed-executor-flavors.md) — Distinct JSON-function and stdout-process APIs share internal orchestration and a neutral spawn primitive without a public mode abstraction.

The `plans/` and `experiment_journal/` directories are managed by the project workflow.
