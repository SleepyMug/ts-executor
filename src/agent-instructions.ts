import { DEFAULT_MAX_OUTPUT_BYTES } from "./limits.js";
import type { InstructionsOptions } from "./types.js";

type ExecutorName = "TSFuncExecutor" | "ProcExecutor";

const INTRODUCTION = `# TypeScript executor

Use \`listModules\` to discover package APIs and \`execute\` to run one self-contained TypeScript ESM program. Submit the complete program as a \`source\` string and export a named synchronous or asynchronous \`main\` function. Do not rely on additional relative source files.`;

const DISCOVERY_WORKFLOW = `## Recommended workflow

1. Call \`listModules({ query? })\` to discover registered packages. It returns each package's \`specifier\`, absolute \`packageRoot\`, and optional \`description\`. The optional query filters specifiers and descriptions case-insensitively.
2. Inspect files at \`packageRoot\`: start with \`package.json\` and follow its \`types\` and \`exports\` entries to the declaration files defining the interfaces, including exported subpaths. Read the relevant declarations and referenced files before writing imports and calls. Descriptions are summaries, not complete API contracts.
3. Write strict ES2022 TypeScript using ESM imports. Import registered packages by package specifier and Node built-ins with \`node:\` specifiers.
4. Call \`execute\` with the source and an absolute existing \`cwd\` directory. It type-checks the source before running by default; repair reported errors and retry. The working directory controls relative filesystem and process behavior; import packages by specifier regardless of \`cwd\`.
5. Each execution starts a fresh Node subprocess with fresh module state. Await asynchronous work and ensure \`main\` settles. Some packages expose host-owned functions: these calls are asynchronous, accept and return JSON data, and may access state that persists between executions. Await them before returning from \`main\`; do not assume failed executions roll back their effects.`;

const TS_FUNC_EXECUTION = `## JSON function execution

Export \`main(input)\` and call \`execute({ source, cwd, input? })\`. Omitted input is passed to \`main\` as \`undefined\`. Supplied input and the resolved return value must be strict JSON data: null, booleans, finite numbers, strings, dense arrays, and plain objects composed only from those values. Do not use \`undefined\`, BigInt, functions, symbols, accessors, class instances, sparse arrays, or cycles as supplied input or as the successful return value.

A successful call returns \`{ value, stdout, stderr, durationMs }\`. Put the machine-readable answer in the return value; treat stdout and stderr as captured logs.`;

const PROC_EXECUTION = `## Stdout process execution

Export \`main()\` with no parameters and call \`execute({ source, cwd })\`. The function may be synchronous or asynchronous, but it must resolve to exactly \`undefined\`; do not return a result value. Write the desired result to stdout, preferably with \`process.stdout.write\` when exact formatting matters.

A successful call returns the exact captured stdout string. Successful stderr is discarded rather than returned or merged into stdout, so use stderr only for diagnostics that matter when execution fails.`;

const SHARED_SEGMENTS = Object.freeze([
  INTRODUCTION,
  DISCOVERY_WORKFLOW,
]);

const FLAVOR_SEGMENTS: Readonly<Record<ExecutorName, string>> = Object.freeze({
  TSFuncExecutor: TS_FUNC_EXECUTION,
  ProcExecutor: PROC_EXECUTION,
});

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return plural(bytes, "byte");
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return plural(milliseconds / 60_000, "minute");
  if (milliseconds % 1000 === 0) return plural(milliseconds / 1000, "second");
  return `${milliseconds} ms`;
}

/** Deterministic statement of the limits the harness enforces on every execution. */
function limitsSegment(executorName: ExecutorName, options: InstructionsOptions | undefined): string {
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const consequence = executorName === "TSFuncExecutor"
    ? "further output is discarded and the result marks that stream as truncated"
    : "further stderr is discarded, and stdout beyond the cap makes the call fail";
  const lines = [
    "## Limits",
    "",
    `- stdout and stderr are each retained up to ${formatBytes(maxOutputBytes)}; ${consequence}. Write large data to a file under \`cwd\` and return or print its path instead of the data.`,
  ];
  if (options?.timeoutMs !== undefined) {
    lines.push(
      `- Each execution must finish within ${formatDuration(options.timeoutMs)} of wall-clock time including type-checking; afterwards the program and every process it started are killed and the call fails with the output captured so far. Give your own child processes shorter deadlines.`,
    );
  }
  lines.push(
    "- If the call is cancelled or times out, effects the program already had are not rolled back.",
  );
  return lines.join("\n");
}

export function instructionsFor(executorName: ExecutorName, options?: InstructionsOptions): string {
  return [...SHARED_SEGMENTS, FLAVOR_SEGMENTS[executorName], limitsSegment(executorName, options)].join("\n\n");
}
