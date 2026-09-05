# Modules Component

> Modules expose existing declaration-bearing packages through ordinary ESM imports.

## Overview

A module has one exact package specifier, a stable absolute package root for discovery, an optional description, and a materializer that yields a physical package root for execution. `packageModule` uses the same existing directory for discovery and materialization, linking runtime JavaScript and declarations without interpreting the package's protocol. This is the complete integration for local libraries and network clients, including generated Protobuf/Connect clients: package code creates its own connection inside each fresh subprocess.

## Provided APIs

- `Module` — `{ specifier, packageRoot, description?, materialize(context) }`. The discovery `packageRoot` must be an absolute path to a package directory whose interface files remain readable between operations. Custom materializers must arrange that stable discovery directory separately from any temporary materialization and keep its interfaces consistent with the runtime package. Materialization returns a package root valid for the enclosing operation. The context provides an operation-local location for materializers that need to prepare an ordinary package. The result contains only `packageRoot`; there is no parent-callback facility.
- `packageModule({ specifier, root, description? }): Module` — validates the exact package specifier, resolves `root` to an absolute discovery `packageRoot`, and links that existing readable directory when materialized. Its `package.json` exports, runtime JavaScript, and declarations define all behavior, including subpaths. Models inspect these files directly using the roots returned by `listModules`.
- Package-native network-client convention — generated Connect/Protobuf and other network clients are built before registration and supplied through `packageModule`. Their package must already expose runtime JavaScript and declarations. Client construction, endpoint selection, authentication, and reconnection are package/runtime concerns executed independently in every subprocess.

## Consumed APIs

- [Shared executor workspace lifecycle](../executor/index.md#provided-apis) — both public flavors link package roots at exact specifiers and supply an operation-local materialization destination.
- [Fresh subprocess execution](../runtime/index.md#provided-apis) — imports ordinary package JavaScript using the same physical graph used for checking.
- Node and TypeScript package resolution — ordinary packages provide runtime and declaration entrypoints through standard `package.json` conventions.

## Workflows

### Register and materialize a package

1. Build the package outside the executor so runtime JavaScript, `package.json`, and declarations already exist.
2. Construct `packageModule`; it captures an absolute package root and fixed discovery metadata.
3. Registration validates and freezes the module's public metadata and bound materializer.
4. `listModules` returns the captured discovery metadata without invoking materializers. Each checking or execution operation invokes each snapshot materializer once, validates its package root, and links it at the exact specifier below the operation's `node_modules`.

### Use a network client package

1. Register the declaration-bearing client package for discovery and workspace materialization.
2. Submitted source imports the package through ordinary NodeNext resolution.
3. Package code constructs its client from guest logic, JSON input when using TSFunc, or environment configuration and connects directly from the fresh subprocess.
4. Because every execution has a fresh process and module graph, package singletons and clients are created again for that execution.

## Execution-context Constraints

Packages run entirely inside the subprocess and have normal Node authority. The executor neither creates nor pools their network connections. Discovery lists package metadata without verifying declarations; untyped packages fail strict checking when imported without usable declarations. Dependencies imported by a linked package resolve from that package's real filesystem location and normal ancestry. Registry membership enables discovery and materialization but does not restrict built-ins or ambient package imports.
