import assert from "node:assert/strict";
import { cp, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ProcExecutor, TSFuncExecutor, TypeCheckError, packageModule } from "../dist/index.js";
import { project, workspaceNames, writePackage } from "./helpers.js";

test("module paths expose package interfaces and preserve NodeNext exports and subpaths", async (t) => {
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
    packageModule({
      specifier: "@fixture/math",
      root: relative(process.cwd(), packageRoot),
      description: "Arithmetic.",
    }),
  );

  const modules = await executor.listModules();
  assert.deepEqual(modules, [
    { specifier: "@fixture/math", packageRoot, description: "Arithmetic." },
  ]);
  const listedRoot = modules[0].packageRoot;
  assert.ok(isAbsolute(listedRoot));
  const manifest = JSON.parse(await readFile(join(listedRoot, "package.json"), "utf8"));
  const declarations = await readFile(join(listedRoot, manifest.exports["."].types), "utf8");
  assert.match(declarations, /export \{ add \}/u);
  assert.deepEqual(await workspaceNames(root), []);

  const result = await executor.execute({
    source: `
      import { add } from "@fixture/math/math";
      import type { Legacy as ImportLegacy, Numeric } from "@fixture/math";
      import type { Legacy as RequireLegacy } from "@fixture/math/legacy";
      export function main(input: Numeric): number {
        const imported: ImportLegacy = { mode: "import" };
        const required: RequireLegacy = { mode: "require" };
        void imported;
        void required;
        return add(input, 7);
      }
    `,
    input: 5,
    cwd: root,
  });
  assert.equal(result.value, 12);
  assert.equal(await readFile(join(listedRoot, manifest.exports["."].types), "utf8"), declarations);
  assert.deepEqual(await workspaceNames(root), []);
});

test("untyped packages are discoverable but checked execution rejects their imports", async (t) => {
  const root = await project(t);
  const packageRoot = await writePackage(
    root,
    "@fixture/untyped",
    { "index.js": "export const value = 1;\n" },
    { exports: { ".": "./index.js" } },
  );
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(packageModule({ specifier: "@fixture/untyped", root: packageRoot }));

  assert.deepEqual(await executor.listModules(), [{ specifier: "@fixture/untyped", packageRoot }]);
  await assert.rejects(executor.execute({
    source: 'import { value } from "@fixture/untyped"; export function main() { return value; }',
    cwd: root,
  }), (error) => error instanceof TypeCheckError && error.diagnostics.some(({ code }) => code === 7016));
});

for (const Executor of [TSFuncExecutor, ProcExecutor]) {
  test(`${Executor.name} keeps discovery files while custom runtime packages are created and cleaned per operation`, async (t) => {
    const root = await project(t);
    const declaration = "export function runtimeLocation(): string;\n";
    const discoveryRoot = await writePackage(root, "@fixture/custom", {
      "index.js": "export function runtimeLocation() { return import.meta.url; }\n",
      "index.d.ts": declaration,
    }, { exports: { ".": { types: "./index.d.ts", import: "./index.js" } } });
    const executor = new Executor({ resolutionRoot: root });
    const runtimeRoots = [];
    executor.modules.register({
      specifier: "@fixture/custom",
      packageRoot: discoveryRoot,
      async materialize({ packageRoot, workspaceRoot }) {
        assert.ok(isAbsolute(packageRoot));
        assert.equal(relative(workspaceRoot, packageRoot), join(".modules", "0"));
        await cp(discoveryRoot, packageRoot, { recursive: true });
        runtimeRoots.push(packageRoot);
        return { packageRoot };
      },
    });

    const catalog = await executor.listModules();
    assert.deepEqual(catalog, [{ specifier: "@fixture/custom", packageRoot: discoveryRoot }]);
    assert.equal(runtimeRoots.length, 0);
    const manifest = JSON.parse(await readFile(join(catalog[0].packageRoot, "package.json"), "utf8"));
    const declarationPath = join(catalog[0].packageRoot, manifest.exports["."].types);
    assert.equal(await readFile(declarationPath, "utf8"), declaration);
    const source = `
      import { runtimeLocation } from "@fixture/custom";
      export function main() {
        ${Executor === TSFuncExecutor ? "return runtimeLocation();" : "process.stdout.write(runtimeLocation());"}
      }
    `;
    assert.equal((await executor.check({ source })).ok, true);
    assert.equal(runtimeRoots.length, 1);
    await assert.rejects(stat(runtimeRoots[0]), { code: "ENOENT" });

    for (let run = 0; run < 2; run += 1) {
      const result = await executor.execute({ source, cwd: root });
      const location = Executor === TSFuncExecutor ? result.value : result;
      const runtimeRoot = runtimeRoots.at(-1);
      assert.equal(location, pathToFileURL(join(runtimeRoot, "index.js")).href);
      assert.notEqual(runtimeRoot, discoveryRoot);
      await assert.rejects(stat(runtimeRoot), { code: "ENOENT" });
      assert.equal(await readFile(declarationPath, "utf8"), declaration);
      assert.deepEqual(await executor.listModules(), catalog);
      assert.deepEqual(await workspaceNames(root), []);
    }
    assert.equal(runtimeRoots.length, 3);
    assert.equal(new Set(runtimeRoots).size, 3);
  });

  test(`${Executor.name} lists immutable, filtered package metadata without materializing`, async (t) => {
    const root = await project(t);
    const executor = new Executor({ resolutionRoot: join(root, "no-workspace-root") });
    assert.deepEqual(await executor.listModules(), []);
    const module = {
      specifier: "@fixture/first",
      packageRoot: join(root, "first"),
      description: "Arithmetic helpers.",
      async materialize() { throw new Error("discovery must not materialize"); },
    };
    executor.modules.register(module);
    const pending = executor.listModules();
    module.specifier = "@fixture/changed";
    module.packageRoot = join(root, "changed");
    module.description = "Changed.";
    executor.modules.register({
      specifier: "@fixture/second",
      packageRoot: join(root, "second"),
      materialize: module.materialize,
    });

    const first = { specifier: "@fixture/first", packageRoot: join(root, "first"), description: "Arithmetic helpers." };
    const second = { specifier: "@fixture/second", packageRoot: join(root, "second") };
    const listed = await pending;
    assert.deepEqual(listed, [first]);
    assert.ok(Object.isFrozen(listed));
    assert.ok(Object.isFrozen(listed[0]));
    assert.deepEqual(await executor.listModules(), [first, second]);
    assert.deepEqual(await executor.listModules({ query: "  " }), [first, second]);
    assert.deepEqual(await executor.listModules({ query: " ARITHMETIC " }), [first]);
    assert.deepEqual(await executor.listModules({ query: "SECOND" }), [second]);
    assert.deepEqual(await executor.listModules({ query: "absent" }), []);
    assert.deepEqual(await workspaceNames(root), []);
  });
}

test("custom modules require an absolute package root for discovery", () => {
  const executor = new TSFuncExecutor({ resolutionRoot: process.cwd() });
  for (const packageRoot of [undefined, "", "relative/path", new URL("file:///tmp/")]) {
    assert.throws(() => executor.modules.register({
      specifier: "@fixture/invalid",
      packageRoot,
      async materialize() { return { packageRoot }; },
    }), /requires an absolute packageRoot/u);
  }
});
