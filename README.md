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

## Shared behavior

Both executors expose `modules`, `listModules`, `getTypes`, and `check`. `execute` checks by default; pass `check: false` to skip it. Each execution gets a newly spawned Node process, heap, module cache, and package state.

`resolutionRoot` is the package-resolution base and parent of temporary operation workspaces. Required `execute.cwd` is an absolute path string or a query- and fragment-free local `file:` URL naming an existing directory. It controls `process.cwd()` and relative filesystem access, but package resolution remains anchored to the generated entrypoint below `resolutionRoot`.

General network clients—including generated Connect/Protobuf clients—are ordinary packages. Register built JavaScript and declarations with `packageModule`, then construct the connection inside submitted code.

## Examples

```sh
npm run examples
```

See [`examples/`](examples/README.md) for both execution flavors, physical packages, and a package-native network client.

Execution is not sandboxed. Subprocesses retain normal Node filesystem, network, built-in-module, environment, and child-process authority. The executor reaps only its direct child and provides no timeout, cancellation, environment filtering, custom loader, process pool, or process-tree management. See [`docs/`](docs/index.md) for complete contracts.
