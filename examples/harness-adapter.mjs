import { isAbsolute } from "node:path";
import { ExecutionAbortedError, TSFuncExecutor, TypeCheckError } from "../dist/index.js";

// Example harness code, not an executor API. Map these tool definitions and
// { isError, content } responses to your harness's tool protocol.
//
// The limits are the harness's own policy, not the executor's: the adapter applies
// them to every execution and states them to the model. The executor only runs the
// program; it stops when the signal aborts and hands over output as it is written.
export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024,
});

export function createHarnessAdapter(executor, options = {}) {
  if (!(executor instanceof TSFuncExecutor)) throw new TypeError("Expected a TSFuncExecutor");
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options });
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  }
  const limitsText = [
    `Each execution must finish within ${duration(limits.timeoutMs)} of wall-clock time, including type-checking; after that the program and every process it started are killed and the call fails.`,
    `At most ${size(limits.maxOutputBytes)} of stdout and of stderr are kept per call; the rest is dropped and the result marks that stream as truncated. Put the answer in the return value, not in the output.`,
  ].join(" ");

  const tools = [
    {
      name: "listModules",
      description: "Discover package specifiers and absolute package roots. Inspect package.json and declarations at those roots using filesystem access.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Optional case-insensitive filter on specifier and description." } },
        required: [],
        additionalProperties: false,
      },
    },
    {
      name: "execute",
      description: `Check and run TypeScript exporting main(input). Returns JSON containing value, stdout, stderr, truncated, and durationMs. ${limitsText}`,
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Complete TypeScript ESM program exporting main." },
          cwd: { type: "string", description: "Absolute filesystem path to an existing working directory." },
          input: { description: "Optional JSON input passed to main; omission passes undefined." },
        },
        required: ["source", "cwd"],
        additionalProperties: false,
      },
    },
  ];

  async function execute(args, callSignal) {
    if (!isAbsolute(args.cwd)) throw new TypeError("cwd must be an absolute filesystem path");
    // The deadline is the harness's: one timeout signal, combined with the call's own.
    const deadline = AbortSignal.timeout(limits.timeoutMs);
    const signal = callSignal === undefined ? deadline : AbortSignal.any([callSignal, deadline]);
    const stdout = boundedText(limits.maxOutputBytes);
    const stderr = boundedText(limits.maxOutputBytes);
    const output = () => ({
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
    });
    try {
      const result = await executor.execute({
        source: args.source,
        cwd: args.cwd,
        ...(Object.hasOwn(args, "input") ? { input: args.input } : {}),
        check: true, // Harness policy; the model cannot supply this option.
        signal,
        onStdout: stdout.push,
        onStderr: stderr.push,
      });
      return { value: result.value, ...output(), durationMs: Math.round(result.durationMs) };
    } catch (error) {
      const details = errorDetails(error);
      Object.assign(details, output());
      if (error instanceof ExecutionAbortedError) {
        details.reason = deadline.aborted ? "timeout" : "signal";
        details.durationMs = Math.round(error.durationMs);
      }
      throw Object.assign(new Error(details.message), { details });
    }
  }

  return {
    instructions: `${executor.getInstructions()}\n\n## Limits\n\n${limitsText}`,
    limits,
    tools,
    // Pass the harness's per-call AbortSignal as options.signal.
    async callTool(name, argumentsJson, options = {}) {
      try {
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new TypeError(`Unknown tool: ${name}`);
        if (typeof argumentsJson !== "string") throw new TypeError("Tool arguments must be JSON text");
        const args = JSON.parse(argumentsJson);
        validateArguments(args, tool.inputSchema);
        const result = name === "listModules"
          ? await executor.listModules(args)
          : await execute(args, options.signal);
        return { isError: false, content: JSON.stringify(result) };
      } catch (error) {
        return { isError: true, content: JSON.stringify(error?.details ?? errorDetails(error)) };
      }
    },
  };
}

// Keeps at most maxBytes UTF-8 bytes of whole characters; later text is dropped.
function boundedText(maxBytes) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(text) {
      if (truncated) return;
      const length = Buffer.byteLength(text);
      if (bytes + length <= maxBytes) {
        chunks.push(text);
        bytes += length;
        return;
      }
      let kept = "";
      for (const character of text) {
        const width = Buffer.byteLength(character);
        if (bytes + width > maxBytes) break;
        kept += character;
        bytes += width;
      }
      chunks.push(kept);
      truncated = true;
    },
    text: () => chunks.join(""),
    get truncated() {
      return truncated;
    },
  };
}

// These flat schemas require objects with string fields, plus unrestricted JSON
// for input. JSON.parse supplies JSON values; the executor enforces its stricter
// JSON input contract (including finite numbers).
function validateArguments(args, schema) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("Tool arguments must be a JSON object");
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(args, key)) throw new TypeError(`Missing required argument: ${key}`);
  }
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new TypeError(`Unexpected argument: ${key}`);
    if (schema.properties[key].type === "string" && typeof args[key] !== "string") {
      throw new TypeError(`${key} must be a string`);
    }
  }
}

function errorDetails(error) {
  const details = {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Executor failed with a non-Error value",
  };
  if (error instanceof TypeCheckError) details.diagnostics = error.diagnostics;
  return details;
}

function duration(milliseconds) {
  const count = (value, unit) => `${value} ${unit}${value === 1 ? "" : "s"}`;
  if (milliseconds % 60_000 === 0) return count(milliseconds / 60_000, "minute");
  if (milliseconds % 1000 === 0) return count(milliseconds / 1000, "second");
  return `${milliseconds} ms`;
}

function size(bytes) {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}
