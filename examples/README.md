# Examples

These runnable samples use the repository build and small local fixtures; they need no external services or credentials.

```sh
pnpm install
pnpm run examples
```

After `pnpm run build`, each sample can also run independently:

```sh
node examples/01-basic-execution.mjs
node examples/02-package-module.mjs
node examples/03-network-client-package.mjs
node examples/04-agent-harness.mjs
node examples/05-host-module.mjs
```

## Samples

| Sample | Demonstrates |
| --- | --- |
| [`01-basic-execution.mjs`](01-basic-execution.mjs) | Checked TypeScript with JSON input and result, stdout streamed to an `onStdout` sink, and a stdout program (prints, returns nothing) whose output the caller collects. |
| [`02-package-module.mjs`](02-package-module.mjs) | Registering a real ESM package, discovering its absolute root, reading declarations from disk, and importing an exported subpath. |
| [`03-network-client-package.mjs`](03-network-client-package.mjs) | Using a declaration-bearing network client as a plain package and constructing it independently in each fresh subprocess. Generated Connect clients use the same pattern. |
| [`04-agent-harness.mjs`](04-agent-harness.mjs) | JSON tool definitions and dispatch, harness-owned limits stated to the model, filesystem inspection, type-error feedback, and corrected execution using [`harness-adapter.mjs`](harness-adapter.mjs). |
| [`05-host-module.mjs`](05-host-module.mjs) | A host module from declaration text, function names, and one `call` function that validates its own arguments; persistent host state, a catchable host error, declaration reuse, and explicit disposal. |

The adapter is example harness code. It exposes only `listModules` and `execute`, validates their JSON arguments, keeps checking enabled under harness control, and maps results and errors to `{ isError, content }` responses whose `content` is JSON text. It also shows the caller owning the limits, which the executor does not have:

- a deadline: `AbortSignal.timeout(timeoutMs)`, combined with the harness's per-call signal through `AbortSignal.any`;
- bounded output: `onStdout`/`onStderr` feed buffers that keep at most `maxOutputBytes` per stream and flag the rest as truncated;
- both limits stated in its instructions (a `## Limits` section after `getInstructions()`) and in the `execute` tool description.

Register the definitions using your harness's tool protocol and preserve the error flag when delivering responses to the model. The example assumes filesystem tools can read the listed package roots. It does not depend on a particular model provider or SDK.

Human-readable console logs can contain ANSI colors when `FORCE_COLOR` is enabled, even in captured output. Examples that require exact stdout use explicitly formatted `process.stdout.write` strings instead of numeric/object console inspection. The example regression suite runs with colors both disabled and forced, normalizing ANSI only when checking human-readable logs; the text handed to `onStdout` is unchanged.

## Fixtures

- [`fixtures/geometry-package/`](fixtures/geometry-package/) is a real package with root and subpath exports plus a transitive declaration file.
- [`fixtures/counter-client-package/`](fixtures/counter-client-package/) is a built network client package with runtime JavaScript and an existing declaration entrypoint.

Each call supplies an absolute `cwd` independently from the executor's `resolutionRoot`. The executor is a lifecycle boundary, not a sandbox; generated programs have normal Node authority. Inputs and successful values must be strict JSON; a program that returns nothing resolves to `null`.
