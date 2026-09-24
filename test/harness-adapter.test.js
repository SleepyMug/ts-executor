import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TSFuncExecutor, hostModule, packageModule } from "../dist/index.js";
import { DEFAULT_LIMITS, createHarnessAdapter } from "../examples/harness-adapter.mjs";
import { project, workspaceNames } from "./helpers.js";

test("adapter exposes two tools, states its own limits, and rejects invalid model arguments", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const adapter = createHarnessAdapter(executor);
  assert.deepEqual(adapter.limits, DEFAULT_LIMITS);
  assert.ok(adapter.instructions.startsWith(`${executor.getInstructions()}\n\n## Limits\n\n`));
  assert.match(adapter.instructions, /must finish within 1 minute of wall-clock time, including type-checking/u);
  assert.match(adapter.instructions, /At most 64 KiB of stdout and of stderr are kept per call/u);
  assert.deepEqual(adapter.tools.map(({ name }) => name), ["listModules", "execute"]);
  const execute = adapter.tools[1];
  assert.match(execute.description, /within 1 minute.*At most 64 KiB/u);
  const schema = execute.inputSchema;
  assert.equal(schema.properties.cwd.type, "string");
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, "input"), true);
  assert.equal(Object.hasOwn(schema.properties, "check"), false);

  const request = { source: "export function main() { return null; }", cwd: root };
  const cases = [
    ["execute", "{", /JSON|property name/u],
    ["execute", request, /JSON text/u],
    ["execute", "null", /JSON object/u],
    ["execute", "[]", /JSON object/u],
    ["execute", JSON.stringify({ source: request.source }), /Missing required argument: cwd/u],
    ["execute", JSON.stringify({ ...request, source: 42 }), /source must be a string/u],
    ["execute", JSON.stringify({ ...request, cwd: 42 }), /cwd must be a string/u],
    ["execute", JSON.stringify({ ...request, cwd: "relative" }), /absolute filesystem path/u],
    ["execute", JSON.stringify({ ...request, cwd: "file:///tmp" }), /absolute filesystem path/u],
    ["execute", JSON.stringify({ ...request, check: false }), /Unexpected argument: check/u],
    ["execute", JSON.stringify({ ...request, timeoutMs: 1 }), /Unexpected argument: timeoutMs/u],
    ["listModules", '{"query":42}', /query must be a string/u],
    ["listModules", '{"limit":1}', /Unexpected argument: limit/u],
    ["check", "{}", /Unknown tool: check/u],
  ];
  for (const [name, args, message] of cases) {
    const result = await adapter.callTool(name, args);
    assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
    assert.match(JSON.parse(result.content).message, message);
  }
  assert.deepEqual(await workspaceNames(root), []);

  assert.throws(() => createHarnessAdapter({}), /Expected a TSFuncExecutor/u);
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { maxOutputBytes: -1 }, { maxOutputBytes: "64" }]) {
    assert.throws(() => createHarnessAdapter(executor, limits), /must be a positive integer/u);
  }
  const custom = createHarnessAdapter(executor, { timeoutMs: 1500, maxOutputBytes: 1000 });
  assert.match(custom.instructions, /within 1500 ms of/u);
  assert.match(custom.instructions, /At most 1000 bytes of/u);
});

test("adapter supports discovery, file inspection, and diagnostic repair", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(packageModule({
    specifier: "@example/geometry",
    root: fileURLToPath(new URL("../examples/fixtures/geometry-package/", import.meta.url)),
  }));
  const adapter = createHarnessAdapter(executor);
  const catalog = await adapter.callTool("listModules", '{"query":"GEOMETRY"}');
  assert.equal(catalog.isError, false);
  const [module] = JSON.parse(catalog.content);
  const manifest = JSON.parse(await readFile(join(module.packageRoot, "package.json"), "utf8"));
  const declarations = await readFile(join(module.packageRoot, manifest.exports["."].types), "utf8");
  assert.match(declarations, /distance/u);

  const failed = await adapter.callTool("execute", JSON.stringify({
    cwd: root,
    source: 'export function main() { const bad: number = "wrong"; return bad; }',
  }));
  assert.equal(failed.isError, true);
  const error = JSON.parse(failed.content);
  assert.equal(error.name, "TypeCheckError");
  assert.match(error.message, /main\.ts:1:/u);
  assert.ok(error.diagnostics.some(({ code, file, line }) => code === 2322 && file === "main.ts" && line === 1));

  const corrected = await adapter.callTool("execute", JSON.stringify({
    cwd: root,
    source: `
      import { distance } from "@example/geometry";
      export function main() {
        console.log("measuring");
        return distance({ x: 0, y: 0 }, { x: 3, y: 4 });
      }
    `,
  }));
  assert.equal(corrected.isError, false);
  const result = JSON.parse(corrected.content);
  assert.deepEqual(Object.keys(result).sort(), ["durationMs", "stderr", "stdout", "truncated", "value"]);
  assert.equal(result.value, 5);
  assert.equal(result.stdout, "measuring\n");
  assert.equal(result.stderr, "");
  assert.deepEqual(result.truncated, { stdout: false, stderr: false });
  assert.equal(typeof result.durationMs, "number");
  assert.deepEqual(await workspaceNames(root), []);
});

test("adapter reports runtime failures with the output it kept", async (t) => {
  const root = await project(t);
  const adapter = createHarnessAdapter(new TSFuncExecutor({ resolutionRoot: root }));
  const failed = await adapter.callTool("execute", JSON.stringify({
    cwd: root,
    source: `
      export function main(): never {
        process.stdout.write("partial\\n");
        process.stderr.write("detail\\n");
        throw new RangeError("broken");
      }
    `,
  }));
  assert.equal(failed.isError, true);
  assert.deepEqual(JSON.parse(failed.content), {
    name: "RangeError",
    message: "broken",
    stdout: "partial\n",
    stderr: "detail\n",
    truncated: { stdout: false, stderr: false },
  });
  assert.deepEqual(await workspaceNames(root), []);
});

test("adapter keeps at most maxOutputBytes of whole characters per stream and flags the rest", async (t) => {
  const root = await project(t);
  const adapter = createHarnessAdapter(new TSFuncExecutor({ resolutionRoot: root }), { maxOutputBytes: 512 });
  const capped = await adapter.callTool("execute", JSON.stringify({
    cwd: root,
    source: 'export function main() { process.stdout.write("y".repeat(2048)); process.stderr.write("short"); return 1; }',
  }));
  assert.equal(capped.isError, false);
  const result = JSON.parse(capped.content);
  assert.equal(result.value, 1);
  assert.equal(result.stdout, "y".repeat(512));
  assert.equal(result.stderr, "short");
  assert.deepEqual(result.truncated, { stdout: true, stderr: false });

  // Five bytes hold two 2-byte characters; the third is dropped rather than cut.
  const multibyte = createHarnessAdapter(new TSFuncExecutor({ resolutionRoot: root }), { maxOutputBytes: 5 });
  const cut = JSON.parse((await multibyte.callTool("execute", JSON.stringify({
    cwd: root,
    source: 'export function main() { process.stdout.write("ααα"); return null; }',
  }))).content);
  assert.equal(cut.stdout, "αα");
  assert.equal(cut.truncated.stdout, true);
  assert.deepEqual(await workspaceNames(root), []);
});

test("adapter forwards the harness's per-call signal and reports an abort", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const call = new AbortController();
  const module = await hostModule({
    resolutionRoot: root,
    specifier: "@host/harness",
    declarations: "export declare function started(): Promise<null>;\n",
    functions: ["started"],
    // The harness cancels the tool call once the program is running.
    call: () => {
      call.abort();
      return null;
    },
  });
  t.after(() => module.dispose());
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const adapter = createHarnessAdapter(executor);
  const failure = await adapter.callTool("execute", JSON.stringify({
    cwd: root,
    source: `
      import { started } from "@host/harness";
      export async function main() {
        process.stdout.write("started");
        await started();
        setInterval(() => {}, 1000);
        await new Promise(() => {});
        return null;
      }
    `,
  }), { signal: call.signal });
  assert.equal(failure.isError, true);
  const details = JSON.parse(failure.content);
  assert.equal(details.name, "ExecutionAbortedError");
  assert.equal(details.reason, "signal");
  assert.equal(typeof details.durationMs, "number");
  assert.equal(details.stdout, "started");
  assert.deepEqual(details.truncated, { stdout: false, stderr: false });
  assert.deepEqual(await workspaceNames(root), []);
});

test("adapter's own deadline stops a program that never settles", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const adapter = createHarnessAdapter(new TSFuncExecutor({ resolutionRoot: root }), { timeoutMs: 1500 });
  const started = performance.now();
  const failure = await adapter.callTool("execute", JSON.stringify({
    cwd: root,
    source: "export async function main() { setInterval(() => {}, 1000); await new Promise(() => {}); return null; }",
  }), { signal: new AbortController().signal });
  const elapsed = performance.now() - started;
  assert.equal(failure.isError, true);
  const details = JSON.parse(failure.content);
  assert.equal(details.name, "ExecutionAbortedError");
  assert.equal(details.reason, "timeout");
  assert.ok(elapsed >= 1450 && elapsed < 10_000, `stopped after ${elapsed} ms`);
  assert.deepEqual(await workspaceNames(root), []);
});

test("adapter preserves omitted input, explicit null, and JSON input values", async (t) => {
  const root = await project(t);
  const adapter = createHarnessAdapter(new TSFuncExecutor({ resolutionRoot: root }));
  const request = {
    cwd: root,
    source: "export function main(input: unknown) { return { omitted: input === undefined, value: input ?? null }; }",
  };
  for (const extra of [{}, { input: null }, { input: { numbers: [1, 2], okay: true } }]) {
    const result = await adapter.callTool("execute", JSON.stringify({ ...request, ...extra }));
    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.content).value, {
      omitted: !Object.hasOwn(extra, "input"),
      value: extra.input ?? null,
    });
  }
});
