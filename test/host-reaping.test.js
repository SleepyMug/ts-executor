import assert from "node:assert/strict";
import { writeFile, stat } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { hostModule, TSFuncExecutor } from "../dist/index.js";
import { alive, collect, gone, project, workspaceNames } from "./helpers.js";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

// Starts a `sleep` the host test must see die (same process group) or survive (own session).
function sleeperSource({ detached = false, fail = false } = {}) {
  return `
    import { spawn } from "node:child_process";
    export function main(): number {
      // Inherits stdout and stderr, so it also holds the output pipes open.
      const sleeper = spawn("sleep", ["300"], { stdio: ["ignore", 1, 2], detached: ${detached} });
      sleeper.unref();
      process.stdout.write(String(sleeper.pid) + "\\n");
      ${fail ? 'throw new Error("guest failed after starting a process");' : "return sleeper.pid!;"}
    }
  `;
}

test("whatever the guest leaves in its process group is killed after a normal exit", { timeout: 20_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const output = collect();
  const result = await executor.execute({ cwd: root, check: false, source: sleeperSource(), ...output.sinks });
  t.after(() => { try { process.kill(result.value, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(output.stdout(), `${result.value}\n`);
  assert.equal(await gone(result.value), true, "the leftover child is reaped without being asked");
  assert.deepEqual(await workspaceNames(root), []);
});

test("the process group is also killed when the guest fails", { timeout: 20_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const output = collect();
  await assert.rejects(
    executor.execute({ cwd: root, check: false, source: sleeperSource({ fail: true }), ...output.sinks }),
    /guest failed after starting a process/u,
  );
  const pid = Number(output.stdout());
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(await gone(pid), true);
  assert.deepEqual(await workspaceNames(root), []);
});

test("a descendant that moved to its own session is out of reach", { timeout: 20_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({ cwd: root, check: false, source: sleeperSource({ detached: true }) });
  t.after(() => { try { process.kill(result.value, "SIGKILL"); } catch { /* already gone */ } });
  assert.equal(alive(result.value), true);
});

test("post-spawn IPC errors retain the child, workspace, and module lease until exit", { timeout: 20_000 }, async t => {
  const root = await project(t);
  const module = await hostModule({
    resolutionRoot: root,
    specifier: "@host/reaping",
    declarations: "export declare function noop(): Promise<null>;\n",
    functions: ["noop"],
    call: () => null,
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
  const output = collect();
  const execution = executor.execute({
    cwd: root,
    check: false,
    ...output.sinks,
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
    assert.equal(output.stdout(), "child completed before cleanup\n", "output is delivered until the child exits");
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
