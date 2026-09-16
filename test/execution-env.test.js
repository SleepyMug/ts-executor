import assert from "node:assert/strict";
import test from "node:test";
import { ProcExecutor, TSFuncExecutor } from "../dist/index.js";
import { project, workspaceNames } from "./helpers.js";

const READ_ENV = `
  export function main(input: { name: string }) {
    return { value: process.env[input.name] ?? null };
  }
`;

test("env adds variables for one guest without touching the host", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    source: READ_ENV,
    cwd: root,
    input: { name: "AGUI_RUN" },
    env: { AGUI_RUN: "call-1" },
  });
  assert.deepEqual(result.value, { value: "call-1" });
  assert.equal(process.env.AGUI_RUN, undefined, "the host environment is unchanged");

  const without = await executor.execute({ source: READ_ENV, cwd: root, input: { name: "AGUI_RUN" } });
  assert.deepEqual(without.value, { value: null }, "the variable does not leak into a later execution");
});

test("concurrent executions each see only their own env", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const [first, second, third] = await Promise.all([
    executor.execute({ source: READ_ENV, cwd: root, input: { name: "AGUI_RUN" }, env: { AGUI_RUN: "a" } }),
    executor.execute({ source: READ_ENV, cwd: root, input: { name: "AGUI_RUN" }, env: { AGUI_RUN: "b" } }),
    executor.execute({ source: READ_ENV, cwd: root, input: { name: "AGUI_RUN" } }),
  ]);
  assert.deepEqual(first.value, { value: "a" });
  assert.deepEqual(second.value, { value: "b" });
  assert.deepEqual(third.value, { value: null });
  assert.equal(process.env.AGUI_RUN, undefined);
});

test("env shadows an inherited value for that guest only", async (t) => {
  const root = await project(t);
  process.env.TS_EXECUTOR_ENV_PROBE = "inherited";
  t.after(() => {
    delete process.env.TS_EXECUTOR_ENV_PROBE;
  });
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const shadowed = await executor.execute({
    source: READ_ENV,
    cwd: root,
    input: { name: "TS_EXECUTOR_ENV_PROBE" },
    env: { TS_EXECUTOR_ENV_PROBE: "per-run" },
  });
  assert.deepEqual(shadowed.value, { value: "per-run" });
  const plain = await executor.execute({ source: READ_ENV, cwd: root, input: { name: "TS_EXECUTOR_ENV_PROBE" } });
  assert.deepEqual(plain.value, { value: "inherited" }, "inherited variables are still inherited");
  assert.equal(process.env.TS_EXECUTOR_ENV_PROBE, "inherited");
});

test("env cannot override the executor's own variables, and the guest keeps resolving", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  for (const name of ["TSX_TSCONFIG_PATH", "__TS_EXECUTOR_RESTORE_ENVIRONMENT"]) {
    await assert.rejects(
      executor.execute({ source: READ_ENV, cwd: root, input: { name }, env: { [name]: "/tmp/hijacked" } }),
      (error) => error instanceof TypeError && /may not override the executor's own/u.test(error.message),
      `${name} must be rejected`,
    );
  }
  assert.deepEqual(await workspaceNames(root), [], "a rejected control creates no workspace");
  const after = await executor.execute({ source: READ_ENV, cwd: root, input: { name: "PATH" } });
  assert.equal(typeof after.value.value, "string", "the executor still works after a rejection");
});

test("env rejects values that cannot be environment entries", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const bad = [
    [{ "": "x" }, /not a valid variable name/u],
    [{ "A=B": "x" }, /not a valid variable name/u],
    [{ "A\0B": "x" }, /not a valid variable name/u],
    [{ A: 1 }, /must be a string without NUL/u],
    [{ A: "x\0y" }, /must be a string without NUL/u],
  ];
  for (const [env, pattern] of bad) {
    await assert.rejects(
      executor.execute({ source: READ_ENV, cwd: root, input: { name: "A" }, env }),
      (error) => error instanceof TypeError && pattern.test(error.message),
      `${JSON.stringify(env)} must be rejected`,
    );
  }
  await assert.rejects(
    executor.execute({ source: READ_ENV, cwd: root, input: { name: "A" }, env: ["A"] }),
    (error) => error instanceof TypeError && /must be an object of string values/u.test(error.message),
  );
});

test("ProcExecutor takes env on the same terms", async (t) => {
  const root = await project(t);
  const executor = new ProcExecutor({ resolutionRoot: root });
  const stdout = await executor.execute({
    source: `
      export function main(): void {
        process.stdout.write(process.env.AGUI_RUN ?? "none");
      }
    `,
    cwd: root,
    env: { AGUI_RUN: "proc-1" },
  });
  assert.equal(stdout, "proc-1");
  assert.equal(process.env.AGUI_RUN, undefined);
});
