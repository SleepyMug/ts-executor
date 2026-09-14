# Modules Component

> Modules expose existing packages or reusable generated packages backed by host-owned functions through ordinary ESM imports.

## Overview

Every module has an exact package specifier, a stable absolute discovery root, an optional description, and a materializer returning an operation-valid physical package root. `packageModule` reuses existing JavaScript and declarations. `hostModule` generates a package once and dispatches its asynchronous guest functions to captured handlers in the calling host. Both use the same NodeNext package graph and model discovery workflow.

## Provided APIs

- `Module` — `{ specifier, packageRoot, description?, materialize(context) }`. Discovery roots remain readable during the module's lifetime. Context provides operation-local `packageRoot` and `workspaceRoot`; the result contains only `packageRoot`. Custom materializers still run once per operation and are not automatically cached. Their discovery interfaces must stay consistent with their runtime packages.
- `packageModule({ specifier, root, description? }): Module` — resolves an existing package root and validates it when materialized. Runtime JavaScript, declarations, exports, and subpaths belong to that package. Caller-owned directories are never deleted by the executor.
- `hostModule({ resolutionRoot, specifier, functions, description? }): Promise<HostModule>` — captures a map of names to opaque [HostFunction handles](../host-functions/index.md#provided-apis) before its first await. `resolutionRoot` accepts a nonempty path or query/fragment-free local file URL. Generates a private package under `<resolutionRoot>/.ts-executor/modules/module-<unique>/` before returning. Descriptions appear in discovery metadata; function descriptions become declaration JSDoc. Names must be non-reserved ASCII TypeScript identifiers; `then` is also rejected to avoid ESM dynamic-import thenable behavior. Fabricated function handles, symbol names, and accessor/hidden function properties are rejected.
- `HostModule extends Module` — adds `dispose(): Promise<void>`. Disposal is idempotent, immediately stops new executor operations and registration using this module, waits for already-acquired check/execution leases, then removes only its owned package. Existing operations may still materialize and call it. Discovery/listing after disposal begins rejects. Await disposal before discarding the handle; shared `.ts-executor/modules` and `runs` scaffolding remains. Disposal does not await uncooperative callbacks after their child has left or close caller-owned sessions.
- Host module reuse — register the same handle with multiple executors, including different resolution roots. Repeated discovery/check/execute does not regenerate or rewrite the manifest, proxy, or declarations. Different factory calls get independent package identities; this is module-lifetime reuse, not content-addressed or cross-restart caching. A changed interface requires a new handle. Preserve the returned handle rather than spreading/wrapping it: its dispatch capability is associated internally with its identity and registry snapshots.
- Package-native network clients — remain ordinary built packages. They construct connections inside each subprocess. Use host modules instead when the connection/session or capability must remain owned by the calling host.

## Consumed APIs

- [Host functions](../host-functions/index.md#provided-apis) — supplies immutable validated callbacks and standalone declarations.
- [Executor](../executor/index.md#provided-apis) — captures registry metadata and dispatch capabilities; acquires host-module leases synchronously with operation snapshots, links physical roots into per-run node_modules, and releases leases after cleanup.
- [Runtime](../runtime/index.md#provided-apis) — provides an execution-scoped channel to captured host handlers while preserving fresh child processes.
- [Host-subprocess boundary](../../boundaries/host-subprocess-execution.md#host-call-protocol) — defines messages, errors, disconnect, and side-effect semantics.
- Node/TypeScript package resolution — follows ordinary ESM/NodeNext package exports; generated proxies import the executor-owned compiled client through a stable absolute file URL.

## Workflows

### Existing package

1. Build JavaScript and declarations outside the executor and construct `packageModule`.
2. Register to capture stable metadata and the materializer.
3. `listModules` returns metadata without reading declarations or materializing anything.
4. Each check/execution materializes the snapshot and links returned roots into that run's node_modules. Existing files are reused; custom operation-local packages are removed with their run.

### Host-owned capability

1. Define schema-backed host functions and await `hostModule`. Generation finishes before the discovery root is published; failed generation removes partial owned artifacts.
2. Register the handle. The registry preserves its internal host binding along with frozen metadata.
3. Agents inspect the persistent package.json/index.d.ts and import named functions normally. Each generated function returns the bridge promise directly; no connection setup or new model tool is needed.
4. A check or execution acquires module leases before asynchronous work. Each run links the same generated package; only execution starts a host bridge. Proxy code includes a stable module identity, not a run ID, port, credential, or channel endpoint.
5. When finished using all consumers, call `dispose()`. Active runs retain artifacts until their cleanup completes; new operations fail rather than using deleted files.

## Execution-context Constraints

The registry is not an import allowlist. Built-ins and ambient dependencies remain accessible. Existing packages execute in fresh children; host callbacks execute in the host and may retain state. Generated package files must not be edited or moved while the handle is live; reuse trusts immutable owned artifacts and does not repair tampering. Dependencies of ordinary linked packages resolve from their real locations, not from a different execution cwd. Cross-process persistent caching, result caching, process pools, and remote-object proxies are not provided.
