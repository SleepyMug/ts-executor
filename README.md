# ts-executor

Run strictly checked TypeScript ESM programs in fresh Node subprocesses against ordinary declaration-bearing packages and host-backed modules. One executor, `TSFuncExecutor`, calls `main(input)` and returns its JSON result. Limits are the caller's: it aborts a signal for a deadline and decides how much output to keep.

## JSON function execution

`TSFuncExecutor` calls sync or async `main(input)` and returns `{ value, durationMs }`.

```ts
import { TSFuncExecutor } from "@sleepymug/ts-executor";

const executor = new TSFuncExecutor({ resolutionRoot: process.cwd() });
const result = await executor.execute({
  cwd: process.cwd(),
  source: `
    export function main(input: { name: string }) {
      return { greeting: \`Hello, \${input.name}!\` };
    }
  `,
  input: { name: "world" },
});

console.log(result.value, result.durationMs);
```

Inputs and results are strict `JsonValue` data. Non-finite numbers, BigInt, `undefined`, sparse arrays, cycles, symbol keys, functions, accessors, hidden properties, and non-plain objects are rejected rather than coerced. Omitting `input` calls `main(undefined)`. A `main` that returns nothing resolves to `null`.

A guest error rejects `execute` with the guest's own name, message, and stack.

## Output

The executor keeps no output. stdout and stderr go to optional sinks as UTF-8 text, as the guest writes them:

```ts
await executor.execute({
  cwd: process.cwd(),
  source,
  onStdout: (text) => process.stdout.write(text),
  onStderr: (text) => process.stderr.write(text),
});
```

- A multibyte character split across writes is delivered whole; an incomplete sequence at the end of the stream arrives as U+FFFD.
- A stream without a sink is not piped at all (`stdio: "ignore"`).
- A sink that throws aborts the execution (the process group is terminated), and `execute` rejects with that error.
- ANSI colors are passed through; inherited `FORCE_COLOR` can affect console inspection. Use explicit string writes for machine-readable output.

A stdout-style program is a function that prints and returns nothing; the caller collects the text:

```ts
let stdout = "";
await executor.execute({
  cwd: process.cwd(),
  source: `export function main(): void { process.stdout.write("exact output\\n"); }`,
  onStdout: (text) => { stdout += text; },
});
```

Bound what a sink keeps yourself; the [harness adapter example](examples/harness-adapter.mjs) keeps at most a fixed number of bytes per stream and flags the rest as dropped.

## Host-owned functions

`hostModule` exposes host closures and sessions as an importable package. The caller supplies the declarations text, the exported function names, and one `call` function:

```ts
import { hostModule, TSFuncExecutor } from "@sleepymug/ts-executor";

const resolutionRoot = process.cwd();
let total = 0; // lives in the host, not the fresh subprocess
const counter = await hostModule({
  resolutionRoot,
  specifier: "@host/counter",
  description: "Update the current session's counter.",
  declarations: `/** Add an amount and return the new total. */
export declare function increment(amount: number): Promise<number>;
`,
  functions: ["increment"],
  call(fn, args) {
    const [amount] = args;
    if (fn !== "increment" || typeof amount !== "number") throw new TypeError("increment(amount: number)");
    return (total += amount);
  },
});

const executor = new TSFuncExecutor({ resolutionRoot });
executor.modules.register(counter);
try {
  const source = `
    import { increment } from "@host/counter";
    export async function main() {
      return await increment(2);
    }
  `;
  console.log((await executor.execute({ source, cwd: resolutionRoot })).value); // 2
  console.log((await executor.execute({ source, cwd: resolutionRoot })).value); // 4
} finally {
  await counter.dispose();
}
```

- `declarations` is written verbatim as the package's `index.d.ts`. Guests are type-checked against it; keeping it accurate is the caller's job.
- `functions` lists distinct, non-reserved identifier names (not `then`). Each generated function forwards its arguments as a JSON array and always returns a promise.
- Trailing `undefined` arguments are dropped, so omitting an optional argument and passing `undefined` are the same call. Any other `undefined` or non-JSON argument rejects the call inside the guest.
- `call(fn, args, { signal })` runs in the host. There is no schema validation: validate `args` in `call`. Its result must be strict JSON or the guest's call rejects; a thrown error reaches the guest as a catchable rejection with its name, message, and stack.
- Unknown names and non-array inputs are rejected before `call`, since a guest can reach the IPC channel directly.
- The `signal` is aborted when the calling execution ends, and at once when the caller aborts the execution (before its guest is terminated; no further call is dispatched). Host work that ignores it may continue.

The package's `index.d.ts`, `index.js`, and manifest are generated **once per `hostModule` handle**. Reuse the handle across checks, executions, or multiple executors; its `packageRoot` remains available for `listModules` inspection. A new factory call creates a new package, not a persistent cross-restart cache entry.

```text
<resolutionRoot>/.ts-executor/
  modules/module-<id>/      # reusable generated package
  runs/run-<id>/            # main.ts, config, per-run node_modules links and I/O
```

Runs are removed after completion or failure; shared scaffolding remains. `dispose()` stops new operations using the module, waits for already-started operations, and deletes only its generated package. Do not edit generated artifacts or dispose the handle while registered executors still need it. Existing `packageModule` files remain caller-owned, and custom materializers still run separately per operation.

Calls may run concurrently against shared host state. Await all desired calls before `main` returns. Failures do not roll back effects, and calls are never retried. No host closures or live objects are copied into the child. See [the runnable host-module example](examples/05-host-module.mjs).

## Agent instructions

Expose only `listModules` and `execute` as model tools. `getInstructions(): string` returns fixed Markdown for the agent prompt describing how to discover package interfaces and execute TypeScript. It states no limits: the harness states the limits it enforces.

```js
// Copy the example adapter into your harness and adjust its executor import.
import { createHarnessAdapter } from "./examples/harness-adapter.mjs";

const { instructions, tools, callTool } = createHarnessAdapter(executor, { timeoutMs: 60_000 });
// Add instructions to the model prompt and register tools with your harness.
// Dispatch model calls using their name and JSON argument text:
const response = await callTool("listModules", '{"query":"geometry"}');
// Deliver response.content to the model, preserving response.isError.
```

The [adapter example](examples/harness-adapter.mjs) shows the caller owning its limits:

- A deadline: each `execute` call runs under `AbortSignal.any([callSignal, AbortSignal.timeout(timeoutMs)])`, with the harness's per-call `signal` passed as `callTool(name, args, { signal })`.
- Bounded output: `onStdout`/`onStderr` feed buffers that keep at most `maxOutputBytes` UTF-8 bytes per stream.
- Stated limits: `instructions` appends a `## Limits` section to `getInstructions()`, and the `execute` tool description repeats it.

It also defines JSON input schemas and validates arguments before dispatch, fixes checking on, preserves omitted versus explicit-null input, and returns `{ value, stdout, stderr, truncated, durationMs }` or error details (diagnostics, captured output, and `reason: "timeout" | "signal"` for aborts). Map its `name`, `description`, `inputSchema`, and `{ isError, content }` fields to your harness's protocol. Run [the harness example](examples/04-agent-harness.mjs) to see discovery, filesystem inspection, a diagnostic response, and corrected execution without a model-service dependency.

`listModules({ query? })` returns `{ specifier, packageRoot, description? }` entries in registration order, optionally filtering specifiers and descriptions case-insensitively. Each `packageRoot` is an absolute directory that remains available between calls. Agents use the harness's filesystem access to read `package.json`, follow `types` and `exports`, and explore declaration files. Listing reads no declarations and creates no workspace.

## Shared behavior

The executor exposes `listModules` and `execute` for the model, plus `getInstructions`, `modules`, and `check` for harness code. `execute` checks by default; harness code can pass `check: false` to skip it. Each execution gets a newly spawned Node process, heap, module cache, and package state.

`resolutionRoot` is the package-resolution base; temporary operation workspaces live below its `.ts-executor/runs/` directory. Required `execute.cwd` is an absolute path string or a query- and fragment-free local `file:` URL naming an existing directory. It controls `process.cwd()` and relative filesystem access; package resolution stays anchored to the generated entrypoint below `resolutionRoot`.

General network clients—including generated Connect/Protobuf clients—are ordinary packages. Register built JavaScript and declarations with `packageModule`, then construct the connection inside submitted code.

## Cancellation, deadlines, and reaping

`execute` accepts `ExecutionControl`: `signal`, `env`, `onStdout`, and `onStderr`. There is no built-in deadline, output cap, or other resource limit.

```ts
const result = await executor.execute({
  cwd: process.cwd(),
  source,
  signal: AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]),
});
```

- Aborting `signal` first closes the guest's host-call channel (running host calls see their signal abort, and nothing more is dispatched), then sends SIGTERM to the guest's whole process group, SIGKILL after a fixed 2 s grace, waits for the direct child, cleans the run workspace, and rejects with `ExecutionAbortedError` carrying `durationMs`.
- A pre-aborted signal rejects before anything is prepared or spawned. Checking is synchronous and cannot be interrupted, so the signal is checked again immediately before spawning; an abort during preparation or checking starts no guest.
- Only an abort before the guest exits counts: one that arrives after it exited leaves its result intact.
- After every exit, whatever remains in the guest's process group is SIGKILLed, so background processes a program starts do not outlive it. A descendant that moved to its own session or group is out of reach.
- Effects the program already had are not rolled back.

`env` supplies extra variables for one guest, merged over the inherited environment:

```ts
await executor.execute({ source, cwd, env: { RUN_ID: "call-7" } });
```

The host's own `process.env` is never modified, so concurrent executions cannot observe each other's values and nothing leaks into a later run. A name may shadow an inherited variable but not one of `RESERVED_ENVIRONMENT_NAMES` — the executor's `TSX_TSCONFIG_PATH` and its private restore variable, which the bootstrap needs to rebuild the caller's original `tsx` configuration; naming either throws. Names must be non-empty and free of `=` and NUL, values strings without NUL. This adds variables; it does not remove or filter inherited ones, so it is not a sandbox (see [Decision 0007](docs/decisions/0007-per-execution-environment.md)).

## Trust model

The caller and its host-module `call` functions are trusted. The program is untrusted for correctness: its input, result, errors, and host-call arguments are validated as strict JSON, and its failures are reported, never believed. It is not contained, though, and the executor has no mechanisms whose only purpose is to survive a hostile program. It may use as much CPU, memory, time, output, result size, and host-call traffic as it likes. A type that is expensive to check blocks the caller's event loop while it is checked, in the caller's process. A large result is read whole. A program that writes raw bytes to its IPC descriptor can crash the caller. Resource limits belong to the caller (abort the signal, bound what the sinks keep) and to the environment the executor runs in (container limits, monitoring).

## Examples

```sh
pnpm run examples
```

See [`examples/`](examples/README.md) for JSON and stdout-style programs, physical packages, a package-native network client, the harness adapter, and a host module.

Execution is not sandboxed. Subprocesses retain normal Node filesystem, network, built-in-module, environment, and child-process authority. The executor waits only for its direct child, terminates its process group on abort and reaps what remains of it after exit (POSIX; on Windows only the direct child), and provides no environment *filtering*, custom loader, or process pool. See [`docs/`](docs/index.md) for complete contracts and [Decision 0008](docs/decisions/0008-one-executor-callers-own-limits-host-modules-carry-declarations.md) for the 0.4.0 changes.
