import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ProcExecutionError,
  ProcExecutor,
  TypeCheckError,
  packageModule,
} from "../dist/index.js";
import { project, workspaceNames, writePackage } from "./helpers.js";

test("ProcExecutor returns exact stdout for sync and async main and discards successful stderr", async (t) => {
  const root = await project(t);
  const executor = new ProcExecutor({ resolutionRoot: root });

  const synchronous = await executor.execute({
    cwd: root,
    source: `
      export function main(): void {
        process.stdout.write("first\\n");
        process.stderr.write("not part of stdout\\n");
        process.stdout.write("last");
      }
    `,
  });
  const asynchronous = await executor.execute({
    cwd: pathToFileURL(root),
    source: `
      export async function main(): Promise<void> {
        await Promise.resolve();
        process.stdout.write("async α");
      }
    `,
  });

  assert.equal(synchronous, "first\nlast");
  assert.equal(asynchronous, "async α");
  assert.deepEqual(await workspaceNames(root), []);
});

test("ProcExecutor shares module discovery, NodeNext checking, and a fresh physical package graph", async (t) => {
  const root = await project(t);
  const packageRoot = await writePackage(
    root,
    "@fixture/proc-state",
    {
      "index.js": "let count = 0; export function bump() { return ++count; }\n",
      "index.d.ts": "export function bump(): number;\n",
    },
    { exports: { ".": { types: "./index.d.ts", import: "./index.js" } } },
  );
  const executor = new ProcExecutor({ resolutionRoot: root });
  executor.modules.register(packageModule({
    specifier: "@fixture/proc-state",
    root: packageRoot,
    description: "Proc state fixture.",
  }));

  assert.deepEqual(await executor.listModules({ query: "STATE" }), [
    { specifier: "@fixture/proc-state", description: "Proc state fixture." },
  ]);
  assert.deepEqual(await executor.getTypes("@fixture/proc-state"), {
    entrypoint: "index.d.ts",
    files: { "index.d.ts": "export function bump(): number;\n" },
  });
  const checked = await executor.check({
    source: "export function main(): void { const bad: string = 1; void bad; }\n",
  });
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some((diagnostic) => diagnostic.code === 2322));

  const source = `
    import { bump } from "@fixture/proc-state";
    export function main(): void {
      process.stdout.write(String(bump()));
    }
  `;
  assert.equal(await executor.execute({ source, cwd: root }), "1");
  assert.equal(await executor.execute({ source, cwd: root }), "1");
  assert.deepEqual(await workspaceNames(root), []);
});

test("ProcExecutor checks by default and supports explicitly unchecked execution", async (t) => {
  const root = await project(t);
  const executor = new ProcExecutor({ resolutionRoot: root });
  const source = `
    export function main(): void {
      const value: string = 42;
      process.stdout.write(String(value));
    }
  `;

  await assert.rejects(
    executor.execute({ source, cwd: root }),
    (error) => error instanceof TypeCheckError,
  );
  assert.equal(await executor.execute({ source, cwd: root, check: false }), "42");
});

test("ProcExecutor rejects every returned value with a precise execution error", async (t) => {
  const root = await project(t);
  const executor = new ProcExecutor({ resolutionRoot: root });

  for (const expression of ["null", "0", "''", "{}", "Promise.resolve('value')"]) {
    await assert.rejects(
      executor.execute({
        cwd: root,
        check: false,
        source: `
          export function main(): unknown {
            process.stdout.write("before return");
            process.stderr.write("return detail");
            return ${expression};
          }
        `,
      }),
      (error) => {
        assert.ok(error instanceof ProcExecutionError);
        assert.equal(error.name, "TypeError");
        assert.match(error.message, /must resolve to exactly undefined/u);
        assert.match(error.stack, /must resolve to exactly undefined/u);
        assert.equal(error.stdout, "before return");
        assert.equal(error.stderr, "return detail");
        assert.equal(error.exitCode, 1);
        assert.equal(error.signal, null);
        return true;
      },
    );
  }
  assert.deepEqual(await workspaceNames(root), []);
});

test("ProcExecutionError preserves guest errors and process termination details", async (t) => {
  const root = await project(t);
  const executor = new ProcExecutor({ resolutionRoot: root });

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        export function main(): never {
          console.log("before failure");
          console.error("failure detail");
          throw new RangeError("proc failed");
        }
      `,
    }),
    (error) => {
      assert.ok(error instanceof ProcExecutionError);
      assert.equal(error.name, "RangeError");
      assert.equal(error.message, "proc failed");
      assert.match(error.stack, /proc failed/u);
      assert.equal(error.stdout, "before failure\n");
      assert.equal(error.stderr, "failure detail\n");
      assert.equal(error.exitCode, 1);
      assert.equal(error.signal, null);
      return true;
    },
  );

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        export function main(): never {
          process.stdout.write("early");
          process.exit(7);
        }
      `,
    }),
    (error) => {
      assert.ok(error instanceof ProcExecutionError);
      assert.match(error.message, /code 7 without a valid error status/u);
      assert.equal(error.stdout, "early");
      assert.equal(error.stderr, "");
      assert.equal(error.exitCode, 7);
      assert.equal(error.signal, null);
      return true;
    },
  );

  if (process.platform !== "win32") {
    await assert.rejects(
      executor.execute({
        cwd: root,
        source: `
          export function main(): never {
            process.stderr.write("signalled");
            process.kill(process.pid, "SIGTERM");
            throw new Error("unreachable");
          }
        `,
      }),
      (error) => {
        assert.ok(error instanceof ProcExecutionError);
        assert.match(error.message, /signal SIGTERM/u);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "signalled");
        assert.equal(error.exitCode, null);
        assert.equal(error.signal, "SIGTERM");
        return true;
      },
    );
  }
  assert.deepEqual(await workspaceNames(root), []);
});

test("ProcExecutor requires an absolute existing cwd and cleans operation files", async (t) => {
  const root = await project(t);
  const executor = new ProcExecutor({ resolutionRoot: root });
  const source = `
    export function main(): void {
      process.stdout.write(process.cwd());
    }
  `;
  assert.equal(await executor.execute({ source, cwd: root }), root);
  await assert.rejects(executor.execute({ source, cwd: "relative" }), /must be an absolute/u);
  await assert.rejects(
    executor.execute({ source, cwd: join(root, "missing") }),
    /does not exist/u,
  );
  assert.deepEqual(await workspaceNames(root), []);
});
