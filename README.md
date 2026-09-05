# ts-executor

Run strictly checked TypeScript ESM programs in fresh Node subprocesses against ordinary declaration-bearing packages. The package exposes two focused executors with the same module catalog and checking behavior.

## JSON function execution

`TSFuncExecutor` calls sync or async `main(input)` and returns its strict-JSON value plus captured output and duration.

```ts
import { TSFuncExecutor } from "ts-executor";

const executor = new TSFuncExecutor({ resolutionRoot: process.cwd() });
const result = await executor.execute({
  cwd: process.cwd(),
  source: `
    export function main(input: { name: string }) {
      console.log("creating greeting");
      return { greeting: \`Hello, \${input.name}!\` };
    }
  `,
  input: { name: "world" },
});

console.log(result.value, result.stdout, result.stderr, result.durationMs);
```

Inputs and successful values are strict `JsonValue` data. Non-finite numbers, BigInt, `undefined`, sparse arrays, cycles, symbol keys, functions, accessors, hidden properties, and non-plain objects are rejected rather than coerced. Omitting `input` calls `main(undefined)`.

## Stdout process execution

`ProcExecutor` calls sync or async `main()` with no arguments. `main()` must resolve to exactly `undefined`; any returned value fails. Success is the exact captured stdout string.

```ts
import { ProcExecutor } from "ts-executor";

const executor = new ProcExecutor({ resolutionRoot: process.cwd() });
const stdout = await executor.execute({
  cwd: process.cwd(),
  source: `
    export async function main(): Promise<void> {
      await Promise.resolve();
      process.stdout.write("exact output\\n");
    }
  `,
});

process.stdout.write(stdout);
```

The subprocess's stderr is captured for failure reporting. **On successful `ProcExecutor` execution, stderr is intentionally not returned, discarded, and never merged into stdout.** Runtime failures throw exported `ProcExecutionError`, which carries `stdout`, `stderr`, `exitCode`, and `signal`; reported guest errors retain useful name, message, and stack information.

## Agent instructions

Expose only `listModules` and `execute` as model tools. The harness uses the synchronous `getInstructions(): string` API to obtain deterministic Markdown for the agent prompt. It describes how to discover package interfaces and execute TypeScript with the selected executor's input/output contract.

```js
// Copy the example adapter into your harness and adjust its executor import.
import { createHarnessAdapter } from "./examples/harness-adapter.mjs";

const { instructions, tools, callTool } = createHarnessAdapter(executor);
// Add instructions to the model prompt and register tools with your harness.
// Dispatch model calls using their name and JSON argument text:
const response = await callTool("listModules", '{"query":"geometry"}');
// Deliver response.content to the model, preserving response.isError.
```

The [adapter example](examples/harness-adapter.mjs) defines JSON input schemas and validates arguments before dispatch. Model calls accept an absolute path string for `cwd`; they cannot pass `check` or invoke harness helpers. The adapter fixes checking on, preserves omitted versus explicit-null TSFunc input, forwards type diagnostics and captured stdout/stderr on failure, and returns exact stdout text for successful Proc calls. Map its `name`, `description`, `inputSchema`, and `{ isError, content }` fields to your harness's protocol. Its flat schema validator covers the schemas shown; if you extend those schemas, use a matching JSON Schema validator.

Run [the harness example](examples/05-agent-harness.mjs) to see discovery, filesystem inspection, a diagnostic response, and corrected execution without a model-service dependency.

`listModules({ query? })` returns `{ specifier, packageRoot, description? }` entries in registration order, optionally filtering specifiers and descriptions case-insensitively. Each `packageRoot` is an absolute directory path that remains available between calls. Agents can use the harness's filesystem access to read `package.json`, follow `types` and `exports`, and explore declaration files themselves. Listing returns metadata without reading declaration contents or creating a temporary workspace.

`getTypes` and `DeclarationTree` have been removed. `packageModule` supplies the discovery root automatically; custom `Module` implementations must now provide a stable absolute `packageRoot` containing their interface files.

## Shared behavior

Both executors expose `listModules` and `execute` for the model, plus `getInstructions`, `modules`, and `check` for harness code. `execute` checks by default; harness code can pass `check: false` to skip it. Each execution gets a newly spawned Node process, heap, module cache, and package state.

`resolutionRoot` is the package-resolution base and parent of temporary operation workspaces. Required `execute.cwd` is an absolute path string or a query- and fragment-free local `file:` URL naming an existing directory. It controls `process.cwd()` and relative filesystem access, but package resolution remains anchored to the generated entrypoint below `resolutionRoot`.

General network clients—including generated Connect/Protobuf clients—are ordinary packages. Register built JavaScript and declarations with `packageModule`, then construct the connection inside submitted code.

## Examples

```sh
npm run examples
```

See [`examples/`](examples/README.md) for both execution flavors, physical packages, and a package-native network client.

Execution is not sandboxed. Subprocesses retain normal Node filesystem, network, built-in-module, environment, and child-process authority. The executor reaps only its direct child and provides no timeout, cancellation, environment filtering, custom loader, process pool, or process-tree management. See [`docs/`](docs/index.md) for complete contracts.
