import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { inputEnvelopeJson, parseResultEnvelope } from "../dist/json-value.js";
import { resolveControl } from "../dist/limits.js";
import { parseProcStatusEnvelope } from "../dist/proc-status.js";
import { runProcProcess } from "../dist/runtime/run-proc.js";
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

test("spawn failures carry captured output and leave cleanup to the executor", async (t) => {
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
        assert.equal(error?.stdout, "");
        assert.equal(error?.stderr, "");
        return true;
      },
    );
  } finally {
    await removeWorkspace(workspace);
  }
  assert.deepEqual(await workspaceNames(root), []);
});

test("Proc runtime uses only its private status envelope", async (t) => {
  const root = await project(t);
  const workspace = await prepareWorkspace(
    root,
    [],
    `
      export function main(): void {
        process.stdout.write("proc output");
        process.stderr.write("proc detail");
      }
    `,
  );

  try {
    const result = await runProcProcess(workspace, root, control());
    assert.equal(result.stdout, "proc output");
    assert.deepEqual(result.truncated, { stdout: false, stderr: false });
    const statusPath = join(workspace.root, "proc-status.json");
    assert.deepEqual(parseProcStatusEnvelope(await readFile(statusPath, "utf8")), { ok: true });
    await assert.rejects(
      stat(join(workspace.root, "proc-status.tmp")),
      (error) => error?.code === "ENOENT",
    );
    for (const name of ["input.json", "result.json", "result.tmp"]) {
      await assert.rejects(stat(join(workspace.root, name)), (error) => error?.code === "ENOENT");
    }
    if (process.platform !== "win32") {
      assert.equal((await stat(statusPath)).mode & 0o777, 0o600, statusPath);
    }
    for (const name of ["stdout.log", "stderr.log"]) {
      await assert.rejects(stat(join(workspace.root, name)), (error) => error?.code === "ENOENT");
    }
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
    assert.deepEqual(result.value, { value: 7 });
    assert.deepEqual(parseResultEnvelope(await readFile(resultPath, "utf8")), {
      ok: true,
      value: { value: 7 },
    });
    await assert.rejects(stat(resultTemporary), (error) => error?.code === "ENOENT");

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
