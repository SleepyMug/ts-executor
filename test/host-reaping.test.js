import assert from "node:assert/strict";
import { writeFile, stat } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { hostModule, hostFunction, Type, TSFuncExecutor } from "../dist/index.js";
import { project, workspaceNames } from "./helpers.js";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

test("post-spawn IPC errors retain the child, workspace, and module lease until exit", { timeout: 20_000 }, async t => {
  const root = await project(t);
  const module = await hostModule({
    resolutionRoot: root,
    specifier: "@host/reaping",
    functions: { noop: hostFunction({ input: Type.Null(), output: Type.Null(), handler: () => null }) },
  });
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const originalSpawn = childProcess.spawn;
  const injected = new Error("injected post-spawn IPC error");
  let child;
  let markError;
  const errorEmitted = new Promise(resolve => { markError = resolve; });
  childProcess.spawn = (...args) => {
    child = originalSpawn(...args);
    child.once("spawn", () => {
      child.emit("error", injected);
      // A second transport error must not become an unhandled EventEmitter error.
      child.emit("error", new Error("secondary channel failure"));
      markError();
    });
    return child;
  };
  syncBuiltinESMExports();
  let settled = false;
  const execution = executor.execute({
    cwd: root,
    check: false,
    source: `
      import { access } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      export async function main() {
        setTimeout(() => process.exit(124), 10_000).unref();
        for (;;) {
          try { await access("continue"); break; } catch { await delay(10); }
        }
        console.log("child completed before cleanup");
        return null;
      }
    `,
  }).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
  let disposal;
  try {
    await errorEmitted;
    disposal = module.dispose();
    let disposed = false;
    disposal.then(() => { disposed = true; }, () => {});
    await nextTurn();
    assert.equal(settled, false);
    assert.equal(disposed, false);
    assert.equal((await workspaceNames(root)).length, 1);
    assert.equal((await stat(module.packageRoot)).isDirectory(), true);
    await writeFile(join(root, "continue"), "go");
    const result = await execution;
    assert.equal(result.error, injected);
    assert.equal(result.error.stdout, "child completed before cleanup\n");
    assert.equal(child.exitCode, 0);
    await disposal;
    assert.deepEqual(await workspaceNames(root), []);
    await assert.rejects(stat(module.packageRoot), error => error?.code === "ENOENT");
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await execution;
    await (disposal ?? module.dispose());
  }
});
