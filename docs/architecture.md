# Architecture

> One executor composes agent guidance, catalog, checking, workspaces, and a single subprocess runner over a shared physical package graph.

## Overview

`TSFuncExecutor` is the only executor. It owns the module registry and coordinates immutable operation snapshots, fixed agent instructions, module listing, strict checking, control and cwd validation, workspace preparation, execution, and cleanup. The model-facing surface is `listModules` and `execute`; harness code uses registration, `check`, and `getInstructions`. Agent instructions describe only discovery and execution and state no limits.

`listModules` returns captured metadata with a stable absolute `packageRoot` for each package. The model reads `package.json` and declarations through filesystem access supplied by the harness. Discovery performs no materialization or declaration traversal. Each operation gets a workspace at `resolutionRoot/.ts-executor/runs/run-<unique>/` containing `main.ts`, `tsconfig.json`, package metadata, module materialization space, and its own physical `node_modules` graph. Host-module artifacts are generated once below their chosen `resolutionRoot/.ts-executor/modules/` and linked into runs; shared scaffolding remains after run cleanup. Checking uses strict ES2022, Node-only NodeNext options against the same graph, synchronously in the caller's process.

Execution writes a strict-JSON input envelope and calls one subprocess primitive that spawns `process.execPath` in its own process group with the executor-owned `tsx` preload, the compiled `ts-func-subprocess.js` bootstrap, and absolute operation paths. A signal that aborted before this point (during workspace preparation, checking, or file preparation) starts nothing. stdout and stderr are piped only when the caller supplied `onStdout`/`onStderr`, and are delivered to those sinks as UTF-8 text; nothing is retained. An abort or a throwing sink first closes the host-call bridge, then signals the group; an abort after the child's exit is observed does not count. The primitive returns exit code, signal, whether the caller's signal aborted, and any process or sink error. The TSFunc runner then interprets the private result envelope:

- the bootstrap calls `main(input)`, validates a strict-JSON value or serializes a thrown error, flushes output, atomically publishes the envelope, and invokes a captured exit;
- the runner throws `ExecutionAbortedError` when the caller aborted, otherwise checks status/envelope agreement and returns the value or the deserialized guest error.

A registry mutation after an operation starts cannot alter that operation's membership, captured metadata, or host dispatch table. Host-module leases are acquired synchronously with the snapshot and released only after operation cleanup. Each execution has a fresh process, heap, module cache, and child package-singleton state; host calls retain host-owned state.

## Dependency Direction

```text
TSFuncExecutor ─> agent instructions (fixed text)
       ├───────> control validation (signal, env, sinks)
       ├───────> registry/materializers ─> physical package graph
       ├───────> TypeScript NodeNext resolver/compiler
       ├───────> workspace lifecycle
       └───────> TSFunc runner ─> subprocess primitive ─> fresh Node subprocess
                                        │                  └─> TSFunc bootstrap/result protocol
                                        ├─> output sinks (caller)
                                        └─> host-call bridge ─> hostModule call (caller)
```

The registry supports discovery and workspace materialization; it is not an import allowlist. Built-ins and ambient packages reachable from the workspace remain available. Network clients require no executor-specific integration: registered declaration-bearing client packages establish their own connections in each subprocess. For live host-owned capabilities, `hostModule` writes caller-supplied declarations and generated forwarders once. When a snapshot includes host modules, the primitive attaches one JSON-text IPC channel, dispatching only captured module identities and their listed function names to the caller's `call`. The bootstrap initializes the guest client before guest import. Completion disconnects the bridge before the output flush and terminal publication; an abort or a throwing sink closes it from the host side before the group is signalled. Calls may run concurrently; disconnect aborts a cooperative host signal but never waits for arbitrary host work or retries effects.

## Resolution and Working-directory Split

`resolutionRoot` determines operation workspace placement and ambient package ancestry. Required `execute.cwd` determines only subprocess-relative behavior such as `process.cwd()`, relative filesystem paths, `process.chdir()`, and guest-created subprocess defaults. The absolute generated `main.ts` remains below `resolutionRoot`, so changing `cwd` does not change checking or ESM package lookup. Strict checking explicitly retains the original resolutionRoot's ambient Node type directory despite the deeper run layout.

Resolution follows ordinary NodeNext behavior:

1. Packages linked into the operation's `node_modules`.
2. Ambient dependencies found through `resolutionRoot/node_modules` ancestry.
3. Dependencies of a linked package found from that package's real location and ancestry.

## v1 Scope

- Programs are one source string exporting synchronous or asynchronous `main`. Input and result are strict JSON; a `main` that returns nothing resolves to `null`, so a stdout-style program just prints.
- Programs run with the host Node process's normal authority: this is a lifecycle boundary, not a security boundary.
- One subprocess mechanism, one fixed bootstrap, and an optional host-call bridge. Host-call arguments/results are strict JSON; there is no schema validation.
- Limits are the caller's ([Decision 0008](decisions/0008-one-executor-callers-own-limits-host-modules-carry-declarations.md)). Aborting the caller's `AbortSignal` closes the host-call bridge, then terminates the guest process group (SIGTERM, then SIGKILL after a fixed 2 s grace), and rejects with `ExecutionAbortedError`; an abort after the guest exited does not count. Output goes to caller sinks and is never retained. The host waits only for direct-child exit, then kills what remains of the group.
- Trust model: the caller and its host-module `call` functions are trusted; the program is untrusted for correctness but not contained. The executor imposes no resource budgets, caps, or rate limits and has no mechanisms that exist only to survive a hostile program; an expensive type-check runs in the caller's process, a result is read whole, and a guest can write raw bytes to its IPC descriptor. Resource use is for the caller and the environment to limit and monitor.
- Executions may add per-guest environment variables ([Decision 0007](decisions/0007-per-execution-environment.md)).
- Not provided: built-in deadlines or output caps, a second execution flavor, public mode flags or execution plugins, custom loaders, VM backends, package installers, source-module abstractions, environment *filtering*, process pools, descendant management beyond group termination, runtime package allowlists, multi-file user programs, or cross-restart disk caches. Host-call AbortSignal notification is cooperative and separate from execution cancellation.

## Sub-documents

- [Executor component](components/executor/index.md) — `TSFuncExecutor` provides agent guidance and orchestrates catalog, checking, workspace, cwd, control validation, and cleanup around the JSON function contract.
- [Modules component](components/modules/index.md) — Modules expose existing packages, or reusable generated packages whose functions forward JSON arguments to a host `call` function, through ordinary ESM imports.
- [Runtime component](components/runtime/index.md) — A subprocess primitive streams output to caller sinks, closes the host-call bridge and terminates the process group on abort, reaps it after exit, and carries the JSON function bootstrap and host-call bridge.
- [Host-subprocess execution boundary](boundaries/host-subprocess-execution.md) — Process lifecycle, sink-delivered output, the private TSFunc result protocol, and the host-call protocol.
