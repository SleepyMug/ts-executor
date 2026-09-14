import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveResolutionRoot(value: string | URL): string {
  if (typeof value === "string" && value.length > 0) return resolve(value);
  if (value instanceof URL && value.protocol === "file:" && !value.search && !value.hash) {
    return resolve(fileURLToPath(value));
  }
  throw new TypeError("resolutionRoot must be a non-empty path or local file: URL without query or fragment");
}

/** Shared scaffolding is retained; callers own only uniquely named children. */
export async function storageDirectory(resolutionRoot: string, area: "modules" | "runs"): Promise<string> {
  let rootStat;
  try {
    rootStat = await stat(resolutionRoot);
  } catch (error) {
    throw new Error(`resolutionRoot does not exist: ${JSON.stringify(resolutionRoot)}`, { cause: error });
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`resolutionRoot is not a directory: ${JSON.stringify(resolutionRoot)}`);
  }
  const directory = join(resolutionRoot, ".ts-executor", area);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
