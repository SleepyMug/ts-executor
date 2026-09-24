import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { inputEnvelopeJson, parseResultEnvelope } from "../dist/json-value.js";
import { resolveControl } from "../dist/control.js";
import { runTSFuncProcess } from "../dist/runtime/run-ts-func.js";
import { prepareWorkspace, removeWorkspace } from "../dist/workspace.js";
import { project, workspaceNames } from "./helpers.js";

const require = createRequire(import.meta.url);
const fsPromises = require("node:fs/promises");
const control = () => resolveControl({}, performance.now());

test("workspace initialization settles sibling writes before cleanup and preserves failures", async (t) => {
  const root = await project(t);
  const originalWriteFile = fsPromises.writeFile;
  const originalRm = fsPromises.rm;
  const initializationFailure = new Error("initialization failed");
  const cleanupFailure = new Error("initialization cleanup failed");
  let operationRoot;
  let cleanupStarted = false;
  let markMainStarted;
  let releaseMain;
  const mainStarted = new Promise((resolve) => {
    markMainStarted = resolve;
  });
  const mainRelease = new Promise((resolve) => {
    releaseMain = resolve;
  });

  fsPromises.writeFile = async (path, ...args) => {
    const target = String(path);
    const parent = dirname(target);
    if (basename(dirname(parent)) === "runs" && basename(parent).startsWith("run-")) {
      operationRoot ??= parent;
      if (basename(target) === "package.json") throw initializationFailure;
      if (basename(target) === "main.ts") {
        markMainStarted();
        await mainRelease;
      }
    }
    return originalWriteFile(path, ...args);
  };
  fsPromises.rm = async (path, ...args) => {
    if (String(path) === operationRoot) {
      cleanupStarted = true;
      throw cleanupFailure;
    }
    return originalRm(path, ...args);
  };
  syncBuiltinESMExports();

  const observed = prepareWorkspace(
    root,
    [],
    "export function main(): null { return null; }\n",
  ).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );

  try {
    await mainStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleanupStarted, false);

    releaseMain();
    const result = await observed;
    assert.equal(result.status, "rejected");
    assert.equal(result.error, initializationFailure);
    assert.equal(result.error.cleanupError, cleanupFailure);
    assert.equal(cleanupStarted, true);
  } finally {
    releaseMain();
    fsPromises.writeFile = originalWriteFile;
    fsPromises.rm = originalRm;
    syncBuiltinESMExports();
    await observed;
    if (operationRoot !== undefined) {
      await originalRm(operationRoot, { recursive: true, force: true });
    }
  }
  assert.deepEqual(await workspaceNames(root), []);
});

test("spawn failures reject with the spawn error and leave cleanup to the executor", async (t) => {
  const root = await project(t);
  const workspace = await prepareWorkspace(
    root,
    [],
    "export function main(): null { return null; }\n",
  );
  try {
    await assert.rejects(
      runTSFuncProcess(workspace, `${root}/missing-cwd`, inputEnvelopeJson(false, undefined), control()),
      (error) => {
        assert.equal(error?.code, "ENOENT");
        assert.equal(Object.hasOwn(error, "stdout"), false, "errors carry no captured output");
        return true;
      },
    );
  } finally {
    await removeWorkspace(workspace);
  }
  assert.deepEqual(await workspaceNames(root), []);
});

test("TSFunc runtime uses private files and atomically replaces the temporary result", async (t) => {
  const root = await project(t);
  const workspace = await prepareWorkspace(
    root,
    [],
    `
      export function main(input: { value: number }) {
        return { value: input.value + 1 };
      }
    `,
  );

  try {
    const result = await runTSFuncProcess(
      workspace,
      root,
      inputEnvelopeJson(true, { value: 6 }),
      control(),
    );
    const input = join(workspace.root, "input.json");
    const resultPath = join(workspace.root, "result.json");
    const resultTemporary = join(workspace.root, "result.tmp");
    assert.deepEqual(result, { value: 7 }, "the runner returns the JSON value itself");
    assert.deepEqual(parseResultEnvelope(await readFile(resultPath, "utf8")), {
      ok: true,
      value: { value: 7 },
    });
    await assert.rejects(stat(resultTemporary), (error) => error?.code === "ENOENT");
    for (const name of ["stdout.log", "stderr.log", "proc-status.json"]) {
      await assert.rejects(stat(join(workspace.root, name)), (error) => error?.code === "ENOENT");
    }

    if (process.platform !== "win32") {
      assert.equal((await stat(workspace.root)).mode & 0o777, 0o700);
      for (const path of [
        workspace.entrypoint,
        workspace.tsconfig,
        input,
        resultPath,
      ]) {
        assert.equal((await stat(path)).mode & 0o777, 0o600, path);
      }
    }
  } finally {
    await removeWorkspace(workspace);
  }
  assert.deepEqual(await workspaceNames(root), []);
});
