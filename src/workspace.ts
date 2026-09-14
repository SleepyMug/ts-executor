import { chmod, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runtimeCompilerOptions } from "./compiler-options.js";
import type { HostBinding } from "./host-bindings.js";
import { storageDirectory } from "./storage.js";
import type { Module } from "./types.js";

export interface PreparedWorkspace {
  readonly root: string;
  readonly resolutionRoot: string;
  readonly hostBindings: ReadonlyMap<string, HostBinding>;
  readonly entrypoint: string;
  readonly tsconfig: string;
  readonly stdout: string;
  readonly stderr: string;
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if ((typeof primary !== "object" && typeof primary !== "function") || primary === null) return;
  try {
    Object.defineProperty(primary, "cleanupError", {
      value: cleanup,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Preserve the primary failure even when it cannot accept metadata.
  }
}

async function waitForAll(tasks: readonly Promise<unknown>[]): Promise<void> {
  let failed = false;
  let firstFailure: unknown;
  await Promise.all(tasks.map(async (task) => {
    try {
      await task;
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
    }
  }));
  if (failed) throw firstFailure;
}

async function assertPackageRoot(specifier: string, packageRoot: string): Promise<void> {
  let packageStat;
  try {
    packageStat = await stat(packageRoot);
    await stat(join(packageRoot, "package.json"));
  } catch (error) {
    throw new Error(
      `Module ${JSON.stringify(specifier)} did not materialize a package at ${JSON.stringify(packageRoot)}`,
      { cause: error },
    );
  }
  if (!packageStat.isDirectory()) {
    throw new Error(`Materialized package root is not a directory: ${JSON.stringify(packageRoot)}`);
  }
}

export async function prepareWorkspace(
  resolutionRootInput: string,
  modules: readonly Module[],
  source: string,
  hostBindings: ReadonlyMap<string, HostBinding> = new Map(),
): Promise<PreparedWorkspace> {
  if (typeof source !== "string") throw new TypeError("TypeScript source must be a string");
  const resolutionRoot = resolve(resolutionRootInput);
  const runs = await storageDirectory(resolutionRoot, "runs");
  const root = await mkdtemp(join(runs, "run-"));

  try {
    await chmod(root, 0o700);
    const entrypoint = join(root, "main.ts");
    const tsconfig = join(root, "tsconfig.json");
    await waitForAll([
      mkdir(join(root, "node_modules"), { recursive: true }),
      mkdir(join(root, ".modules"), { recursive: true }),
      writeFile(
        join(root, "package.json"),
        `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
        "utf8",
      ),
      writeFile(entrypoint, source, { encoding: "utf8", mode: 0o600 }),
      writeFile(
        tsconfig,
        `${JSON.stringify({ compilerOptions: runtimeCompilerOptions }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      ),
    ]);

    for (const [index, module] of modules.entries()) {
      const materializationRoot = join(root, ".modules", String(index));
      const materialized = await module.materialize(
        Object.freeze({ packageRoot: materializationRoot, workspaceRoot: root }),
      );
      const packageRoot = resolve(materialized.packageRoot);
      await assertPackageRoot(module.specifier, packageRoot);

      const link = join(root, "node_modules", ...module.specifier.split("/"));
      await mkdir(dirname(link), { recursive: true });
      await symlink(packageRoot, link, process.platform === "win32" ? "junction" : "dir");
    }

    return Object.freeze({
      root,
      resolutionRoot,
      hostBindings,
      entrypoint,
      tsconfig,
      stdout: join(root, "stdout.log"),
      stderr: join(root, "stderr.log"),
    });
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }
}

export async function removeWorkspace(workspace: PreparedWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}
