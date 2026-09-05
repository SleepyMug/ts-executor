# 0004: Model Discovery and Execution

> Models discover package interfaces through filesystem paths and run TypeScript through two tools.

## Context

The previous discovery workflow returned names and descriptions from `listModules`, then required `getTypes` to materialize packages and collect declaration contents. Models can explore package files through filesystem access supplied by the harness. Returning declaration trees duplicates that capability and adds another tool call and temporary workspace.

## Decision

Expose `listModules` and `execute` as the model's executor tools. Keep `getInstructions`, module registration/snapshots, and standalone `check` available to harness code. `getInstructions` describes only discovery and execution, including the selected executor's input/output contract and automatic type checking.

Return `{ specifier, packageRoot, description? }` from `listModules`. The root is an absolute path to a stable package directory where the model can inspect `package.json`, follow `types` and `exports`, and read declarations and referenced files. Listing remains metadata-only, retains registration order and optional case-insensitive filtering, and does not materialize packages.

Require discovery `packageRoot` metadata on `Module`. `packageModule` supplies its resolved existing directory. Custom modules must provide a stable directory with interfaces consistent with their materialized runtime package; an operation-local directory is insufficient for discovery across tool calls.

Remove `getTypes`, `DeclarationTree`, and the declaration traversal implementation. Checking and runtime package resolution continue to use the physical package graph and NodeNext rules.

## Consequences

- The harness must supply filesystem access to the listed roots and keep custom discovery files available between operations.
- Existing `packageModule` registration calls remain valid. Custom modules need discovery metadata, and callers of `getTypes` must migrate to filesystem inspection.
- Listing does not validate declarations. Importing an untyped package still fails strict checking.
- This supersedes the declaration-retrieval API described in Decisions 0001 and 0003; their package and execution conclusions remain historical context.
