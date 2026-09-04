import { chmod, rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const RESTORE_ENVIRONMENT = "__TS_EXECUTOR_RESTORE_ENVIRONMENT";
const SafePromise = Promise;
const capturedExit = process.exit.bind(process);
const jsonParse = JSON.parse;
const objectKeys = Object.keys;
const stdout = process.stdout;
const stderr = process.stderr;
type TerminalEnd = (callback: (error?: Error | null) => void) => NodeJS.WriteStream;
const stdoutEnd = stdout.end.bind(stdout) as unknown as TerminalEnd;
const stderrEnd = stderr.end.bind(stderr) as unknown as TerminalEnd;

export function absoluteArguments(expected: number): readonly string[] {
  const paths = process.argv.slice(2);
  if (paths.length !== expected || paths.some((path) => !isAbsolute(path))) {
    capturedExit(1);
  }
  return paths;
}

export function restoreEnvironment(): void {
  const encoded = process.env[RESTORE_ENVIRONMENT];
  delete process.env[RESTORE_ENVIRONMENT];
  if (encoded === undefined) throw new Error("Subprocess environment restoration state is missing");

  const state = jsonParse(encoded) as unknown;
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw new Error("Subprocess environment restoration state is invalid");
  }
  const values = state as Readonly<Record<string, unknown>>;
  const keys = objectKeys(values);
  if (
    keys.some((key) => key !== "tsxConfigPath" && key !== "privateValue")
    || (values.tsxConfigPath !== undefined && typeof values.tsxConfigPath !== "string")
    || (values.privateValue !== undefined && typeof values.privateValue !== "string")
  ) {
    throw new Error("Subprocess environment restoration state is invalid");
  }

  if (typeof values.tsxConfigPath === "string") {
    process.env.TSX_TSCONFIG_PATH = values.tsxConfigPath;
  } else {
    delete process.env.TSX_TSCONFIG_PATH;
  }
  if (typeof values.privateValue === "string") {
    process.env[RESTORE_ENVIRONMENT] = values.privateValue;
  }
}

function flush(end: TerminalEnd): Promise<void> {
  return new SafePromise<void>((resolve, reject) => {
    end((error) => error === undefined || error === null ? resolve() : reject(error));
  });
}

async function publish(path: string, temporary: string, text: string): Promise<void> {
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function complete(
  path: string,
  temporary: string,
  text: string,
  status: 0 | 1,
): Promise<void> {
  try {
    let flushError: unknown;
    try {
      await flush(stdoutEnd);
    } catch (error) {
      flushError = error;
    }
    try {
      await flush(stderrEnd);
    } catch (error) {
      flushError ??= error;
    }
    if (flushError !== undefined) throw flushError;
    await publish(path, temporary, text);
  } catch {
    capturedExit(1);
  }
  capturedExit(status);
}
