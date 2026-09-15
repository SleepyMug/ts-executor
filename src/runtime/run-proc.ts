import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionAbortedError, ProcExecutionError } from "../errors.js";
import { parseProcStatusEnvelope, type ProcStatusEnvelope } from "../proc-status.js";
import type { SerializedError } from "../json-value.js";
import type { ResolvedControl } from "../limits.js";
import type { OutputTruncation } from "../types.js";
import type { PreparedWorkspace } from "../workspace.js";
import { runSubprocess, type SubprocessResult } from "./run-subprocess.js";

export interface ProcProcessResult {
  readonly stdout: string;
  readonly truncated: OutputTruncation;
}

interface ProcFiles {
  readonly status: string;
  readonly statusTemporary: string;
}

interface SuccessfulTermination {
  readonly ok: true;
}

interface FailedTermination {
  readonly ok: false;
  readonly message: string;
  readonly cause?: Error;
  readonly guestError?: SerializedError;
}

type Termination = SuccessfulTermination | FailedTermination;

const bootstrap = fileURLToPath(new URL("./proc-subprocess.js", import.meta.url));

function files(workspace: PreparedWorkspace): ProcFiles {
  return Object.freeze({
    status: join(workspace.root, "proc-status.json"),
    statusTemporary: join(workspace.root, "proc-status.tmp"),
  });
}

async function readStatus(path: string): Promise<{
  readonly envelope?: ProcStatusEnvelope;
  readonly error?: Error;
}> {
  try {
    return { envelope: parseProcStatusEnvelope(await readFile(path, "utf8")) };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function classifyTermination(
  paths: ProcFiles,
  outcome: SubprocessResult,
): Promise<Termination> {
  if (outcome.error !== undefined) {
    return { ok: false, message: outcome.error.message, cause: outcome.error };
  }
  if (outcome.signal !== null) {
    return {
      ok: false,
      message: `Proc execution subprocess exited due to signal ${outcome.signal}`,
    };
  }

  const status = await readStatus(paths.status);
  if (outcome.exitCode === 0) {
    if (status.envelope?.ok === true) return { ok: true };
    return {
      ok: false,
      message: "Proc execution subprocess exited with code 0 without a valid success status",
      ...(status.error === undefined ? {} : { cause: status.error }),
    };
  }

  if (status.envelope?.ok === false) {
    return {
      ok: false,
      message: status.envelope.error.message,
      guestError: status.envelope.error,
    };
  }
  const code = outcome.exitCode === null ? "an unknown status" : `code ${outcome.exitCode}`;
  return {
    ok: false,
    message: `Proc execution subprocess exited with ${code} without a valid error status`,
    ...(status.error === undefined ? {} : { cause: status.error }),
  };
}

function procError(
  termination: FailedTermination,
  outcome: SubprocessResult,
): ProcExecutionError {
  const error = new ProcExecutionError(
    termination.message,
    outcome,
    termination.cause === undefined ? undefined : { cause: termination.cause },
  );
  if (termination.guestError !== undefined) {
    error.name = termination.guestError.name;
    if (termination.guestError.stack !== undefined) error.stack = termination.guestError.stack;
  }
  return error;
}

export async function runProcProcess(
  workspace: PreparedWorkspace,
  cwd: string,
  control: ResolvedControl,
): Promise<ProcProcessResult> {
  const paths = files(workspace);
  const outcome = await runSubprocess(
    workspace,
    cwd,
    bootstrap,
    [workspace.entrypoint, paths.status, paths.statusTemporary],
    control,
  );
  if (outcome.aborted !== undefined) {
    throw new ExecutionAbortedError(outcome.aborted, {
      ...outcome,
      durationMs: performance.now() - control.startedAt,
    });
  }
  const termination = await classifyTermination(paths, outcome);
  if (!termination.ok) throw procError(termination, outcome);
  return Object.freeze({ stdout: outcome.stdout, truncated: outcome.truncated });
}
