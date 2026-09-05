import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { TSFuncExecutor, packageModule } from "../dist/index.js";
import { project, workspaceNames, writePackage } from "./helpers.js";

test("execution uses fresh processes, supports sync and async main, captures output, and cleans up", async (t) => {
  const root = await project(t);
  const statePackage = await writePackage(
    root,
    "@fixture/state",
    {
      "index.js": "let count = 0; export function bump() { return ++count; }\n",
      "index.d.ts": "export function bump(): number;\n",
    },
    {
      exports: {
        ".": { types: "./index.d.ts", import: "./index.js" },
      },
    },
  );
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(packageModule({ specifier: "@fixture/state", root: statePackage }));

  const source = `
    import { bump } from "@fixture/state";
    export async function main(input: { label: string }): Promise<number> {
      await Promise.resolve();
      console.log("out:" + input.label);
      console.error("err:" + input.label);
      return bump();
    }
  `;
  const first = await executor.execute({ source, cwd: root, input: { label: "one" } });
  const second = await executor.execute({ source, cwd: root, input: { label: "two" } });
  const synchronous = await executor.execute({
    cwd: root,
    source: "export function main(input: number): number { return input + 1; }\n",
    input: 4,
  });

  assert.equal(first.value, 1);
  assert.equal(second.value, 1);
  assert.equal(synchronous.value, 5);
  assert.equal(first.stdout, "out:one\n");
  assert.equal(first.stderr, "err:one\n");
  assert.equal(second.stdout, "out:two\n");
  assert.equal(second.stderr, "err:two\n");
  assert.ok(first.durationMs > 0);
  assert.deepEqual(await workspaceNames(root), []);
});

test("omitted input calls main(undefined), while supplied values cross as JSON", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });

  const omitted = await executor.execute({
    cwd: root,
    source: `
      export function main(input: unknown) {
        return { omitted: input === undefined };
      }
    `,
  });
  assert.deepEqual(omitted.value, { omitted: true });

  const value = {
    nil: null,
    bool: true,
    number: 3.5,
    text: "snowman ☃",
    list: [1, "two", false, null],
    nested: { okay: true },
  };
  const roundTrip = await executor.execute({
    cwd: root,
    source: "export function main(input: any) { return input; }\n",
    input: value,
  });
  assert.deepEqual(roundTrip.value, value);
  assert.deepEqual(await workspaceNames(root), []);
});

test("guest intrinsic mutations cannot bypass JSON checks or completion", { timeout: 5_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });

  const valid = await executor.execute({
    cwd: root,
    source: `
      export function main() {
        process.stdout.cork();
        process.stdout.write("corked output\\n");
        (JSON as any).stringify = () => '{"forged":true}';
        (Object.prototype as any).toJSON = () => ({ forged: "object" });
        (Array.prototype as any).toJSON = () => ["forged-array"];
        (Promise as any).resolve = () => new Promise(() => {});
        return { okay: true, list: [1, 2] };
      }
    `,
  });
  assert.deepEqual(valid.value, { okay: true, list: [1, 2] });
  assert.equal(valid.stdout, "corked output\n");

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        export function main(): number {
          (Number as any).isFinite = () => true;
          (JSON as any).stringify = () => "null";
          (Object.prototype as any).toJSON = () => null;
          return Number.NaN;
        }
      `,
    }),
    /Execution result.*finite number/u,
  );
});

test("terminal output flush ignores guest-shadowed cork counters and reaps the child", { timeout: 5_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    cwd: root,
    source: `
      export function main(): number {
        process.stdout.write("positive shadow\\n");
        Object.defineProperty(process.stdout, "writableCorked", { value: 1 });

        process.stderr.cork();
        process.stderr.write("zero shadow after cork\\n");
        Object.defineProperty(process.stderr, "writableCorked", { value: 0 });

        setInterval(() => {}, 1_000);
        return process.pid;
      }
    `,
  });

  assert.equal(result.stdout, "positive shadow\n");
  assert.equal(result.stderr, "zero shadow after cork\n");
  assert.throws(
    () => process.kill(result.value, 0),
    (error) => error?.code === "ESRCH",
  );
  assert.deepEqual(await workspaceNames(root), []);
});

test("completed execution exits and reaps the direct subprocess despite retained handles", { timeout: 5_000 }, async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    cwd: root,
    source: `
      export function main(): number {
        (process as any).exit = () => { throw new Error("guest exit replacement"); };
        setInterval(() => {}, 1_000);
        return process.pid;
      }
    `,
  });
  assert.throws(
    () => process.kill(result.value, 0),
    (error) => error?.code === "ESRCH",
  );
  assert.deepEqual(await workspaceNames(root), []);
});

test("large UTF-8 stdout and stderr are exact on success", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    cwd: root,
    source: `
      export function main(): string {
        process.stdout.write("α".repeat(131_072));
        process.stderr.write("β".repeat(131_072));
        return "done";
      }
    `,
  });
  assert.equal(result.value, "done");
  assert.equal(result.stdout, "α".repeat(131_072));
  assert.equal(result.stderr, "β".repeat(131_072));
});

test("descendant-held output descriptors do not delay direct-child completion", { timeout: 8_000 }, async (t) => {
  const root = await project(t);
  const started = join(root, "descendant-started");
  const release = join(root, "descendant-release");
  const finished = join(root, "descendant-finished");
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const result = await executor.execute({
    cwd: root,
    input: { started, release, finished },
    source: `
      import { existsSync } from "node:fs";
      import { spawn } from "node:child_process";

      interface Input {
        readonly started: string;
        readonly release: string;
        readonly finished: string;
      }

      export async function main(input: Input): Promise<string> {
        const childSource = [
          'const fs = require("node:fs");',
          'const paths = JSON.parse(process.argv[1]);',
          'let done = false;',
          'function finish() {',
          '  if (done) return;',
          '  done = true;',
          '  process.stdout.write("late descendant\\\\n");',
          '  fs.writeFileSync(paths.finished, "done");',
          '  process.exit(0);',
          '}',
          'fs.writeFileSync(paths.started, "started");',
          'const interval = setInterval(() => {',
          '  if (fs.existsSync(paths.release)) {',
          '    clearInterval(interval);',
          '    finish();',
          '  }',
          '}, 10);',
          'setTimeout(finish, 2_000);',
        ].join("\\n");
        spawn(process.execPath, ["-e", childSource, JSON.stringify(input)], {
          stdio: ["ignore", 1, 2],
        });
        while (!existsSync(input.started)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        console.log("direct child");
        return "done";
      }
    `,
  });

  assert.equal(result.value, "done");
  assert.equal(result.stdout, "direct child\n");
  await assert.rejects(readFile(finished), (error) => error?.code === "ENOENT");

  await writeFile(release, "release");
  let finishedText;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      finishedText = await readFile(finished, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(finishedText, "done");
  assert.deepEqual(await workspaceNames(root), []);
});

test("user errors retain name, message, stack, and captured output", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        export function main(): never {
          console.log("before failure");
          console.error("failure detail");
          throw new RangeError("runtime failed");
        }
      `,
    }),
    (error) => {
      assert.equal(error?.name, "RangeError");
      assert.equal(error?.message, "runtime failed");
      assert.match(error?.stack, /runtime failed/u);
      assert.equal(error?.stdout, "before failure\n");
      assert.equal(error?.stderr, "failure detail\n");
      return true;
    },
  );
  assert.deepEqual(await workspaceNames(root), []);
});

test("an output-file read failure preserves the peer stream", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        import { unlinkSync, writeSync } from "node:fs";
        import { fileURLToPath } from "node:url";
        export function main(): string {
          writeSync(2, "preserved stderr\\n");
          unlinkSync(fileURLToPath(new URL("./stdout.log", import.meta.url)));
          return "done";
        }
      `,
    }),
    (error) => {
      assert.equal(error?.code, "ENOENT");
      assert.equal(error?.stdout, "");
      assert.equal(error?.stderr, "preserved stderr\n");
      return true;
    },
  );
  assert.deepEqual(await workspaceNames(root), []);
});

test("arbitrary thrown values are reduced to safe errors", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  await assert.rejects(
    executor.execute({
      cwd: root,
      source: "export function main(): never { throw Object.create(null); }\n",
    }),
    (error) => error?.name === "Error" && error?.message === "Non-Error value thrown: [unprintable]",
  );
});

test("early exits, malformed result files, and signals are process failures with output", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        export function main(): never {
          console.log("early");
          process.exit(0);
        }
      `,
    }),
    (error) => {
      assert.match(error?.message, /code 0 without a valid success result/u);
      assert.equal(error?.stdout, "early\n");
      assert.equal(error?.stderr, "");
      return true;
    },
  );

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        import { writeFileSync } from "node:fs";
        export function main(): never {
          writeFileSync(process.argv[4]!, "{not-json", "utf8");
          process.exit(3);
        }
      `,
    }),
    (error) => /code 3 without a valid error result/u.test(error?.message)
      && /not valid JSON/u.test(error?.cause?.message),
  );

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        import { writeFileSync } from "node:fs";
        export function main(): never {
          writeFileSync(process.argv[4]!, JSON.stringify({
            ok: false,
            error: { name: "Error", message: "forged error" },
          }));
          process.exit(0);
        }
      `,
    }),
    /code 0 without a valid success result/u,
  );

  await assert.rejects(
    executor.execute({
      cwd: root,
      source: `
        import { writeFileSync } from "node:fs";
        export function main(): never {
          writeFileSync(process.argv[4]!, JSON.stringify({ ok: true, value: "forged success" }));
          process.exit(4);
        }
      `,
    }),
    /code 4 without a valid error result/u,
  );

  if (process.platform !== "win32") {
    await assert.rejects(
      executor.execute({
        cwd: root,
        source: `
          import { writeSync } from "node:fs";
          export function main(): never {
            writeSync(2, "signalled\\n");
            process.kill(process.pid, "SIGTERM");
            throw new Error("unreachable");
          }
        `,
      }),
      (error) => {
        assert.match(error?.message, /signal SIGTERM/u);
        assert.equal(error?.stderr, "signalled\n");
        return true;
      },
    );
  }
  assert.deepEqual(await workspaceNames(root), []);
});

test("cwd controls relative filesystem behavior independently from resolutionRoot", async (t) => {
  const root = await project(t);
  const firstCwd = join(root, "working", "first");
  const secondCwd = join(root, "working", "second");
  await Promise.all([
    mkdir(join(firstCwd, "nested"), { recursive: true }),
    mkdir(join(secondCwd, "nested"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(firstCwd, "value.txt"), "first"),
    writeFile(join(secondCwd, "value.txt"), "second"),
  ]);

  const registeredRoot = await writePackage(
    root,
    "@fixture/registered",
    {
      "index.js": "export const registered = 'registered';\n",
      "index.d.ts": "export declare const registered: 'registered';\n",
    },
    { exports: { ".": { types: "./index.d.ts", import: "./index.js" } } },
  );
  const ambientRoot = join(root, "node_modules", "ambient-fixture");
  await mkdir(ambientRoot, { recursive: true });
  await Promise.all([
    writeFile(join(ambientRoot, "package.json"), JSON.stringify({
      name: "ambient-fixture",
      type: "module",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    })),
    writeFile(join(ambientRoot, "index.js"), "export const ambient = 'ambient';\n"),
    writeFile(join(ambientRoot, "index.d.ts"), "export declare const ambient: 'ambient';\n"),
  ]);

  const executor = new TSFuncExecutor({ resolutionRoot: pathToFileURL(root) });
  executor.modules.register(packageModule({ specifier: "@fixture/registered", root: registeredRoot }));
  const source = `
    import { readFileSync } from "node:fs";
    import { ambient } from "ambient-fixture";
    import { registered } from "@fixture/registered";
    export function main() {
      const before = process.cwd();
      const relative = readFileSync("value.txt", "utf8");
      process.chdir("nested");
      return { before, after: process.cwd(), relative, ambient, registered };
    }
  `;
  const hostCwd = process.cwd();
  const [first, second] = await Promise.all([
    executor.execute({ source, cwd: firstCwd }),
    executor.execute({ source, cwd: pathToFileURL(secondCwd) }),
  ]);

  assert.deepEqual(first.value, {
    before: firstCwd,
    after: join(firstCwd, "nested"),
    relative: "first",
    ambient: "ambient",
    registered: "registered",
  });
  assert.deepEqual(second.value, {
    before: secondCwd,
    after: join(secondCwd, "nested"),
    relative: "second",
    ambient: "ambient",
    registered: "registered",
  });
  assert.equal(process.cwd(), hostCwd);
  assert.deepEqual(await workspaceNames(root), []);
});

test("cwd accepts absolute paths and file URLs and rejects invalid forms", async (t) => {
  const root = await project(t);
  const target = join(root, "target");
  const link = join(root, "linked-target");
  const file = join(root, "not-a-directory");
  await mkdir(target);
  await writeFile(file, "file");
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const source = "export function main(): string { return process.cwd(); }\n";

  assert.equal((await executor.execute({ source, cwd: target })).value, target);
  assert.equal((await executor.execute({ source, cwd: pathToFileURL(target) })).value, target);
  assert.equal((await executor.execute({ source, cwd: link })).value, target);

  await assert.rejects(executor.execute({ source, cwd: "relative" }), /must be an absolute/u);
  await assert.rejects(executor.execute({ source, cwd: new URL("https://example.com/") }), /file: URL/u);
  await assert.rejects(
    executor.execute({ source, cwd: new URL(`${pathToFileURL(target).href}?query=yes`) }),
    /without a query or fragment/u,
  );
  await assert.rejects(
    executor.execute({ source, cwd: new URL(`${pathToFileURL(target).href}#fragment`) }),
    /without a query or fragment/u,
  );
  await assert.rejects(executor.execute({ source, cwd: join(root, "missing") }), /does not exist/u);
  await assert.rejects(executor.execute({ source, cwd: file }), /is not a directory/u);
  await assert.rejects(executor.execute({ source }), /execute\.cwd is required/u);
  assert.deepEqual(await workspaceNames(root), []);
});

test("resolutionRoot accepts captured path strings and local file URLs and rejects invalid roots", async (t) => {
  const root = await project(t);
  const file = join(root, "root-file");
  await writeFile(file, "file");
  const source = "export function main(): null { return null; }\n";

  const relativeExecutor = new TSFuncExecutor({
    resolutionRoot: relative(process.cwd(), root),
  });
  assert.equal((await relativeExecutor.check({ source })).ok, true);
  const urlExecutor = new TSFuncExecutor({ resolutionRoot: pathToFileURL(root) });
  assert.equal((await urlExecutor.check({ source })).ok, true);

  assert.throws(() => new TSFuncExecutor({ resolutionRoot: "" }), /requires resolutionRoot/u);
  assert.throws(
    () => new TSFuncExecutor({ resolutionRoot: new URL("https://example.com/") }),
    /file: URL/u,
  );
  assert.throws(
    () => new TSFuncExecutor({
      resolutionRoot: new URL(`${pathToFileURL(root).href}?query=yes`),
    }),
    /without a query or fragment/u,
  );
  await assert.rejects(
    new TSFuncExecutor({ resolutionRoot: join(root, "missing") }).check({ source }),
    /resolutionRoot does not exist/u,
  );
  await assert.rejects(
    new TSFuncExecutor({ resolutionRoot: file }).check({ source }),
    /resolutionRoot is not a directory/u,
  );
  assert.deepEqual(await workspaceNames(root), []);
});

test("subprocess loader environment is restored without mutating the parent", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  const restoreVariable = "__TS_EXECUTOR_RESTORE_ENVIRONMENT";
  const previousConfig = process.env.TSX_TSCONFIG_PATH;
  const previousPrivate = process.env[restoreVariable];
  t.after(() => {
    if (previousConfig === undefined) delete process.env.TSX_TSCONFIG_PATH;
    else process.env.TSX_TSCONFIG_PATH = previousConfig;
    if (previousPrivate === undefined) delete process.env[restoreVariable];
    else process.env[restoreVariable] = previousPrivate;
  });
  process.env.TSX_TSCONFIG_PATH = "caller-visible-value";
  process.env[restoreVariable] = "caller-private-value";

  const source = `
    export function main(): { config: string | null; privateValue: string | null } {
      return {
        config: process.env.TSX_TSCONFIG_PATH ?? null,
        privateValue: process.env.__TS_EXECUTOR_RESTORE_ENVIRONMENT ?? null,
      };
    }
  `;
  const values = await Promise.all([
    executor.execute({ source, cwd: root }),
    executor.execute({ source, cwd: pathToFileURL(root) }),
  ]);
  assert.deepEqual(values.map((value) => value.value), [
    { config: "caller-visible-value", privateValue: "caller-private-value" },
    { config: "caller-visible-value", privateValue: "caller-private-value" },
  ]);
  assert.equal(process.env.TSX_TSCONFIG_PATH, "caller-visible-value");
  assert.equal(process.env[restoreVariable], "caller-private-value");

  delete process.env.TSX_TSCONFIG_PATH;
  delete process.env[restoreVariable];
  const absent = await executor.execute({ source, cwd: root });
  assert.deepEqual(absent.value, { config: null, privateValue: null });
  assert.equal(process.env.TSX_TSCONFIG_PATH, undefined);
  assert.equal(process.env[restoreVariable], undefined);
});

test("execution cleans workspaces after result and materialization failures", async (t) => {
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  await assert.rejects(
    executor.execute({
      cwd: root,
      source: "export function main(): undefined { return undefined; }\n",
    }),
    /Execution result.*unsupported type undefined/u,
  );
  assert.deepEqual(await workspaceNames(root), []);

  const broken = new TSFuncExecutor({ resolutionRoot: root });
  broken.modules.register({
    specifier: "@fixture/broken",
    packageRoot: join(root, "broken"),
    async materialize() {
      throw new Error("materialization failed");
    },
  });
  await assert.rejects(
    broken.check({ source: "export function main(): void {}\n" }),
    /materialization failed/u,
  );
  assert.deepEqual(await workspaceNames(root), []);
});
