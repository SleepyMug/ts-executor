# Architecture

> Two public execution flavors compose shared agent guidance and one catalog/check/workspace core with a neutral subprocess primitive over a shared physical package graph.

## Overview

`TSFuncExecutor` and `ProcExecutor` each own a small internal `ExecutorCore` by composition; there is no public or internal executor base class. The core owns the module registry and coordinates immutable operation snapshots, deterministic agent-instruction assembly, module listing, strict checking, cwd validation, common workspace preparation, and cleanup. Public flavor classes delegate those shared operations and supply only their execution-specific preparation and interpretation. The model-facing surface is `listModules` and `execute`; harness code uses registration, `check`, and `getInstructions`. Agent instructions describe only discovery and execution with the selected executor's contract.

`listModules` returns captured metadata with a stable absolute `packageRoot` for each package. The model reads `package.json` and declarations through filesystem access supplied by the harness. Discovery performs no materialization or declaration traversal. Each operation gets a workspace at `resolutionRoot/.ts-executor/runs/run-<unique>/` containing `main.ts`, `tsconfig.json`, package metadata, module materialization space, and its own physical `node_modules` graph. Host-module artifacts are generated once below their chosen `resolutionRoot/.ts-executor/modules/` and linked into runs; shared scaffolding remains after run cleanup. Checking uses strict ES2022, Node-only NodeNext options against the same graph.

Execution calls one neutral primitive that spawns `process.execPath` in its own process group with the executor-owned `tsx` preload, a selected compiled bootstrap, and absolute operation paths, draining stdout and stderr pipes into buffers bounded by `maxOutputBytes`. The primitive returns exit code, signal, both captured streams with truncation flags, and whether the host terminated the group on abort or deadline, without interpreting flavor status. Separate host runners and compiled bootstraps implement the two contracts:

- `TSFuncExecutor` writes a strict-JSON input envelope, calls `main(input)`, validates a strict-JSON value, and interprets a private result envelope.
- `ProcExecutor` calls `main()` with no arguments, requires its resolved value to be exactly `undefined`, and interprets a private status/error envelope. Its successful value is only exact captured stdout.

Both bootstraps flush direct-child output, atomically publish their flavor envelope, invoke a captured exit capability, and leave cleanup to the core. A registry mutation after an operation starts cannot alter that operation's membership, captured metadata, or host dispatch table. Host-module leases are acquired synchronously with the snapshot and released only after operation cleanup. Each execution has a fresh process, heap, module cache, and child package-singleton state; host callbacks retain host-owned state.

## Dependency Direction

```text
TSFuncExecutor ─┐
                ├─> ExecutorCore ─> agent-instruction segments
ProcExecutor ───┘        ├───────> registry/materializers ─> physical package graph
                         ├───────> TypeScript NodeNext resolver/compiler
                         └───────> common workspace lifecycle

TSFuncExecutor ─> TSFunc host runner ─┐
                                     ├─> neutral spawn primitive ─> fresh Node subprocess
ProcExecutor ───> Proc host runner ───┘          ├─> TSFunc bootstrap/result protocol
                                                 └─> Proc bootstrap/status protocol
```

The registry supports discovery and workspace materialization; it is not an import allowlist. Built-ins and ambient packages reachable from the workspace remain available. Network clients still require no executor-specific integration: registered declaration-bearing client packages establish their own connections in each subprocess. For live host-owned capabilities, `hostFunction` captures TypeBox schemas and handlers; `hostModule` generates declarations and proxies once. When a snapshot includes host modules, the spawn primitive attaches one JSON-text IPC channel, dispatching only captured module identities and methods. Both bootstraps initialize the same compiled guest client before guest import. Completion disconnects the bridge before the existing output flush and terminal publication. Calls may run concurrently; disconnect aborts a cooperative host signal but never waits for arbitrary host work or retries effects.

## Resolution and Working-directory Split

`resolutionRoot` determines operation workspace placement and ambient package ancestry. Required `execute.cwd` determines only subprocess-relative behavior such as `process.cwd()`, relative filesystem paths, `process.chdir()`, and guest-created subprocess defaults. The absolute generated `main.ts` remains below `resolutionRoot`, so changing `cwd` does not change checking or ESM package lookup. Strict checking explicitly retains the original resolutionRoot's ambient Node type directory despite the deeper run layout.

Resolution follows ordinary NodeNext behavior:

1. Packages linked into the operation's `node_modules`.
2. Ambient dependencies found through `resolutionRoot/node_modules` ancestry.
3. Dependencies of a linked package found from that package's real location and ancestry.

## v1 Scope

Programs are one source string exporting synchronous or asynchronous `main`. They run with the host Node process's normal authority: this is a lifecycle boundary, not a security boundary. Top-level JSON input/value belongs to `TSFuncExecutor`; `ProcExecutor` has no input or returned program value. Host-call arguments/results use strict JSON in both flavors. There is one subprocess mechanism with two fixed bootstraps and an optional host-call bridge. Executions accept an `AbortSignal`, a wall-clock `timeoutMs`, and a per-stream `maxOutputBytes` cap; abort or deadline terminates the guest process group (SIGTERM, then SIGKILL after `killGraceMs`) and rejects with `ExecutionAbortedError` ([Decision 0006](decisions/0006-cancellation-and-bounded-output.md)). Output is captured through pipes into bounded buffers; the host waits only for direct-child exit. Executions may also add per-guest environment variables ([Decision 0007](decisions/0007-per-execution-environment.md)). There is no public mode flag, execution-plugin abstraction, custom loader, VM backend, package installer, source-module abstraction, environment *filtering*, process pool, descendant manager beyond group termination on abort, runtime package allowlist, multi-file user program, or cross-restart disk cache. Host-call AbortSignal notification is cooperative and separate from execution cancellation.

## Sub-documents

- [Executor component](components/executor/index.md) — `TSFuncExecutor` and `ProcExecutor` provide agent guidance and compose shared catalog, checking, workspace, cwd, and cleanup orchestration while enforcing separate execution contracts.
- [Modules component](components/modules/index.md) — Modules expose existing packages or reusable generated packages backed by host-owned functions through ordinary ESM imports.
- [Host functions component](components/host-functions/index.md) — Immutable TypeBox contracts supply inferred host handlers, strict JSON validation, and generated asynchronous guest declarations.
- [Runtime component](components/runtime/index.md) — A neutral spawn primitive supports separate JSON-function and stdout-process bootstraps and host-side interpreters.
- [Host-subprocess execution boundary](boundaries/host-subprocess-execution.md) — Common process lifecycle and regular-file output capture carry separate private TSFunc result and Proc status protocols.
