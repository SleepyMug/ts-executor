import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IntrinsicURL = URL;

export function fileUrlPath(value: URL, label: string): string {
  if (!value.href.startsWith("file:") || value.search.length > 0 || value.hash.length > 0) {
    throw new TypeError(`${label} must be a file: URL without a query or fragment`);
  }
  try {
    return fileURLToPath(value);
  } catch (error) {
    throw new TypeError(`${label} must be a valid local file: URL`, { cause: error });
  }
}

/** A non-empty path (relative to the current directory) or a local file: URL, made absolute. */
export function resolveResolutionRoot(value: unknown, owner: string): string {
  if (typeof value === "string" && value.length > 0) return resolve(value);
  if (value instanceof IntrinsicURL) return resolve(fileUrlPath(value, "resolutionRoot"));
  throw new TypeError(`${owner} requires resolutionRoot, a non-empty path or local file: URL`);
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
