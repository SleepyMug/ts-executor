import { isAbsolute } from "node:path";
import { ProcExecutionError, ProcExecutor, TSFuncExecutor, TypeCheckError } from "../dist/index.js";

// Example harness code, not an additional executor API. Map these tool definitions
// and { isError, content } responses to your harness's tool protocol.
export function createHarnessAdapter(executor) {
  const acceptsInput = executor instanceof TSFuncExecutor;
  if (!acceptsInput && !(executor instanceof ProcExecutor)) {
    throw new TypeError("Expected a TSFuncExecutor or ProcExecutor");
  }
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
      description: acceptsInput
        ? "Check and run TypeScript exporting main(input). Returns JSON containing value, stdout, stderr, and durationMs."
        : "Check and run TypeScript exporting main() that returns no value. Returns exact stdout text.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Complete TypeScript ESM program exporting main." },
          cwd: { type: "string", description: "Absolute filesystem path to an existing working directory." },
          ...(acceptsInput ? { input: { description: "Optional JSON input passed to main; omission passes undefined." } } : {}),
        },
        required: ["source", "cwd"],
        additionalProperties: false,
      },
    },
  ];

  return {
    instructions: executor.getInstructions(),
    tools,
    async callTool(name, argumentsJson) {
      try {
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new TypeError(`Unknown tool: ${name}`);
        if (typeof argumentsJson !== "string") throw new TypeError("Tool arguments must be JSON text");
        const args = JSON.parse(argumentsJson);
        validateArguments(args, tool.inputSchema);
        let result;
        if (name === "listModules") {
          result = await executor.listModules(args);
        } else {
          if (!isAbsolute(args.cwd)) throw new TypeError("cwd must be an absolute filesystem path");
          result = await executor.execute({
            source: args.source,
            cwd: args.cwd,
            ...(Object.hasOwn(args, "input") ? { input: args.input } : {}),
            check: true, // Harness policy; the model cannot supply this option.
          });
        }
        return { isError: false, content: typeof result === "string" ? result : JSON.stringify(result) };
      } catch (error) {
        return { isError: true, content: JSON.stringify(errorDetails(error)) };
      }
    },
  };
}

// These flat schemas require objects with string fields, plus unrestricted JSON
// for TSFunc input. JSON.parse supplies JSON values; the executor enforces its
// stricter JSON input contract (including finite numbers).
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
  for (const stream of ["stdout", "stderr"]) {
    if (typeof error?.[stream] === "string") details[stream] = error[stream];
  }
  if (error instanceof ProcExecutionError) {
    details.exitCode = error.exitCode;
    details.signal = error.signal;
  }
  return details;
}
