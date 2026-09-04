import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "ts-executor-test-"));
  await writeFile(join(root, "package.json"), '{"private":true,"type":"module"}\n');
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

export async function workspaceNames(root) {
  return (await readdir(root)).filter((name) => name.startsWith(".ts-executor-run-"));
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
