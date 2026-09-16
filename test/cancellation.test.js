import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  ExecutionAbortedError,
  ProcExecutor,
  TSFuncExecutor,
  Type,
  hostFunction,
  hostModule,
} from "../dist/index.js";
import { project, workspaceNames } from "./helpers.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(path, "utf8");
      if (text.length > 0) return text;
    } catch {
      // not yet written
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${path}`);
    await delay(20);
  }
}

// A guest that starts a grandchild, records its pid, prints, and never settles.
function hangingSource(Flavor, pidFile) {
  const signature = Flavor === TSFuncExecutor ? "main(): Promise<number>" : "main(): Promise<void>";
  return `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    export async function ${signature} {
      const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
      process.stdout.write("started\\n");
      process.stderr.write("still running\\n");
      // Written last: pipe writes are synchronous on Linux, so the marker proves both lines were delivered.
      writeFileSync(${JSON.stringify(pidFile)}, String(sleeper.pid));
      await new Promise(() => {});
      ${Flavor === TSFuncExecutor ? "return 1;" : ""}
    }
  `;
}

for (const Flavor of [TSFuncExecutor, ProcExecutor]) {
  test(`${Flavor.name}: aborting the signal terminates the guest's process group and cleans up`, { timeout: 30_000 }, async (t) => {
    const root = await project(t);
    const executor = new Flavor({ resolutionRoot: root });
    const pidFile = join(root, "sleeper.pid");
    const controller = new AbortController();
    const started = performance.now();
    const execution = executor.execute({
      cwd: root,
      check: false,
      signal: controller.signal,
      killGraceMs: 500,
      source: hangingSource(Flavor, pidFile),
    });
    const sleeperPid = Number(await waitForFile(pidFile));
    assert.equal(alive(sleeperPid), true);
    controller.abort();
    await assert.rejects(execution, (error) => {
      assert.ok(error instanceof ExecutionAbortedError);
      assert.equal(error.reason, "signal");
      assert.equal(error.stdout, "started\n");
      assert.equal(error.stderr, "still running\n");
      assert.deepEqual(error.truncated, { stdout: false, stderr: false });
      assert.equal(error.exitCode, null);
      assert.equal(error.signal, "SIGTERM");
      assert.ok(error.durationMs >= performance.now() - started - 50 && error.durationMs < 30_000);
      return true;
    });
    assert.equal(alive(sleeperPid), false, "the grandchild must die with the group");
    assert.deepEqual(await workspaceNames(root), []);
  });

  test(`${Flavor.name}: the deadline terminates a guest that never settles`, { timeout: 30_000 }, async (t) => {
    const root = await project(t);
    const executor = new Flavor({ resolutionRoot: root });
    const pidFile = join(root, "sleeper.pid");
    const started = performance.now();
    const execution = executor.execute({
      cwd: root,
      check: false,
      timeoutMs: 1500,
      killGraceMs: 500,
      source: hangingSource(Flavor, pidFile),
    });
    const sleeperPid = Number(await waitForFile(pidFile));
    await assert.rejects(execution, (error) => {
      assert.ok(error instanceof ExecutionAbortedError);
      assert.equal(error.reason, "timeout");
      assert.match(error.message, /exceeded its deadline/u);
      assert.ok(error.durationMs >= 1500, `duration ${error.durationMs}`);
      assert.ok(performance.now() - started < 20_000);
      return true;
    });
    assert.equal(alive(sleeperPid), false);
    assert.deepEqual(await workspaceNames(root), []);
  });

  test(`${Flavor.name}: a SIGTERM-ignoring guest is killed after the grace period`, { timeout: 30_000 }, async (t) => {
    const root = await project(t);
    const executor = new Flavor({ resolutionRoot: root });
    const marker = join(root, "ignoring");
    const controller = new AbortController();
    const execution = executor.execute({
      cwd: root,
      check: false,
      signal: controller.signal,
      killGraceMs: 300,
      source: `
        import { writeFileSync } from "node:fs";
        export async function main(): Promise<void> {
          process.on("SIGTERM", () => { process.stdout.write("ignored SIGTERM\\n"); });
          setInterval(() => {}, 1000); // keep the event loop alive like a real hung program
          writeFileSync(${JSON.stringify(marker)}, "ready");
          await new Promise(() => {});
        }
      `,
    });
    await waitForFile(marker);
    const aborted = performance.now();
    controller.abort();
    await assert.rejects(execution, (error) => {
      assert.ok(error instanceof ExecutionAbortedError);
      assert.equal(error.signal, "SIGKILL");
      assert.equal(error.stdout, "ignored SIGTERM\n");
      return true;
    });
    const elapsed = performance.now() - aborted;
    assert.ok(elapsed >= 250 && elapsed < 5000, `escalated after ${elapsed} ms`);
    assert.deepEqual(await workspaceNames(root), []);
  });

  test(`${Flavor.name}: a pre-aborted signal and invalid limits reject before any spawn`, async (t) => {
    const root = await project(t);
    const executor = new Flavor({ resolutionRoot: root });
    const marker = join(root, "spawned");
    const source = `
      import { writeFileSync } from "node:fs";
      export function main(): void { writeFileSync(${JSON.stringify(marker)}, "yes"); }
    `;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(executor.execute({ cwd: root, source, signal: controller.signal }), (error) => {
      assert.ok(error instanceof ExecutionAbortedError);
      assert.equal(error.reason, "signal");
      assert.equal(error.stdout, "");
      assert.equal(error.exitCode, null);
      return true;
    });
    await assert.rejects(stat(marker), (error) => error?.code === "ENOENT");
    assert.deepEqual(await workspaceNames(root), []);

    for (const [field, value] of [
      ["timeoutMs", 0],
      ["timeoutMs", 1.5],
      ["maxOutputBytes", -1],
      ["killGraceMs", "2000"],
      ["signal", {}],
    ]) {
      await assert.rejects(
        executor.execute({ cwd: root, source, [field]: value }),
        (error) => error instanceof TypeError && error.message.includes(field),
      );
    }
    await assert.rejects(stat(marker), (error) => error?.code === "ENOENT");
  });
}

for (const Flavor of [TSFuncExecutor, ProcExecutor]) {
  test(`${Flavor.name}: killGroupOnExit reaps children left behind by a normal exit; default keeps them`, { timeout: 30_000 }, async (t) => {
    const root = await project(t);
    const executor = new Flavor({ resolutionRoot: root });
    const source = (pidFile) => `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      export function ${Flavor === TSFuncExecutor ? "main(): number" : "main(): void"} {
        const child = spawn("sleep", ["300"], { stdio: "ignore" });
        child.unref();
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        ${Flavor === TSFuncExecutor ? "return 1;" : ""}
      }
    `;

    const keptFile = join(root, "kept.pid");
    await executor.execute({ cwd: root, check: false, source: source(keptFile) });
    const keptPid = Number(await readFile(keptFile, "utf8"));
    t.after(() => { try { process.kill(keptPid, "SIGKILL"); } catch { /* already gone */ } });
    assert.equal(alive(keptPid), true, "0.2.0 semantics: a normal exit leaves children alone");

    const reapedFile = join(root, "reaped.pid");
    await executor.execute({ cwd: root, check: false, killGroupOnExit: true, source: source(reapedFile) });
    const reapedPid = Number(await readFile(reapedFile, "utf8"));
    await delay(50);
    assert.equal(alive(reapedPid), false, "killGroupOnExit must reap the leftover child");
    assert.deepEqual(await workspaceNames(root), []);

    await assert.rejects(
      executor.execute({ cwd: root, source: source(reapedFile), killGroupOnExit: "yes" }),
      (error) => error instanceof TypeError && error.message.includes("killGroupOnExit"),
    );
  });
}

test("aborting releases host-module leases so disposal completes", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const module = await hostModule({
    resolutionRoot: root,
    specifier: "@host/abortable",
    functions: {
      ready: hostFunction({ input: Type.Null(), output: Type.Null(), handler: () => null }),
    },
  });
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const marker = join(root, "called");
  const controller = new AbortController();
  const execution = executor.execute({
    cwd: root,
    check: false,
    signal: controller.signal,
    killGraceMs: 300,
    source: `
      import { writeFileSync } from "node:fs";
      import { ready } from "@host/abortable";
      export async function main() {
        await ready(null);
        writeFileSync(${JSON.stringify(marker)}, "called");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
        return null;
      }
    `,
  });
  await waitForFile(marker);
  controller.abort();
  await assert.rejects(execution, (error) => error instanceof ExecutionAbortedError);
  let disposed = false;
  const disposal = module.dispose().then(() => { disposed = true; });
  await Promise.race([disposal, delay(5000)]);
  assert.equal(disposed, true, "dispose must not wait on a released lease");
  await assert.rejects(stat(module.packageRoot), (error) => error?.code === "ENOENT");
  assert.deepEqual(await workspaceNames(root), []);
});

test("a deadline that passes during checking rejects before spawning", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const marker = join(root, "spawned");
  await assert.rejects(
    executor.execute({
      cwd: root,
      timeoutMs: 1,
      source: `
        import { writeFileSync } from "node:fs";
        export function main(): null { writeFileSync(${JSON.stringify(marker)}, "yes"); return null; }
      `,
    }),
    (error) => error instanceof ExecutionAbortedError && error.reason === "timeout" && error.exitCode === null,
  );
  await assert.rejects(stat(marker), (error) => error?.code === "ENOENT");
  assert.deepEqual(await workspaceNames(root), []);
});
