import assert from "node:assert/strict";
import test from "node:test";
import { TSFuncExecutor, packageModule } from "../dist/index.js";
import { project, writePackage } from "./helpers.js";

test("physical packages preserve exports, subpaths, and transitive declaration trees", async (t) => {
  const root = await project(t);
  const packageRoot = await writePackage(
    root,
    "@fixture/math",
    {
      "dist/index.js": "export { add } from './math.js';\n",
      "dist/math.js": "export function add(left, right) { return left + right; }\n",
      "types/index.d.ts": "export { add } from './math.js';\nexport type { Numeric } from './numbers.js';\nexport type { Legacy } from '@fixture/math/internal';\n",
      "types/math.d.ts": "import type { Numeric } from './numbers.js';\nexport function add(left: Numeric, right: Numeric): number;\n",
      "types/numbers.d.ts": "export type Numeric = number;\n",
      "types/legacy.d.cts": "import inner = require('@fixture/math/internal');\nexport type Legacy = inner.Legacy;\n",
      "types/import.d.mts": "export interface Legacy { readonly mode: 'import'; }\n",
      "types/require.d.cts": "export interface Legacy { readonly mode: 'require'; }\n",
    },
    {
      exports: {
        ".": { types: "./types/index.d.ts", import: "./dist/index.js" },
        "./math": { types: "./types/math.d.ts", import: "./dist/math.js" },
        "./legacy": { types: "./types/legacy.d.cts", import: "./dist/index.js" },
        "./internal": {
          import: { types: "./types/import.d.mts", default: "./dist/index.js" },
          require: { types: "./types/require.d.cts", default: "./dist/index.js" }
        },
      },
    },
  );
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(
    packageModule({ specifier: "@fixture/math", root: packageRoot, description: "Arithmetic." }),
  );

  const rootTypes = await executor.getTypes("@fixture/math");
  assert.equal(rootTypes.entrypoint, "types/index.d.ts");
  assert.deepEqual(Object.keys(rootTypes.files), [
    "types/index.d.ts",
    "types/math.d.ts",
    "types/numbers.d.ts",
    "types/import.d.mts",
  ]);

  const subpathTypes = await executor.getTypes("@fixture/math/math");
  assert.equal(subpathTypes.entrypoint, "types/math.d.ts");
  assert.deepEqual(Object.keys(subpathTypes.files), ["types/math.d.ts", "types/numbers.d.ts"]);

  const legacyTypes = await executor.getTypes("@fixture/math/legacy");
  assert.deepEqual(Object.keys(legacyTypes.files), [
    "types/legacy.d.cts",
    "types/require.d.cts",
  ]);

  const result = await executor.execute({
    source: `
      import { add } from "@fixture/math/math";
      export function main(input: number): number { return add(input, 7); }
    `,
    input: 5,
    cwd: root,
  });
  assert.equal(result.value, 12);
  assert.deepEqual(await executor.listModules(), [
    { specifier: "@fixture/math", description: "Arithmetic." },
  ]);
});

test("declaration discovery rejects an untyped package", async (t) => {
  const root = await project(t);
  const packageRoot = await writePackage(
    root,
    "@fixture/untyped",
    { "index.js": "export const value = 1;\n" },
    { exports: { ".": "./index.js" } },
  );
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(packageModule({ specifier: "@fixture/untyped", root: packageRoot }));

  await assert.rejects(
    executor.getTypes("@fixture/untyped"),
    /No package-owned TypeScript declaration entrypoint was found/u,
  );
});
