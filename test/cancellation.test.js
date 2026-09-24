import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import test from "node:test";
import { ExecutionAbortedError, TSFuncExecutor, hostModule } from "../dist/index.js";
import { alive, collect, deferred, gone, project, watchSpawns, workspaceNames } from "./helpers.js";

const require = createRequire(import.meta.url);
// TypeScript is CommonJS and reads sources through this same module object.
const fs = require("node:fs");

// Resolves with the first complete stdout line; the guest prints it once it is ready.
function firstLine() {
  const line = deferred();
  let text = "";
  return {
    promise: line.promise,
    onStdout(chunk) {
      text += chunk;
      const end = text.indexOf("\n");
      if (end >= 0) line.resolve(text.slice(0, end));
    },
    text: () => text,
  };
}

// A guest that starts a grandchild in its own process group, reports its pid, and never settles.
const hangingSource = `
  import { spawn } from "node:child_process";
  export async function main(): Promise<null> {
    const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
    process.stdout.write(String(sleeper.pid) + "\\n");
    setInterval(() => {}, 1000);
    await new Promise(() => {});
    return null;
  }
`;

test("aborting the signal terminates the guest's process group and rejects with only durationMs", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const controller = new AbortController();
  const ready = firstLine();
  const started = performance.now();
  const execution = executor.execute({
    cwd: root,
    check: false,
    signal: controller.signal,
    onStdout: ready.onStdout,
    source: hangingSource,
  });
  const sleeper = Number(await ready.promise);
  assert.equal(alive(sleeper), true);
  const abortedAt = performance.now();
  controller.abort();
  await assert.rejects(execution, (error) => {
    assert.ok(error instanceof ExecutionAbortedError);
    assert.equal(error.name, "ExecutionAbortedError");
    assert.deepEqual(Object.keys(error).sort(), ["durationMs", "name"]);
    assert.ok(error.durationMs >= abortedAt - started - 5, `duration ${error.durationMs}`);
    assert.ok(error.durationMs <= performance.now() - started);
    return true;
  });
  assert.equal(await gone(sleeper), true, "the grandchild dies with the group");
  assert.deepEqual(await workspaceNames(root), []);
});

test("a caller's deadline is an AbortSignal.timeout combined with its own signal", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const caller = new AbortController();
  const ready = firstLine();
  const started = performance.now();
  const execution = executor.execute({
    cwd: root,
    check: false,
    signal: AbortSignal.any([caller.signal, AbortSignal.timeout(1500)]),
    onStdout: ready.onStdout,
    source: hangingSource,
  });
  const sleeper = Number(await ready.promise);
  await assert.rejects(execution, (error) => {
    assert.ok(error instanceof ExecutionAbortedError);
    assert.ok(error.durationMs >= 1450, `duration ${error.durationMs}`);
    assert.ok(performance.now() - started < 20_000);
    return true;
  });
  assert.equal(caller.signal.aborted, false);
  assert.equal(await gone(sleeper), true);
  assert.deepEqual(await workspaceNames(root), []);
});

test("a guest that ignores SIGTERM is killed after the fixed grace period", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const controller = new AbortController();
  const ready = firstLine();
  const execution = executor.execute({
    cwd: root,
    check: false,
    signal: controller.signal,
    onStdout: ready.onStdout,
    source: `
      export async function main(): Promise<null> {
        process.on("SIGTERM", () => { process.stdout.write("ignored SIGTERM\\n"); });
        setInterval(() => {}, 1000); // keep the event loop alive like a real hung program
        process.stdout.write("ready\\n");
        await new Promise(() => {});
        return null;
      }
    `,
  });
  await ready.promise;
  const aborted = performance.now();
  controller.abort();
  await assert.rejects(execution, (error) => error instanceof ExecutionAbortedError);
  const elapsed = performance.now() - aborted;
  assert.ok(elapsed >= 1900 && elapsed < 6000, `escalated after ${elapsed} ms`);
  assert.equal(ready.text(), "ready\nignored SIGTERM\n");
  assert.deepEqual(await workspaceNames(root), []);
});

test("a pre-aborted signal rejects before any lease, workspace, check, or spawn", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const spawned = watchSpawns(t);
  let materialized = 0;
  executor.modules.register({
    specifier: "@fixture/observed",
    packageRoot: root,
    async materialize() {
      materialized += 1;
      return { packageRoot: root };
    },
  });
  const marker = join(root, "spawned");
  const source = `
    import { writeFileSync } from "node:fs";
    export function main(): null { writeFileSync(${JSON.stringify(marker)}, "yes"); return null; }
  `;
  const controller = new AbortController();
  controller.abort();
  let delivered = 0;
  await assert.rejects(
    executor.execute({ cwd: root, source, signal: controller.signal, onStdout: () => { delivered += 1; } }),
    (error) => error instanceof ExecutionAbortedError && error.durationMs === 0,
  );
  // Even an invalid cwd is not looked at once the signal has aborted.
  await assert.rejects(
    executor.execute({ cwd: "relative", source, signal: controller.signal }),
    (error) => error instanceof ExecutionAbortedError,
  );
  assert.equal(materialized, 0);
  assert.equal(delivered, 0);
  assert.equal(spawned.length, 0);
  await assert.rejects(stat(marker), (error) => error?.code === "ENOENT");
  assert.deepEqual(await workspaceNames(root), []);

  await assert.rejects(
    executor.execute({ cwd: root, source, signal: {} }),
    (error) => error instanceof TypeError && error.message === "execute.signal must be an AbortSignal",
  );
  assert.equal(materialized, 0);
});

test("an abort during workspace preparation spawns no guest, checked or not", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  let controller;
  executor.modules.register({
    specifier: "@fixture/aborting",
    packageRoot: root,
    async materialize() {
      controller.abort();
      return { packageRoot: root };
    },
  });
  const spawned = watchSpawns(t);
  const marker = join(root, "spawned");
  const source = `
    import { writeFileSync } from "node:fs";
    export function main(): null { writeFileSync(${JSON.stringify(marker)}, "yes"); return null; }
  `;
  for (const check of [true, false]) {
    controller = new AbortController();
    await assert.rejects(
      executor.execute({ cwd: root, source, check, signal: controller.signal }),
      (error) => error instanceof ExecutionAbortedError && error.durationMs > 0,
    );
  }
  assert.deepEqual(spawned, []);
  await assert.rejects(stat(marker), (error) => error?.code === "ENOENT");
  assert.deepEqual(await workspaceNames(root), []);
});

test("an abort during type-checking is honoured before spawning", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const marker = join(root, "spawned");
  const controller = new AbortController();
  const originalReadFileSync = fs.readFileSync;
  let checkedSources = 0;
  // Checking is synchronous: abort from inside it, when TypeScript reads the program.
  fs.readFileSync = function readFileSync(path, ...rest) {
    if (String(path).includes(`${sep}runs${sep}`) && String(path).endsWith(`${sep}main.ts`)) {
      checkedSources += 1;
      controller.abort();
    }
    return Reflect.apply(originalReadFileSync, this, [path, ...rest]);
  };
  t.after(() => { fs.readFileSync = originalReadFileSync; });
  await assert.rejects(
    executor.execute({
      cwd: root,
      signal: controller.signal,
      source: `
        import { writeFileSync } from "node:fs";
        export function main(): null { writeFileSync(${JSON.stringify(marker)}, "yes"); return null; }
      `,
    }),
    (error) => error instanceof ExecutionAbortedError && error.durationMs > 0,
  );
  fs.readFileSync = originalReadFileSync;
  assert.equal(checkedSources, 1, "the abort happened while the source was being checked");
  await assert.rejects(stat(marker), (error) => error?.code === "ENOENT");
  assert.deepEqual(await workspaceNames(root), []);
});

test("aborting releases host-module leases so disposal completes", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const controller = new AbortController();
  let signal;
  const module = await hostModule({
    resolutionRoot: root,
    specifier: "@host/abortable",
    declarations: "export declare function ready(): Promise<null>;\n",
    functions: ["ready"],
    call(_fn, _args, context) {
      signal = context.signal;
      // The guest is inside a host call when its execution is aborted.
      controller.abort();
      return null;
    },
  });
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  await assert.rejects(
    executor.execute({
      cwd: root,
      signal: controller.signal,
      source: `
        import { ready } from "@host/abortable";
        export async function main() {
          await ready();
          setInterval(() => {}, 1000);
          await new Promise(() => {});
          return null;
        }
      `,
    }),
    (error) => error instanceof ExecutionAbortedError,
  );
  assert.equal(signal.aborted, true, "the host call's signal ends with the execution");
  await module.dispose();
  await assert.rejects(stat(module.packageRoot), (error) => error?.code === "ENOENT");
  assert.deepEqual(await workspaceNames(root), []);
});

test("an abort closes the host-call channel at once: nothing is dispatched during the grace period", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const controller = new AbortController();
  let calls = 0;
  let callsAtAbort;
  let callSignalAborted;
  const module = await hostModule({
    resolutionRoot: root,
    specifier: "@host/busy",
    declarations: "export declare function tick(): Promise<number>;\n",
    functions: ["tick"],
    call(_fn, _args, context) {
      calls += 1;
      if (calls === 3) {
        controller.abort();
        callsAtAbort = calls;
        callSignalAborted = context.signal.aborted;
      }
      return calls;
    },
  });
  t.after(() => module.dispose());
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const output = collect();
  await assert.rejects(
    executor.execute({
      cwd: root,
      check: false,
      signal: controller.signal,
      ...output.sinks,
      source: `
        import { tick } from "@host/busy";
        export async function main(): Promise<null> {
          process.on("SIGTERM", () => { process.stdout.write("ignored SIGTERM\\n"); });
          for (;;) {
            try { await tick(); } catch { /* a closed channel rejects; keep calling */ }
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }
      `,
    }),
    (error) => error instanceof ExecutionAbortedError,
  );
  assert.equal(callSignalAborted, true, "the running call's signal aborts with the caller's");
  assert.equal(output.stdout(), "ignored SIGTERM\n", "the guest kept running until SIGKILL");
  assert.equal(calls, callsAtAbort, "no call was dispatched after the abort");
  assert.deepEqual(await workspaceNames(root), []);
});

test("an abort that arrives after the guest exited leaves its result intact", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const controller = new AbortController();
  // Runs in the same exit event in which the executor observes the exit.
  watchSpawns(t, (child) => child.once("exit", () => controller.abort()));
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timers();
  const result = await executor.execute({
    cwd: root,
    check: false,
    signal: controller.signal,
    source: "export function main(): number { return 42; }",
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(result.value, 42);
  assert.equal(timers(), before, "no termination was started for the exited guest");
  assert.deepEqual(await workspaceNames(root), []);
});
