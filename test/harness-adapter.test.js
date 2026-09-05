import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProcExecutor, TSFuncExecutor, packageModule } from "../dist/index.js";
import { createHarnessAdapter } from "../examples/harness-adapter.mjs";
import { project, workspaceNames } from "./helpers.js";

for (const Executor of [TSFuncExecutor, ProcExecutor]) {
  test(`${Executor.name} adapter exposes two tools and rejects invalid model arguments`, async (t) => {
    const root = await project(t);
    const executor = new Executor({ resolutionRoot: root });
    const adapter = createHarnessAdapter(executor);
    assert.equal(adapter.instructions, executor.getInstructions());
    assert.deepEqual(adapter.tools.map(({ name }) => name), ["listModules", "execute"]);
    const schema = adapter.tools[1].inputSchema;
    assert.equal(schema.properties.cwd.type, "string");
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties, "input"), Executor === TSFuncExecutor);
    assert.equal(Object.hasOwn(schema.properties, "check"), false);

    const request = { source: "export function main() {}", cwd: root };
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
      ["listModules", '{"query":42}', /query must be a string/u],
      ["listModules", '{"limit":1}', /Unexpected argument: limit/u],
      ["check", "{}", /Unknown tool: check/u],
    ];
    if (Executor === ProcExecutor) {
      cases.push(["execute", JSON.stringify({ ...request, input: null }), /Unexpected argument: input/u]);
    }
    for (const [name, args, message] of cases) {
      const result = await adapter.callTool(name, args);
      assert.equal(result.isError, true, `${name}: ${JSON.stringify(args)}`);
      assert.match(JSON.parse(result.content).message, message);
    }
    assert.deepEqual(await workspaceNames(root), []);
  });

  test(`${Executor.name} adapter supports discovery, file inspection, and diagnostic repair`, async (t) => {
    const root = await project(t);
    const executor = new Executor({ resolutionRoot: root });
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
          const result = distance({ x: 0, y: 0 }, { x: 3, y: 4 });
          ${Executor === TSFuncExecutor ? "return result;" : 'process.stdout.write(String(result) + "\\n");'}
        }
      `,
    }));
    assert.equal(corrected.isError, false);
    if (Executor === TSFuncExecutor) {
      assert.equal(JSON.parse(corrected.content).value, 5);
    } else {
      assert.equal(corrected.content, "5\n");
    }
    assert.deepEqual(await workspaceNames(root), []);
  });

  test(`${Executor.name} adapter preserves runtime failure details and captured streams`, async (t) => {
    const root = await project(t);
    const adapter = createHarnessAdapter(new Executor({ resolutionRoot: root }));
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
    const error = JSON.parse(failed.content);
    assert.equal(error.name, "RangeError");
    assert.equal(error.message, "broken");
    assert.equal(error.stdout, "partial\n");
    assert.equal(error.stderr, "detail\n");
    if (Executor === ProcExecutor) {
      assert.equal(error.exitCode, 1);
      assert.equal(error.signal, null);
    }
    assert.deepEqual(await workspaceNames(root), []);
  });
}

test("TSFunc adapter preserves omitted input, explicit null, and JSON input values", async (t) => {
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
