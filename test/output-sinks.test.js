import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionAbortedError, TSFuncExecutor, hostModule } from "../dist/index.js";
import { collect, deferred, gone, project, workspaceNames } from "./helpers.js";

test("sinks receive text in write order, and a character split across writes arrives whole", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const firstChunk = deferred();
  const gate = await hostModule({
    resolutionRoot: root,
    specifier: "@fixture/gate",
    declarations: "export declare function afterFirstChunk(): Promise<null>;\n",
    functions: ["afterFirstChunk"],
    // Resolves once the host has delivered the first chunk, so the guest's second
    // write cannot be merged with its first one in the pipe.
    call: async () => {
      await firstChunk.promise;
      return null;
    },
  });
  t.after(() => gate.dispose());
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(gate);
  const output = collect();
  const result = await executor.execute({
    cwd: root,
    onStdout: (text) => {
      output.sinks.onStdout(text);
      firstChunk.resolve();
    },
    onStderr: output.sinks.onStderr,
    source: `
      import { afterFirstChunk } from "@fixture/gate";
      export async function main(): Promise<null> {
        // "a", then "€" (E2 82 AC) split between two writes, then "b".
        process.stdout.write(Buffer.from([0x61, 0xe2]));
        await afterFirstChunk();
        process.stdout.write(Buffer.from([0x82, 0xac, 0x62]));
        process.stderr.write("日本");
        return null;
      }
    `,
  });
  assert.equal(result.value, null);
  assert.deepEqual(output.chunks.stdout, ["a", "€b"], "the partial character is held back, not replaced");
  assert.equal(output.stderr(), "日本");
  assert.deepEqual(await workspaceNames(root), []);
});

test("a trailing incomplete character is delivered as U+FFFD when the stream ends", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const output = collect();
  await executor.execute({
    cwd: root,
    check: false,
    ...output.sinks,
    source: "export function main() { process.stdout.write(Buffer.from([0x6f, 0x6b, 0xe2, 0x82])); return null; }",
  });
  assert.equal(output.stdout(), "ok\uFFFD");
});

test("a stream without a sink is not piped at all, and its output cannot block the guest", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const source = `
    import { fstatSync } from "node:fs";
    export function main() {
      // Far beyond a pipe's capacity: a stream nobody drained would block here.
      process.stdout.write("o".repeat(4 * 1024 * 1024));
      process.stderr.write("e".repeat(4 * 1024 * 1024));
      // libuv pipes are socket pairs; "ignore" is /dev/null.
      const kind = (fd: number) => {
        const info = fstatSync(fd);
        if (info.isSocket() || info.isFIFO()) return "piped";
        return info.isCharacterDevice() ? "character device" : "other";
      };
      return { stdout: kind(1), stderr: kind(2) };
    }
  `;
  const none = await executor.execute({ cwd: root, check: false, source });
  assert.deepEqual(none.value, { stdout: "character device", stderr: "character device" });

  let stdoutBytes = 0;
  const onlyStdout = await executor.execute({
    cwd: root,
    check: false,
    source,
    onStdout: (text) => { stdoutBytes += text.length; },
  });
  assert.deepEqual(onlyStdout.value, { stdout: "piped", stderr: "character device" });
  assert.equal(stdoutBytes, 4 * 1024 * 1024);

  let stderrBytes = 0;
  const onlyStderr = await executor.execute({
    cwd: root,
    check: false,
    source,
    onStderr: (text) => { stderrBytes += text.length; },
  });
  assert.deepEqual(onlyStderr.value, { stdout: "character device", stderr: "piped" });
  assert.equal(stderrBytes, 4 * 1024 * 1024);
  assert.deepEqual(await workspaceNames(root), []);
});

for (const stream of ["stdout", "stderr"]) {
  test(`a throwing ${stream} sink aborts the execution, which rejects with the sink's error`, { timeout: 30_000 }, async (t) => {
    const root = await project(t);
    const executor = new TSFuncExecutor({ resolutionRoot: root });
    const failure = new Error(`${stream} sink failed`);
    const received = [];
    const sink = (text) => {
      received.push(text);
      throw failure;
    };
    await assert.rejects(
      executor.execute({
        cwd: root,
        check: false,
        [stream === "stdout" ? "onStdout" : "onStderr"]: sink,
        source: `
          import { spawn } from "node:child_process";
          export async function main(): Promise<null> {
            const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
            process.${stream}.write(String(sleeper.pid) + "\\n");
            setInterval(() => process.${stream}.write("tick\\n"), 5);
            await new Promise(() => {});
            return null;
          }
        `,
      }),
      (error) => {
        assert.equal(error, failure);
        assert.equal(error instanceof ExecutionAbortedError, false);
        return true;
      },
    );
    assert.equal(received.length, 1, "a sink that threw receives nothing further");
    const sleeper = Number(/^(\d+)\n/u.exec(received[0])[1]);
    assert.equal(await gone(sleeper), true, "the guest's process group was terminated");
    assert.deepEqual(await workspaceNames(root), []);
  });
}

test("a non-Error thrown by a sink becomes an Error", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  await assert.rejects(
    executor.execute({
      cwd: root,
      check: false,
      onStdout: () => { throw "plain string"; },
      source: 'export function main() { console.log("x"); return null; }',
    }),
    (error) => error instanceof Error && error.message === "plain string",
  );
});

test("a sink failing on the final flush still rejects, and arms no kill timer after the child is reaped", { timeout: 30_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const failure = new Error("sink failed on the trailing replacement character");
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timers();
  await assert.rejects(
    executor.execute({
      cwd: root,
      check: false,
      onStdout: (text) => {
        if (text.includes("\uFFFD")) throw failure;
      },
      source: "export function main() { process.stdout.write(Buffer.from([0x6f, 0x6b, 0xe2])); return null; }",
    }),
    (error) => error === failure,
  );
  assert.equal(timers(), before, "no SIGKILL escalation is left pending for an already reaped group");
  assert.deepEqual(await workspaceNames(root), []);
});

test("sinks must be functions and are validated before any work", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const source = "export function main() { return null; }";
  for (const [field, value] of [["onStdout", "yes"], ["onStderr", 1], ["onStdout", null]]) {
    await assert.rejects(
      executor.execute({ cwd: root, source, [field]: value }),
      (error) => error instanceof TypeError && error.message === `execute.${field} must be a function`,
    );
  }
  assert.deepEqual(await workspaceNames(root), []);
});
