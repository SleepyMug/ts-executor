import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

export async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "ts-executor-test-"));
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}\n');
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

export async function workspaceNames(root) {
  try {
    return await readdir(join(root, ".ts-executor", "runs"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writePackage(root, name, files, packageJson) {
  const packageRoot = join(root, "packages", ...name.split("/"));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({ name, type: "module", ...packageJson }, null, 2)}\n`,
  );
  for (const [file, source] of Object.entries(files)) {
    const destination = join(packageRoot, ...file.split("/"));
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, source);
  }
  return packageRoot;
}

/** Output sinks that record every delivered chunk. Spread `sinks` into an execute request. */
export function collect() {
  const chunks = { stdout: [], stderr: [] };
  return {
    chunks,
    sinks: {
      onStdout: (text) => { chunks.stdout.push(text); },
      onStderr: (text) => { chunks.stderr.push(text); },
    },
    stdout: () => chunks.stdout.join(""),
    stderr: () => chunks.stderr.join(""),
  };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * Resolves once `pid` no longer exists. A killed process stays visible until its new
 * parent reaps it, and there is no event for that, so this polls with a bound.
 */
export async function gone(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** A promise with its settle functions, for gating tests on events. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Gates may be rejected during cleanup, including before they are consumed.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Records every child the executor spawns until the test ends. `onSpawn` runs right
 * after spawn, before the executor attaches its own listeners.
 */
export function watchSpawns(t, onSpawn = () => {}) {
  const original = childProcess.spawn;
  const spawned = [];
  childProcess.spawn = function spawn(...args) {
    const child = Reflect.apply(original, this, args);
    spawned.push(child);
    onSpawn(child);
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  });
  return spawned;
}
