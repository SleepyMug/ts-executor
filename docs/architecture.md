# Architecture

> Two public execution flavors compose one catalog/check/workspace core and one neutral subprocess primitive over a shared physical package graph.

## Overview

`TSFuncExecutor` and `ProcExecutor` each own a small internal `ExecutorCore` by composition; there is no public or internal executor base class. The core owns the module registry and coordinates immutable operation snapshots, module listing, declaration retrieval, strict checking, cwd validation, common workspace preparation, and cleanup. Public flavor classes delegate those shared operations and supply only their execution-specific preparation and interpretation.

A common workspace below `resolutionRoot` contains `main.ts`, `tsconfig.json`, package metadata, module materialization space, and the physical `node_modules` graph. Declaration retrieval resolves a package entry or exported subpath with TypeScript's NodeNext resolver and traverses transitive package-owned declaration files. Checking uses strict ES2022, Node-only NodeNext options against the same graph.

Execution opens private regular stdout/stderr files and calls one neutral primitive that spawns `process.execPath` with the executor-owned `tsx` preload, a selected compiled bootstrap, and absolute operation paths. The primitive returns exit code, signal, stdout, and stderr without interpreting flavor status. Separate host runners and compiled bootstraps implement the two contracts:

- `TSFuncExecutor` writes a strict-JSON input envelope, calls `main(input)`, validates a strict-JSON value, and interprets a private result envelope.
- `ProcExecutor` calls `main()` with no arguments, requires its resolved value to be exactly `undefined`, and interprets a private status/error envelope. Its successful value is only exact captured stdout.

Both bootstraps flush direct-child output, atomically publish their flavor envelope, invoke a captured exit capability, and leave cleanup to the core. A registry mutation after an operation starts cannot alter that operation's membership or captured metadata. Each execution has a fresh process, heap, module cache, and package-singleton state.

## Dependency Direction

```text
TSFuncExecutor ─┐
                ├─> ExecutorCore ─> registry/materializers ─> physical package graph
ProcExecutor ───┘        ├───────> TypeScript NodeNext resolver/compiler
                         └───────> common workspace lifecycle

TSFuncExecutor ─> TSFunc host runner ─┐
                                     ├─> neutral spawn primitive ─> fresh Node subprocess
ProcExecutor ───> Proc host runner ───┘          ├─> TSFunc bootstrap/result protocol
                                                 └─> Proc bootstrap/status protocol
```

The registry supports discovery and workspace materialization; it is not an import allowlist. Built-ins and ambient packages reachable from the workspace remain available. Network protocols require no executor-specific integration: registered declaration-bearing client packages establish their own connections in each subprocess.

## Resolution and Working-directory Split

`resolutionRoot` determines operation workspace placement and ambient package ancestry. Required `execute.cwd` determines only subprocess-relative behavior such as `process.cwd()`, relative filesystem paths, `process.chdir()`, and guest-created subprocess defaults. The absolute generated `main.ts` remains below `resolutionRoot`, so changing `cwd` does not change checking or ESM package lookup.

Resolution follows ordinary NodeNext behavior:

1. Packages linked into the operation's `node_modules`.
2. Ambient dependencies found through `resolutionRoot/node_modules` ancestry.
3. Dependencies of a linked package found from that package's real location and ancestry.

## v1 Scope

Programs are one source string exporting synchronous or asynchronous `main`. They run with the host Node process's normal authority: this is a lifecycle boundary, not a security boundary. JSON data is exclusive to the `TSFuncExecutor` input/value contract; `ProcExecutor` has no input or returned program value. v1 has one subprocess mechanism with two fixed bootstraps and no public mode flag, plugin/contract abstraction, custom loader, VM backend, package installer, source-module abstraction, host callback channel, timeout, cancellation, environment filtering, process pool, descendant manager, runtime package allowlist, or multi-file user program.

## Sub-documents

- [Executor component](components/executor/index.md) — `TSFuncExecutor` and `ProcExecutor` compose shared catalog, checking, workspace, cwd, and cleanup orchestration while enforcing separate execution contracts.
- [Modules component](components/modules/index.md) — Modules expose existing declaration-bearing packages through ordinary ESM imports.
- [Runtime component](components/runtime/index.md) — A neutral spawn primitive supports separate JSON-function and stdout-process bootstraps and host-side interpreters.
- [Host-subprocess execution boundary](boundaries/host-subprocess-execution.md) — Common process lifecycle and regular-file output capture carry separate private TSFunc result and Proc status protocols.
