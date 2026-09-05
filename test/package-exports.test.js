import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function filesUnder(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await filesUnder(join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

test("the packed public package has the intended files, declarations, and consumer exports", async (t) => {
  const root = await mkdtemp(join(repositoryRoot, ".package-exports-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}\n');

  const expectedFiles = [
    "LICENSE",
    "README.md",
    "package.json",
    ...await filesUnder(join(repositoryRoot, "dist"), "dist"),
    ...await filesUnder(join(repositoryRoot, "docs"), "docs"),
    ...await filesUnder(join(repositoryRoot, "examples"), "examples"),
  ].sort();
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execFileAsync(
    npm,
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      root,
      repositoryRoot,
    ],
    { cwd: root },
  );
  const packResults = JSON.parse(stdout);
  assert.equal(packResults.length, 1);
  const packResult = packResults[0];
  assert.deepEqual(packResult.files.map((file) => file.path).sort(), expectedFiles);

  const packageRoot = join(root, "node_modules", "ts-executor");
  await mkdir(packageRoot, { recursive: true });
  await execFileAsync(
    "tar",
    [
      "-xzf",
      join(root, packResult.filename),
      "--strip-components=1",
      "-C",
      packageRoot,
    ],
  );
  const packedFiles = (await filesUnder(packageRoot)).sort();
  assert.deepEqual(packedFiles, expectedFiles);

  await mkdir(join(root, "node_modules", "@types"), { recursive: true });
  await Promise.all([
    symlink(
      join(repositoryRoot, "node_modules", "@types", "node"),
      join(root, "node_modules", "@types", "node"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      join(repositoryRoot, "node_modules", "undici-types"),
      join(root, "node_modules", "undici-types"),
      process.platform === "win32" ? "junction" : "dir",
    ),
  ]);
  for (const javascript of packedFiles.filter((file) => file.startsWith("dist/") && file.endsWith(".js"))) {
    const declaration = `${javascript.slice(0, -3)}.d.ts`;
    assert.ok(packedFiles.includes(declaration), `packed ${javascript} is missing ${declaration}`);
  }

  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
  });
  assert.ok(packedFiles.includes(manifest.exports["."].types.slice(2)));

  await writeFile(
    join(root, "smoke.mjs"),
    `
      import assert from "node:assert/strict";
      import * as api from "ts-executor";
      assert.deepEqual(Object.keys(api).sort(), [
        "ProcExecutionError",
        "ProcExecutor",
        "TSFuncExecutor",
        "TypeCheckError",
        "packageModule",
      ]);
      const tsFunc = new api.TSFuncExecutor({ resolutionRoot: process.cwd() });
      assert.equal("getTypes" in tsFunc, false);
      assert.match(tsFunc.getInstructions(), /JSON function execution/);
      const result = await tsFunc.execute({
        source: "export function main(input: number): number { return input + 1; }",
        cwd: process.cwd(),
        input: 4,
      });
      assert.equal(result.value, 5);
      const proc = new api.ProcExecutor({ resolutionRoot: process.cwd() });
      assert.equal("getTypes" in proc, false);
      assert.match(proc.getInstructions(), /Stdout process execution/);
      assert.equal(await proc.execute({
        source: "export function main(): void { process.stdout.write('exact'); }",
        cwd: process.cwd(),
      }), "exact");
      assert.equal(typeof api.ProcExecutionError, "function");
    `,
  );
  await execFileAsync(process.execPath, [join(root, "smoke.mjs")], { cwd: root });

  await writeFile(
    join(root, "smoke.ts"),
    `
      import {
        ProcExecutionError,
        ProcExecutor,
        TSFuncExecutor,
        TypeCheckError,
        packageModule,
        type CheckResult,
        type ExecutorOptions,
        type JsonValue,
        type Module,
        type ModuleSummary,
        type ProcExecuteRequest,
        type TSFuncExecuteRequest,
        type TSFuncExecuteResult,
      } from "ts-executor";

      const options: ExecutorOptions = { resolutionRoot: "." };
      const executor = new TSFuncExecutor(options);
      const proc = new ProcExecutor(options);
      const sameRegistryType: typeof executor.modules = proc.modules;
      const module: Module = packageModule({
        specifier: "@fixture/smoke",
        root: ".",
      });
      const json: JsonValue = { okay: true };
      void executor;
      void json;
      void module;
      void sameRegistryType;
      const instructions: string = executor.getInstructions();
      const procInstructions: string = proc.getInstructions();
      const modules: Promise<readonly ModuleSummary[]> = executor.listModules();
      const procModules: Promise<readonly ModuleSummary[]> = proc.listModules({ query: "smoke" });
      void modules.then((entries) => entries.map((entry): string => entry.packageRoot));
      void procModules;
      // @ts-expect-error Declaration retrieval has been removed from both executors.
      void executor.getTypes("@fixture/smoke");
      // @ts-expect-error Declaration retrieval has been removed from both executors.
      void proc.getTypes("@fixture/smoke");
      const checked: Promise<CheckResult> = executor.check({ source: "export function main() {}" });
      const tsFuncRequest: TSFuncExecuteRequest<number> = {
        source: "export function main(input: number) { return input; }",
        cwd: ".",
        input: 1,
      };
      const executed: Promise<TSFuncExecuteResult<number>> =
        executor.execute<number, number>(tsFuncRequest);
      const procRequest: ProcExecuteRequest = {
        source: "export function main(): void {}",
        cwd: ".",
      };
      const stdout: Promise<string> = proc.execute(procRequest);
      // @ts-expect-error ProcExecutor has no input contract.
      void proc.execute({ ...procRequest, input: null });
      // @ts-expect-error ProcExecutor requires cwd.
      void proc.execute({ source: procRequest.source });
      // @ts-expect-error TSFuncExecutor generic values must be JSON.
      void executor.execute<Date, JsonValue>({ ...tsFuncRequest, input: new Date() });
      declare const procError: ProcExecutionError;
      const errorOutput: string = procError.stdout;
      const errorDetail: string = procError.stderr;
      const errorCode: number | null = procError.exitCode;
      const errorSignal: NodeJS.Signals | null = procError.signal;
      void errorOutput;
      void errorDetail;
      void errorCode;
      void errorSignal;
      void checked;
      void executed;
      void instructions;
      void procInstructions;
      void stdout;
      void ProcExecutionError;
      void TypeCheckError;
    `,
  );
  await writeFile(
    join(root, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["smoke.ts"],
    }, null, 2)}\n`,
  );
  await execFileAsync(
    process.execPath,
    [join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.json")],
    { cwd: root },
  );
});
