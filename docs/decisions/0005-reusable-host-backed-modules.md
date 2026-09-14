# 0005: Reusable Host-backed Modules

> Schema-backed host functions use reusable physical packages and execution-scoped IPC without reusing child state.

## Context

Package-native clients solve child-owned libraries and network connections, but not live capabilities implemented by the calling host: closures, sessions, in-memory state, or already-connected clients. Requiring every caller to build a loopback server and client package obscures this common parent-child use case. The earlier generic callback API also required separately maintained declaration strings, risking implementation/type drift.

Agents inspect package declarations between executions. Regenerating declarations and proxies for each check or run is unnecessary when the host contract is unchanged. Reusing a mutable execution workspace, however, would compromise concurrent runs and immutable registry snapshots.

## Decision

Add `hostFunction` with a supported TypeBox JSON-schema subset. It captures schemas and a handler synchronously, infers host handler types, compiles noncoercing validators, and supplies standalone Promise-returning guest declarations. Use an existing declaration generator with filtered metadata and explicit exclusions for verified dependency mismatches; do not accept raw declaration strings as the primary host API.

Add asynchronous `hostModule({ resolutionRoot, specifier, functions, description? })`. It generates a physical package once beneath `.ts-executor/modules/module-<unique>/`, owns that package until explicit `dispose()`, and supports registration with multiple executors. This is handle-lifetime artifact reuse, not a content-addressed cross-restart cache. Independent factory calls produce independent identities.

Place operations beneath `.ts-executor/runs/run-<unique>/`. Each operation owns its entrypoint, files, and node_modules links to the captured graph. Preserve explicit resolutionRoot Node type lookup, native independent cwd, and ordinary NodeNext resolution. Do not cache custom materializers, whose contexts are operation-local. Retain shared storage scaffolding and remove only owned unique directories.

Acquire module leases synchronously with operation snapshots, before asynchronous work. Disposal rejects new operations and waits active leases before deleting artifacts. Host modules' internal dispatch bindings survive registry metadata capture without adding callbacks to the public custom Module interface.

Use one optional Node JSON-text IPC channel per execution containing host modules. Proxies import a shared executor-owned client and carry only stable module/function identities. Both executor flavors retain their own terminal file protocols and regular stdout/stderr files. Completion closes the channel, aborts a cooperative host signal, publishes the existing terminal envelope, and reaps the direct child. Post-spawn IPC errors never release ownership before exit.

## Supersession

[Decision 0001](0001-package-native-general-rpc.md) remains correct for independent package-native network clients; its restriction against a general host-capability adapter no longer applies. Schema-defined contracts address the declaration-drift concern without turning the executor into a network RPC framework.

[Decision 0002](0002-subprocess-json-execution.md) remains authoritative for fresh subprocesses, JSON values, independent cwd, and regular-file output. Its no-parent-channel/generated-package scope is superseded here. No Worker backend or rich-value protocol is restored. [Decision 0003](0003-composed-executor-flavors.md)'s separate execution contracts and shared core remain intact.

## Alternatives Considered

- Caller-managed loopback RPC servers — retain for genuinely independent services, but unnecessary port/connection/lifecycle setup for parent-owned functions.
- Arbitrary callbacks plus runtime TypeScript reflection — types are erased; a generic argument alone cannot generate guest declarations.
- Build-time TypeScript extraction — useful for larger preexisting interfaces, but adds a build integration requirement to small dynamic host capabilities.
- Custom schema DSL/compiler — avoid when existing TypeBox and declaration tooling can provide a bounded supported subset.
- Reuse whole execution directories or one mutable shared node_modules — rejected because source, output, and module membership must remain isolated across concurrent operations.
- Persistent content-addressed disk cache — deferred; requires versioned keys, cross-process publication, ownership, and eviction beyond the current need.
- Automatically retry calls or await all host work after exit — rejected: side effects must not replay, and uncooperative host work must not retain a completed child execution.

## Consequences

The agent still uses only listModules and execute, reading ordinary declarations and importing named functions. Host state persists while guest state remains fresh. Call arguments and results are strict JSON; host functions are asynchronous from the guest and schema-validated even without guest checking. Module disposal is explicit, and generated artifacts must not be mutated while live.

Host work may run concurrently, continue after disconnect, or have effects before an execution fails. AbortSignal is cooperative, not rollback, a deadline, or an execution-cancellation API. Execution remains unsandboxed. Node IPC is an implementation detail, not a promised cross-language wire transport.

See [schema-tooling findings](../experiment_journal/json-schema-tooling.md) and [IPC findings](../experiment_journal/node-child-process-ipc.md) for the verified dependency/runtime constraints.
