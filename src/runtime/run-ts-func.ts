import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deserializeError,
  parseResultEnvelope,
  type ResultEnvelope,
} from "../json-value.js";
import type { JsonValue } from "../types.js";
import type { PreparedWorkspace } from "../workspace.js";
import { runSubprocess, type SubprocessResult } from "./run-subprocess.js";

export interface TSFuncProcessResult {
  readonly value: JsonValue;
  readonly stdout: string;
  readonly stderr: string;
}

interface TSFuncFiles {
  readonly input: string;
  readonly result: string;
  readonly resultTemporary: string;
}

interface SuccessfulTermination {
  readonly ok: true;
  readonly value: JsonValue;
}

interface FailedTermination {
  readonly ok: false;
  readonly error: Error;
}

type Termination = SuccessfulTermination | FailedTermination;

const bootstrap = fileURLToPath(new URL("./ts-func-subprocess.js", import.meta.url));

function outputError(error: Error, stdout: string, stderr: string): Error {
  Object.defineProperties(error, {
    stdout: { value: stdout, enumerable: true },
    stderr: { value: stderr, enumerable: true },
  });
  return error;
}

function attachCleanupError(primary: Error, cleanup: Error): void {
  try {
    Object.defineProperty(primary, "cleanupError", {
      value: cleanup,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Preserve the primary runtime failure even when it cannot accept metadata.
  }
}

async function prepareFiles(workspace: PreparedWorkspace, inputEnvelope: string): Promise<TSFuncFiles> {
  const input = join(workspace.root, "input.json");
  await writeFile(input, inputEnvelope, { encoding: "utf8", mode: 0o600 });
  await chmod(input, 0o600);
  return Object.freeze({
    input,
    result: join(workspace.root, "result.json"),
    resultTemporary: join(workspace.root, "result.tmp"),
  });
}

async function readResult(path: string): Promise<{
  readonly envelope?: ResultEnvelope;
  readonly error?: Error;
}> {
  try {
    return { envelope: parseResultEnvelope(await readFile(path, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function invalidTerminalResult(message: string, resultError: Error | undefined): Error {
  return resultError === undefined ? new Error(message) : new Error(message, { cause: resultError });
}

async function classifyTermination(
  files: TSFuncFiles,
  outcome: SubprocessResult,
): Promise<Termination> {
  if (outcome.error !== undefined) return { ok: false, error: outcome.error };
  if (outcome.signal !== null) {
    return {
      ok: false,
      error: new Error(`Execution subprocess exited due to signal ${outcome.signal}`),
    };
  }

  const result = await readResult(files.result);
  if (outcome.exitCode === 0) {
    if (result.envelope?.ok === true) return { ok: true, value: result.envelope.value };
    return {
      ok: false,
      error: invalidTerminalResult(
        "Execution subprocess exited with code 0 without a valid success result",
        result.error,
      ),
    };
  }

  if (result.envelope?.ok === false) {
    return { ok: false, error: deserializeError(result.envelope.error) };
  }
  const code = outcome.exitCode === null ? "an unknown status" : `code ${outcome.exitCode}`;
  return {
    ok: false,
    error: invalidTerminalResult(
      `Execution subprocess exited with ${code} without a valid error result`,
      result.error,
    ),
  };
}

export async function runTSFuncProcess(
  workspace: PreparedWorkspace,
  cwd: string,
  inputEnvelope: string,
): Promise<TSFuncProcessResult> {
  const files = await prepareFiles(workspace, inputEnvelope);
  const outcome = await runSubprocess(
    workspace,
    cwd,
    bootstrap,
    [workspace.entrypoint, files.input, files.result, files.resultTemporary],
  );
  const termination = await classifyTermination(files, outcome);
  if (!termination.ok) {
    const primary = outputError(termination.error, outcome.stdout, outcome.stderr);
    if (outcome.cleanupError !== undefined) attachCleanupError(primary, outcome.cleanupError);
    throw primary;
  }
  if (outcome.cleanupError !== undefined) {
    throw outputError(outcome.cleanupError, outcome.stdout, outcome.stderr);
  }
  return Object.freeze({
    value: termination.value,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  });
}
