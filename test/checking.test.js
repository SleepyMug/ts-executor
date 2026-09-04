import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { TSFuncExecutor, TypeCheckError } from "../dist/index.js";
import { project, workspaceNames } from "./helpers.js";

test("strict NodeNext checking reports diagnostics and runs by default before execute", async (t) => {
  const root = await project(t);
  await mkdir(join(root, "node_modules", "@types", "ambient-test"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "@types", "ambient-test", "index.d.ts"),
    "declare const accidentalAmbient: string;\n",
  );
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const source = `
    export function main(): string {
      const value: string = 42;
      return value;
    }
  `;

  const checked = await executor.check({ source });
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some((diagnostic) => diagnostic.code === 2322));
  assert.deepEqual(
    checked.diagnostics.find((diagnostic) => diagnostic.code === 2322),
    {
      category: "error",
      code: 2322,
      message: "Type 'number' is not assignable to type 'string'.",
      file: "main.ts",
      line: 3,
      column: 13,
    },
  );

  await assert.rejects(
    executor.execute({ source, cwd: root }),
    (error) => error instanceof TypeCheckError && error.diagnostics.some((item) => item.code === 2322),
  );
  assert.deepEqual(await workspaceNames(root), []);
  const unchecked = await executor.execute({ source, cwd: root, check: false });
  assert.equal(unchecked.value, 42);

  const browserGlobal = await executor.check({
    source: "export function main(): string { return document.title; }\n",
  });
  assert.equal(browserGlobal.ok, false);
  assert.ok(browserGlobal.diagnostics.some((diagnostic) => diagnostic.code === 2584));

  const accidentalTypes = await executor.check({
    source: "export function main(): string { return accidentalAmbient; }\n",
  });
  assert.equal(accidentalTypes.ok, false);
  assert.ok(accidentalTypes.diagnostics.some((diagnostic) => diagnostic.code === 2304));
});

test("runtime requires an exported main function", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  await assert.rejects(
    executor.execute({ source: "export const value = 1;\n", cwd: root }),
    /must export a function named "main"/u,
  );
  assert.deepEqual(await workspaceNames(root), []);
});
