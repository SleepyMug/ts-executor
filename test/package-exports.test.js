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
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

// Resolve the physical package roots rather than assuming a hoisted layout:
// pnpm keeps transitive dependencies such as undici-types beside @types/node
// under node_modules/.pnpm instead of at the repository's top level.
const nodeTypesRoot = dirname(require.resolve("@types/node/package.json"));
const undiciTypesRoot = dirname(
  createRequire(join(nodeTypesRoot, "package.json")).resolve("undici-types/package.json"),
);

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
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const { stdout } = await execFileAsync(
    pnpm,
    [
      "--config.ignore-scripts=true",
      "pack",
      "--json",
      "--pack-destination",
      root,
    ],
    { cwd: repositoryRoot },
  );
  const packResult = JSON.parse(stdout);
  assert.deepEqual(packResult.files.map((file) => file.path).sort(), expectedFiles);

  const packageRoot = join(root, "node_modules", "ts-executor");
  await mkdir(packageRoot, { recursive: true });
  await execFileAsync(
    "tar",
    [
      "-xzf",
      resolve(root, packResult.filename),
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
      nodeTypesRoot,
      join(root, "node_modules", "@types", "node"),
      process.platform === "win32" ? "junction" : "dir",
    ),
    symlink(
      undiciTypesRoot,
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
        "ExecutionAbortedError",
        "RESERVED_ENVIRONMENT_NAMES",
        "TSFuncExecutor",
        "TypeCheckError",
        "hostModule",
        "packageModule",
      ]);
      assert.deepEqual(api.RESERVED_ENVIRONMENT_NAMES, ["TSX_TSCONFIG_PATH", "__TS_EXECUTOR_RESTORE_ENVIRONMENT"]);
      const executor = new api.TSFuncExecutor({ resolutionRoot: process.cwd() });
      assert.equal("getTypes" in executor, false);
      assert.match(executor.getInstructions(), /JSON function execution/);
      let stdout = "";
      const result = await executor.execute({
        source: "export function main(input: number): number { process.stdout.write('exact'); return input + 1; }",
        cwd: process.cwd(),
        input: 4,
        onStdout: (text) => { stdout += text; },
      });
      assert.deepEqual(Object.keys(result).sort(), ["durationMs", "value"]);
      assert.equal(result.value, 5);
      assert.equal(stdout, "exact");
      const host = await api.hostModule({
        resolutionRoot: process.cwd(), specifier: "@host/packed",
        declarations: "export declare function greet(name: string): Promise<string>;\\n",
        functions: ["greet"],
        call: (_fn, [name]) => "Hello " + name,
      });
      try {
        executor.modules.register(host);
        assert.equal((await executor.execute({
          cwd: process.cwd(),
          source: 'import { greet } from "@host/packed"; export async function main() { return greet("packed"); }',
        })).value, "Hello packed");
      } finally { await host.dispose(); }
    `,
  );
  await execFileAsync(process.execPath, [join(root, "smoke.mjs")], { cwd: root });

  await writeFile(
    join(root, "smoke.ts"),
    `
      import {
        ExecutionAbortedError,
        RESERVED_ENVIRONMENT_NAMES,
        TSFuncExecutor,
        TypeCheckError,
        hostModule,
        packageModule,
        type CheckRequest,
        type CheckResult,
        type Diagnostic,
        type DiagnosticCategory,
        type ExecutionControl,
        type ExecutorOptions,
        type HostCall,
        type HostCallContext,
        type HostModule,
        type HostModuleOptions,
        type JsonValue,
        type ListModulesRequest,
        type MaterializeContext,
        type MaterializedModule,
        type Module,
        type ModuleSummary,
        type PackageModuleOptions,
        type TSFuncExecuteRequest,
        type TSFuncExecuteResult,
      } from "ts-executor";

      const call: HostCall = async (fn, args, context) => {
        const ctx: HostCallContext = context;
        const first: JsonValue | undefined = args[0];
        return { fn, count: args.length, first: first ?? null, aborted: ctx.signal.aborted };
      };
      // @ts-expect-error A host call must return JSON.
      const dated: HostCall = () => new Date();
      // @ts-expect-error The arguments a host call receives are read-only.
      const mutating: HostCall = (_fn, args) => { args.push(1); return null; };
      const hostOptions: HostModuleOptions = {
        resolutionRoot: ".", specifier: "@host/typed",
        declarations: "export declare function lookup(id: number): Promise<string>;\\n",
        functions: ["lookup"], call,
      };
      // @ts-expect-error functions lists names; handlers and schemas are gone.
      const handlerMap: HostModuleOptions = { ...hostOptions, functions: { lookup: call } };
      // @ts-expect-error declarations are required text.
      const undeclared: HostModuleOptions = { resolutionRoot: ".", specifier: "@host/untyped", functions: [], call };
      const hostPromise: Promise<HostModule> = hostModule(hostOptions);
      void hostPromise.then(host => { const module: Module = host; void module; return host.dispose(); });
      void dated;
      void mutating;
      void handlerMap;
      void undeclared;

      const options: ExecutorOptions = { resolutionRoot: "." };
      const executor = new TSFuncExecutor(options);
      const instructions: string = executor.getInstructions();
      // @ts-expect-error Instructions take no options; limits are the caller's to state.
      void executor.getInstructions({ timeoutMs: 1000 });
      const packageOptions: PackageModuleOptions = { specifier: "@fixture/smoke", root: "." };
      const module: Module = packageModule(packageOptions);
      const custom: Module = {
        specifier: "@fixture/custom",
        packageRoot: "/tmp",
        async materialize(context: MaterializeContext): Promise<MaterializedModule> {
          return { packageRoot: context.packageRoot };
        },
      };
      executor.modules.register(custom);
      const listRequest: ListModulesRequest = { query: "smoke" };
      const modules: Promise<readonly ModuleSummary[]> = executor.listModules(listRequest);
      void modules.then((entries) => entries.map((entry): string => entry.packageRoot));
      // @ts-expect-error Declaration retrieval has been removed.
      void executor.getTypes("@fixture/smoke");
      const checkRequest: CheckRequest = { source: "export function main() { return null; }" };
      const checked: Promise<CheckResult> = executor.check(checkRequest);
      void checked.then(({ diagnostics }) => diagnostics.map((entry: Diagnostic): DiagnosticCategory => entry.category));
      const tsFuncRequest: TSFuncExecuteRequest<number> = {
        source: "export function main(input: number) { return input; }",
        cwd: ".",
        input: 1,
      };
      const executed: Promise<TSFuncExecuteResult<number>> =
        executor.execute<number, number>(tsFuncRequest);
      void executed.then((result) => {
        const value: number = result.value;
        const duration: number = result.durationMs;
        // @ts-expect-error Output goes to the caller's sinks, not into the result.
        void result.stdout;
        return value + duration;
      });
      const control: ExecutionControl = {
        signal: AbortSignal.any([new AbortController().signal, AbortSignal.timeout(1000)]),
        env: { RUN_ID: "call-7" },
        onStdout: (text: string) => { void text; },
        onStderr: (text) => { const chunk: string = text; void chunk; },
      };
      void executor.execute({ ...tsFuncRequest, ...control });
      // @ts-expect-error Deadlines are the caller's: abort the signal instead.
      void executor.execute({ source: "", cwd: ".", timeoutMs: 1000 });
      // @ts-expect-error Output limits are the caller's: bound what the sinks keep.
      void executor.execute({ source: "", cwd: ".", maxOutputBytes: 1024 });
      // @ts-expect-error Leftover processes are always killed; there is no option.
      void executor.execute({ source: "", cwd: ".", killGroupOnExit: true });
      // @ts-expect-error Sinks receive text.
      void executor.execute({ source: "", cwd: ".", onStdout: (chunk: Buffer) => chunk });
      // @ts-expect-error TSFuncExecutor generic values must be JSON.
      void executor.execute<Date, JsonValue>({ ...tsFuncRequest, input: new Date() });
      declare const abortedError: ExecutionAbortedError;
      const abortedAfter: number = abortedError.durationMs;
      // @ts-expect-error The caller knows why its own signal aborted.
      void abortedError.reason;
      const reserved: readonly string[] = RESERVED_ENVIRONMENT_NAMES;
      void abortedAfter;
      void reserved;
      void module;
      void instructions;
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
