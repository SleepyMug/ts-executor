import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  ProcExecutionError,
  ProcExecutor,
  TSFuncExecutor,
} from "../dist/index.js";
import { project, workspaceNames } from "./helpers.js";

test("defaults are the documented constants", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024 * 1024);
  assert.equal(DEFAULT_KILL_GRACE_MS, 2000);
});

test("TSFunc retains at most maxOutputBytes per stream and still returns the value", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    cwd: root,
    maxOutputBytes: 1024,
    source: `
      export function main(): { done: boolean } {
        for (let i = 0; i < 100; i++) process.stdout.write("o".repeat(1024));
        process.stderr.write("short");
        return { done: true };
      }
    `,
  });
  assert.deepEqual(result.value, { done: true });
  assert.equal(Buffer.byteLength(result.stdout), 1024);
  assert.equal(result.stdout, "o".repeat(1024));
  assert.equal(result.stderr, "short");
  assert.deepEqual(result.truncated, { stdout: true, stderr: false });
  assert.deepEqual(await workspaceNames(root), []);
});

test("a guest writing far beyond the default cap completes without blocking", { timeout: 60_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    cwd: root,
    check: false,
    source: `
      export function main() {
        const chunk = "z".repeat(1024 * 1024);
        for (let i = 0; i < 12; i++) process.stdout.write(chunk);
        return "finished";
      }
    `,
  });
  assert.equal(result.value, "finished");
  assert.equal(Buffer.byteLength(result.stdout), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(result.truncated.stdout, true);
});

test("stderr beyond the cap is flagged on the failure path", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  await assert.rejects(
    executor.execute({
      cwd: root,
      maxOutputBytes: 2048,
      source: `
        export function main(): never {
          process.stderr.write("e".repeat(50_000));
          throw new Error("after noisy stderr");
        }
      `,
    }),
    (error) => {
      assert.equal(error.message, "after noisy stderr");
      assert.equal(Buffer.byteLength(error.stderr), 2048);
      assert.deepEqual(error.truncated, { stdout: false, stderr: true });
      return true;
    },
  );
  assert.deepEqual(await workspaceNames(root), []);
});

test("truncation cuts at a byte boundary and decodes without throwing", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    cwd: root,
    check: false,
    maxOutputBytes: 5,
    source: 'export function main() { process.stdout.write("ααα"); return null; }',
  });
  assert.equal(result.truncated.stdout, true);
  assert.equal(result.stdout.startsWith("αα"), true);
});

test("Proc executeDetailed reports truncation while execute refuses an inexact stdout", async (t) => {
  const root = await project(t);
  const executor = new ProcExecutor({ resolutionRoot: root });
  const source = `
    export function main(): void {
      process.stdout.write("0123456789");
      process.stderr.write("x".repeat(64));
    }
  `;
  const detailed = await executor.executeDetailed({ cwd: root, source, maxOutputBytes: 4 });
  assert.equal(detailed.stdout, "0123");
  assert.deepEqual(detailed.truncated, { stdout: true, stderr: true });
  assert.equal(typeof detailed.durationMs, "number");

  await assert.rejects(executor.execute({ cwd: root, source, maxOutputBytes: 4 }), (error) => {
    assert.ok(error instanceof ProcExecutionError);
    assert.equal(error.stdout, "0123");
    assert.deepEqual(error.truncated, { stdout: true, stderr: true });
    assert.equal(error.exitCode, 0);
    assert.match(error.message, /exceeded maxOutputBytes/u);
    return true;
  });

  const exact = await executor.executeDetailed({ cwd: root, source, maxOutputBytes: 10 });
  assert.equal(exact.stdout, "0123456789");
  assert.deepEqual(exact.truncated, { stdout: false, stderr: true });
  assert.equal(await executor.execute({ cwd: root, source, maxOutputBytes: 10 }), "0123456789");

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: 'export function main(): void { process.stderr.write("noise"); throw new Error("boom"); }',
      maxOutputBytes: 2,
    }),
    (error) => error instanceof ProcExecutionError && error.stderr === "no" && error.truncated.stderr === true,
  );
  assert.deepEqual(await workspaceNames(root), []);
});
