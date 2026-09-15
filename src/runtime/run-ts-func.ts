import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionAbortedError } from "../errors.js";
import {
  deserializeError,
  parseResultEnvelope,
  type ResultEnvelope,
} from "../json-value.js";
import type { ResolvedControl } from "../limits.js";
import type { JsonValue, OutputTruncation } from "../types.js";
import type { PreparedWorkspace } from "../workspace.js";
import { runSubprocess, type SubprocessResult } from "./run-subprocess.js";

export interface TSFuncProcessResult {
  readonly value: JsonValue;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: OutputTruncation;
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

function outputError(error: Error, outcome: SubprocessResult): Error {
  Object.defineProperties(error, {
    stdout: { value: outcome.stdout, enumerable: true },
    stderr: { value: outcome.stderr, enumerable: true },
    truncated: { value: outcome.truncated, enumerable: true },
  });
  return error;
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
  control: ResolvedControl,
): Promise<TSFuncProcessResult> {
  const files = await prepareFiles(workspace, inputEnvelope);
  const outcome = await runSubprocess(
    workspace,
    cwd,
    bootstrap,
    [workspace.entrypoint, files.input, files.result, files.resultTemporary],
    control,
  );
  if (outcome.aborted !== undefined) {
    throw new ExecutionAbortedError(outcome.aborted, {
      ...outcome,
      durationMs: performance.now() - control.startedAt,
    });
  }
  const termination = await classifyTermination(files, outcome);
  if (!termination.ok) throw outputError(termination.error, outcome);
  return Object.freeze({
    value: termination.value,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    truncated: outcome.truncated,
  });
}
