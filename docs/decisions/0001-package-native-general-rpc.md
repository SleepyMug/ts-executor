# 0001: Package-native General RPC

> General RPC clients run as ordinary declaration-bearing packages and reconnect inside each fresh Worker.

## Context

The original generic `rpcModule` accepted host callbacks plus a separately supplied declaration string or tree. JavaScript callbacks do not retain parameter and return types at runtime, so callers had to keep that declaration artifact synchronized manually. Generated Protobuf/Connect clients and other mature RPC clients already ship runtime JavaScript and `.d.ts` through normal package exports.

MCP differs: tool declarations can be discovered dynamically from a live server, and the adapter is explicitly given a connected parent-owned client whose session should survive individual Worker lifetimes.

## Decision

Remove the public generic `rpcModule`. General RPC has no executor-specific integration: callers build a declaration-bearing client package, register it with `packageModule` when discovery is needed, and construct its client or transport inside `main` or imported package code. Every fresh Worker therefore creates its own connection and package singleton state.

Retain `mcpModule` as the sole specialized host-backed adapter. Its generated package forwards structured-cloneable tool calls to the connected client through an internal Worker-host bridge. The bridge is not a public general-RPC API.

## Alternatives Considered

- Keep generic host callbacks and declaration strings — rejected because the runtime implementation and manually authored type contract can drift.
- Add Connect-specific executor behavior — rejected because generated Connect packages already satisfy ordinary ESM and TypeScript package conventions.
- Reconnect MCP inside each Worker — rejected for now because connection setup is not represented by tool schemas and schemas may be discovered only after establishing the parent-owned session.
- Expose host capabilities through a loopback Connect server — viable later, but unnecessary for the current package-native client model.

## Consequences

- The public surface is smaller: `packageModule` handles existing clients and `mcpModule` handles live MCP sessions.
- RPC packages must already expose resolvable `.d.ts`, `.d.mts`, or `.d.cts`; `getTypes` does not synthesize declarations for them.
- Network connection setup and credentials are package or program inputs, not executor configuration.
- A new Worker reconnects general clients on every execution; connection pools and package caches do not survive runs.
- Arbitrary parent-owned callback objects are unsupported unless a future protocol-specific adapter is introduced.
