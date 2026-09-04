# Examples

These runnable samples use the repository build and small local fixtures; they need no external services or credentials.

```sh
npm install
npm run examples
```

After `npm run build`, each sample can also run independently:

```sh
node examples/01-basic-execution.mjs
node examples/02-package-module.mjs
node examples/03-network-client-package.mjs
node examples/04-process-stdout.mjs
```

## Samples

| Sample | Demonstrates |
| --- | --- |
| [`01-basic-execution.mjs`](01-basic-execution.mjs) | `TSFuncExecutor` checked TypeScript with JSON input/results and captured subprocess output. |
| [`02-package-module.mjs`](02-package-module.mjs) | Registering a real ESM package, listing it, reading its declaration tree, and importing an exported subpath. |
| [`03-network-client-package.mjs`](03-network-client-package.mjs) | Using a declaration-bearing network client as a plain package and constructing it independently in each fresh subprocess. Generated Connect clients use the same pattern. |
| [`04-process-stdout.mjs`](04-process-stdout.mjs) | `ProcExecutor` running a no-argument `main()` and returning its exact stdout string. |

## Fixtures

- [`fixtures/geometry-package/`](fixtures/geometry-package/) is a real package with root and subpath exports plus a transitive declaration file.
- [`fixtures/counter-client-package/`](fixtures/counter-client-package/) is a built network client package with runtime JavaScript and an existing declaration entrypoint.

Each call supplies an absolute `cwd` independently from the executor's `resolutionRoot`. The executors are lifecycle boundaries, not sandboxes; generated programs have normal Node authority. `TSFuncExecutor` inputs and successful values must be strict JSON. `ProcExecutor` accepts no input, requires `main()` to resolve to exactly `undefined`, returns exact stdout, and intentionally discards captured stderr after a successful run.
