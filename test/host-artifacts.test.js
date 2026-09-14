import assert from "node:assert/strict";
import { readdir, rm, stat } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { hostFunction, hostModule, Type } from "../dist/index.js";
import { project } from "./helpers.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs/promises");

for (const stage of ["chmod", "package.json", "index.d.ts", "index.js"]) {
  test(`host artifact generation cleans partial packages after ${stage} failure`, async t => {
    const root = await project(t);
    const originalWrite = fs.writeFile;
    const originalChmod = fs.chmod;
    const failure = new Error(`failed ${stage}`);
    fs.writeFile = async (path, ...args) => {
      if (basename(dirname(String(path))).startsWith("module-") && basename(String(path)) === stage) throw failure;
      return originalWrite(path, ...args);
    };
    fs.chmod = async (path, ...args) => {
      if (stage === "chmod" && basename(String(path)).startsWith("module-")) throw failure;
      return originalChmod(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(hostModule({
        resolutionRoot: root, specifier: "@host/failure",
        functions: { call: hostFunction({ input: Type.Null(), output: Type.Null(), handler: () => null }) },
      }), error => error === failure);
      assert.deepEqual(await readdir(join(root, ".ts-executor", "modules")), []);
    } finally {
      fs.writeFile = originalWrite;
      fs.chmod = originalChmod;
      syncBuiltinESMExports();
    }
  });
}

for (const frozen of [false, true]) {
  test(`host artifact cleanup failure preserves the ${frozen ? "frozen" : "mutable"} primary error`, async t => {
    const root = await project(t);
    const originalWrite = fs.writeFile;
    const originalRm = fs.rm;
    const failure = new Error("primary write failure");
    if (frozen) Object.freeze(failure);
    const cleanup = new Error("cleanup failure");
    let packageRoot;
    fs.writeFile = async (path, ...args) => {
      if (basename(String(path)) === "index.d.ts") {
        packageRoot = dirname(String(path));
        throw failure;
      }
      return originalWrite(path, ...args);
    };
    fs.rm = async (path, ...args) => {
      if (String(path) === packageRoot) throw cleanup;
      return originalRm(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(hostModule({
        resolutionRoot: root, specifier: "@host/failure", functions: {},
      }), error => error === failure);
      if (!frozen) assert.equal(failure.cleanupError, cleanup);
    } finally {
      fs.writeFile = originalWrite;
      fs.rm = originalRm;
      syncBuiltinESMExports();
      if (packageRoot) await rm(packageRoot, { recursive: true, force: true });
    }
  });
}

test("independent concurrent factories own different artifacts even for the same contract", async t => {
  const root = await project(t);
  const options = {
    resolutionRoot: root, specifier: "@host/independent",
    functions: { identity: hostFunction({ input: Type.String(), output: Type.String(), handler: value => value }) },
  };
  const modules = await Promise.all([hostModule(options), hostModule(options)]);
  try {
    assert.notEqual(modules[0].packageRoot, modules[1].packageRoot);
    await modules[0].dispose();
    assert.equal((await stat(join(modules[1].packageRoot, "index.d.ts"))).isFile(), true);
  } finally {
    await Promise.all(modules.map(module => module.dispose()));
  }
});
