# Modules Component

> Modules expose existing packages, or reusable generated packages whose functions forward JSON arguments to a host `call` function, through ordinary ESM imports.

## Overview

Every module has an exact package specifier, a stable absolute discovery root, an optional description, and a materializer returning an operation-valid physical package root. `packageModule` reuses existing JavaScript and declarations. `hostModule` generates a package once from caller-supplied declarations and function names; its guest functions forward their arguments to one `call` function in the calling host. Both use the same NodeNext package graph and model discovery workflow. The executor validates no schemas: host-call arguments and results only have to be strict JSON.

## Provided APIs

- `Module` — `{ specifier, packageRoot, description?, materialize(context) }`. Discovery roots remain readable during the module's lifetime. Context provides operation-local `packageRoot` and `workspaceRoot`; the result contains only `packageRoot`. Custom materializers run once per operation and are not cached. Their discovery interfaces must stay consistent with their runtime packages.
- `packageModule({ specifier, root, description? }): Module` — resolves an existing package root and validates it when materialized. Runtime JavaScript, declarations, exports, and subpaths belong to that package. Caller-owned directories are never deleted by the executor.

### Host modules

- `hostModule({ resolutionRoot, specifier, description?, declarations, functions, call }): Promise<HostModule>` — captures every option before its first await, then generates a private package under `<resolutionRoot>/.ts-executor/modules/module-<unique>/` before returning. `resolutionRoot` accepts a non-empty path or query/fragment-free local file URL. `description` appears in discovery metadata. Invalid options reject without writing artifacts.
- `declarations: string` — written verbatim as the package's `index.d.ts`, which guests are type-checked against. It should declare each name in `functions` (normally as Promise-returning functions) and nothing else that exists at runtime. Its accuracy is the caller's responsibility; nothing checks it against `call`.
- `functions: readonly string[]` — exported names. They must be distinct, non-reserved ASCII identifiers; `then` is rejected to avoid ESM dynamic-import thenable behavior. The generated `index.js` exports one forwarder per name.
- Forwarding — each generated function sends its arguments as a JSON array and returns a promise. Trailing `undefined` arguments are dropped, so omitting an optional argument and passing `undefined` are the same call. Any other `undefined`, or any non-JSON argument, rejects the call inside the guest (for example `Host-call envelope at $.input[1] has unsupported type undefined`) without reaching the host.
- `HostCall` — `call(fn: string, args: readonly JsonValue[], context: HostCallContext): JsonValue | Promise<JsonValue>`. Runs in the host for every call. The host rejects unknown names and non-array inputs before invoking it, because a guest can reach the IPC client directly. Validating `args` is `call`'s job. Its result must be strict JSON, or the guest's call rejects with a `TypeError` (`Host-call envelope at $.value ...`). A thrown error reaches the guest as a catchable rejection with its name, message, and stack, not custom fields or class identity.
- `HostCallContext` — `{ readonly signal: AbortSignal }`. All calls in one execution share its signal; it aborts when the execution ends (it settled or its channel closed), and at once when the caller aborts the execution or a sink throws, before the guest is signalled; no call is dispatched after that. Handlers must cooperate to stop; no forced cancellation or per-call deadline is supplied.
- `HostModule extends Module` — adds `dispose(): Promise<void>`. Disposal is idempotent, immediately stops new executor operations and registration using this module, waits for already-acquired check/execution leases, then removes only its owned package. Existing operations may still materialize and call it. Discovery/listing after disposal begins rejects. Await disposal before discarding the handle; shared `.ts-executor/modules` and `runs` scaffolding remains. Disposal does not await uncooperative calls after their child has left or close caller-owned sessions.
- Host module reuse — register the same handle with multiple executors, including different resolution roots. Repeated discovery/check/execute does not regenerate or rewrite the manifest, forwarders, or declarations. Different factory calls get independent package identities; this is module-lifetime reuse, not content-addressed or cross-restart caching. Changed declarations or names require a new handle. Preserve the returned handle rather than spreading/wrapping it: its dispatch capability is associated internally with its identity and registry snapshots.
- Package-native network clients — remain ordinary built packages. They construct connections inside each subprocess. Use host modules instead when the connection/session or capability must remain owned by the calling host.

## Consumed APIs

- [Executor](../executor/index.md#provided-apis) — captures registry metadata and dispatch capabilities; acquires host-module leases synchronously with operation snapshots, links physical roots into per-run node_modules, and releases leases after cleanup.
- [Runtime](../runtime/index.md#provided-apis) — provides an execution-scoped channel to the captured `call` functions while preserving fresh child processes.
- [Host-subprocess boundary](../../boundaries/host-subprocess-execution.md#host-call-protocol) — defines messages, strict JSON encoding, errors, disconnect, and side-effect semantics.
- Node/TypeScript package resolution — follows ordinary ESM/NodeNext package exports; generated forwarders import the executor-owned compiled client through a stable absolute file URL.

## Workflows

### Existing package

1. Build JavaScript and declarations outside the executor and construct `packageModule`.
2. Register to capture stable metadata and the materializer.
3. `listModules` returns metadata without reading declarations or materializing anything.
4. Each check/execution materializes the snapshot and links returned roots into that run's node_modules. Existing files are reused; custom operation-local packages are removed with their run.

### Host-owned capability

1. Write the declarations text for the functions, list their names, and implement `call`, validating its own arguments. Await `hostModule`. Generation finishes before the discovery root is published; failed generation removes partial owned artifacts.
2. Register the handle. The registry preserves its internal host binding along with frozen metadata.
3. Agents inspect the persistent package.json/index.d.ts and import named functions normally. Each generated function returns the bridge promise directly; no connection setup or new model tool is needed.
4. A check or execution acquires module leases before asynchronous work. Each run links the same generated package; only execution starts a host bridge. Forwarder code includes a stable module identity, not a run ID, port, credential, or channel endpoint.
5. When finished using all consumers, call `dispose()`. Active runs retain artifacts until their cleanup completes; new operations fail rather than using deleted files.

## Execution-context Constraints

The registry is not an import allowlist. Built-ins and ambient dependencies remain accessible. Existing packages execute in fresh children; `call` executes in the host with ordinary host permissions and may retain state. Concurrent calls share the caller's host state; synchronization belongs to `call`. Effects persist even if an execution fails, and disconnection or disposal cannot undo them or forcibly stop host work. Declarations describe data, not authority, and are not verified against `call`. Generated package files must not be edited or moved while the handle is live; reuse trusts immutable owned artifacts and does not repair tampering. Dependencies of ordinary linked packages resolve from their real locations, not from a different execution cwd. Cross-process persistent caching, result caching, process pools, and remote-object proxies are not provided.
