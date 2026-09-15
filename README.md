# ts-executor

Run strictly checked TypeScript ESM programs in fresh Node subprocesses against ordinary declaration-bearing packages. The package exposes two focused executors with the same module catalog and checking behavior.

## JSON function execution

`TSFuncExecutor` calls sync or async `main(input)` and returns its strict-JSON value plus captured output, truncation flags, and duration.

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

console.log(result.value, result.stdout, result.stderr, result.truncated, result.durationMs);
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

The subprocess's stderr is captured for failure reporting. **On successful `ProcExecutor` execution, stderr is intentionally not returned, discarded, and never merged into stdout.** Runtime failures throw exported `ProcExecutionError`, which carries `stdout`, `stderr`, `truncated`, `exitCode`, and `signal`; reported guest errors retain useful name, message, and stack information. `executeDetailed` returns `{ stdout, truncated, durationMs }` when the caller wants capped stdout rather than a rejection.

## Host-owned functions with reusable types

Expose existing host closures and sessions as a typed package—no server or connection setup:

```ts
import { Type, hostFunction, hostModule, TSFuncExecutor } from "ts-executor";

const resolutionRoot = process.cwd();
let total = 0; // lives in the host, not the fresh subprocess
const counter = await hostModule({
  resolutionRoot,
  specifier: "@host/counter",
  description: "Update the current session's counter.",
  functions: {
    increment: hostFunction({
      description: "Add an amount and return the new total.",
      input: Type.Object({ amount: Type.Number() }, { additionalProperties: false }),
      output: Type.Number(),
      handler: ({ amount }) => (total += amount),
    }),
  },
});

const executor = new TSFuncExecutor({ resolutionRoot });
executor.modules.register(counter);
try {
  const source = `
    import { increment } from "@host/counter";
    export async function main() {
      return await increment({ amount: 2 });
    }
  `;
  console.log((await executor.execute({ source, cwd: resolutionRoot })).value); // 2
  console.log((await executor.execute({ source, cwd: resolutionRoot })).value); // 4
} finally {
  await counter.dispose();
}
```

`Type` is the TypeBox schema builder. Schemas infer host handler types, validate JSON arguments/results without coercion, and generate agent-readable declarations and JSDoc. Guest functions always return promises, including when their host handler is synchronous. They work with both executors; host-call validation still runs with `check: false`.

The package's `index.d.ts`, `index.js`, and manifest are generated **once per `hostModule` handle**. Reuse that handle across checks, executions, or multiple executors; its `packageRoot` remains available for `listModules` inspection. A new factory call creates a new package, not a persistent cross-restart cache entry.

```text
<resolutionRoot>/.ts-executor/
  modules/module-<id>/      # reusable generated package
  runs/run-<id>/            # main.ts, config, per-run node_modules links and I/O
```

Runs are removed after completion or failure; shared scaffolding remains. `dispose()` stops new operations using the module, waits already-started operations, and deletes only its generated package. Do not edit generated artifacts or dispose the handle while you still intend to use its registered executors. Existing `packageModule` files remain caller-owned, and custom materializers still run separately per operation.

Calls may run concurrently against shared host state. Await all desired calls before `main` returns. The optional second handler argument provides `{ signal }`, aborted on execution-channel closure; already-started host work may continue if it ignores the signal. Failures do not roll back effects, and calls are never automatically retried. No host closures or live objects are copied into the child.

Use `Type.Null()` and explicit `null` for no-data arguments/results. The initial schema subset supports ordinary JSON objects, arrays, fixed tuples, unions/intersections, records, literals, and primitives. Refs/recursion, transforms, formats, non-JSON kinds, `uniqueItems: true`, and some generator-specific edge cases are rejected; see the [schema contract](docs/components/host-functions/index.md#supported-schema-subset). See [the runnable host-module example](examples/06-host-module.mjs).

## Agent instructions

Expose only `listModules` and `execute` as model tools. The harness uses the synchronous `getInstructions(): string` API to obtain deterministic Markdown for the agent prompt. It describes how to discover package interfaces and execute TypeScript with the selected executor's input/output contract.

```js
// Copy the example adapter into your harness and adjust its executor import.
import { createHarnessAdapter } from "./examples/harness-adapter.mjs";

const { instructions, tools, callTool } = createHarnessAdapter(executor, { timeoutMs: 60_000 });
// Add instructions to the model prompt and register tools with your harness.
// Dispatch model calls using their name and JSON argument text:
const response = await callTool("listModules", '{"query":"geometry"}');
// Deliver response.content to the model, preserving response.isError.
```

The [adapter example](examples/harness-adapter.mjs) defines JSON input schemas and validates arguments before dispatch. Model calls accept an absolute path string for `cwd`; they cannot pass `check` or invoke harness helpers. The adapter fixes checking on, applies the harness limits to every call and states them in the instructions, forwards the harness's per-call `signal` through `callTool(name, args, { signal })`, preserves omitted versus explicit-null TSFunc input, forwards type diagnostics, captured stdout/stderr, truncation flags, and abort reasons on failure, and returns stdout text (with a truncation marker when capped) for successful Proc calls. Map its `name`, `description`, `inputSchema`, and `{ isError, content }` fields to your harness's protocol. Its flat schema validator covers the schemas shown; if you extend those schemas, use a matching JSON Schema validator.

Run [the harness example](examples/05-agent-harness.mjs) to see discovery, filesystem inspection, a diagnostic response, and corrected execution without a model-service dependency.

`listModules({ query? })` returns `{ specifier, packageRoot, description? }` entries in registration order, optionally filtering specifiers and descriptions case-insensitively. Each `packageRoot` is an absolute directory path that remains available between calls. Agents can use the harness's filesystem access to read `package.json`, follow `types` and `exports`, and explore declaration files themselves. Listing returns metadata without reading declaration contents or creating a temporary workspace.

`getTypes` and `DeclarationTree` have been removed. `packageModule` supplies the discovery root automatically; custom `Module` implementations must now provide a stable absolute `packageRoot` containing their interface files.

## Shared behavior

Both executors expose `listModules` and `execute` for the model, plus `getInstructions`, `modules`, and `check` for harness code. `execute` checks by default; harness code can pass `check: false` to skip it. Each execution gets a newly spawned Node process, heap, module cache, and package state.

`resolutionRoot` is the package-resolution base; temporary operation workspaces live below its `.ts-executor/runs/` directory. Required `execute.cwd` is an absolute path string or a query- and fragment-free local `file:` URL naming an existing directory. It controls `process.cwd()` and relative filesystem access, but package resolution remains anchored to the generated entrypoint below `resolutionRoot`.

## Cancellation and output limits

Both `execute` methods accept `signal` (an `AbortSignal`), `timeoutMs` (a wall-clock deadline measured from the call, covering type-checking), `maxOutputBytes` (bytes retained per stream; default `DEFAULT_MAX_OUTPUT_BYTES`, 4 MiB), and `killGraceMs` (default `DEFAULT_KILL_GRACE_MS`, 2 s). Aborting or exceeding the deadline sends SIGTERM to the guest's whole process group, SIGKILL after the grace period, waits for the direct child, cleans the run workspace, and rejects with `ExecutionAbortedError`, which carries `reason` (`"signal"` or `"timeout"`), the output captured so far, `truncated`, `exitCode`, `signal`, and `durationMs`. A pre-aborted signal rejects before anything is spawned. Effects the program already had are not rolled back.

```ts
const controller = new AbortController();
const result = await executor.execute({
  cwd: process.cwd(),
  source,
  signal: controller.signal,
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024,
});
console.log(result.truncated); // { stdout: false, stderr: false }
```

Output beyond `maxOutputBytes` is read and discarded so the program never blocks; the retained prefix is returned with `truncated: { stdout, stderr }` on `TSFuncExecuteResult`, on TSFunc runtime errors, on `ProcExecutionError`, and on `ExecutionAbortedError`. `ProcExecutor.execute` still returns exact stdout and therefore rejects with `ProcExecutionError` when stdout was truncated; `ProcExecutor.executeDetailed` returns `{ stdout, truncated, durationMs }` instead. Pass the same limits to `getInstructions({ timeoutMs, maxOutputBytes })` so the model reads the limits the harness enforces.

General network clients—including generated Connect/Protobuf clients—are ordinary packages. Register built JavaScript and declarations with `packageModule`, then construct the connection inside submitted code.

## Examples

```sh
pnpm run examples
```

See [`examples/`](examples/README.md) for both execution flavors, physical packages, and a package-native network client.

Execution is not sandboxed. Subprocesses retain normal Node filesystem, network, built-in-module, environment, and child-process authority. The executor waits only for its direct child; it terminates the child's process group only on abort or timeout, and provides no environment filtering, custom loader, or process pool. See [`docs/`](docs/index.md) for complete contracts.
