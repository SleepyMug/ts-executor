import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcExecutionError } from "../errors.js";
import { parseProcStatusEnvelope, type ProcStatusEnvelope } from "../proc-status.js";
import type { SerializedError } from "../json-value.js";
import type { PreparedWorkspace } from "../workspace.js";
import { runSubprocess, type SubprocessResult } from "./run-subprocess.js";

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

function attachCleanupError(primary: Error, cleanup: Error): void {
  try {
    Object.defineProperty(primary, "cleanupError", {
      value: cleanup,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Preserve the primary execution failure even when it cannot accept metadata.
  }
}

function procError(
  termination: FailedTermination,
  outcome: SubprocessResult,
): ProcExecutionError {
  const error = new ProcExecutionError(
    termination.message,
    outcome.stdout,
    outcome.stderr,
    outcome.exitCode,
    outcome.signal,
    termination.cause === undefined ? undefined : { cause: termination.cause },
  );
  if (termination.guestError !== undefined) {
    error.name = termination.guestError.name;
    if (termination.guestError.stack !== undefined) error.stack = termination.guestError.stack;
  }
  if (outcome.cleanupError !== undefined) attachCleanupError(error, outcome.cleanupError);
  return error;
}

export async function runProcProcess(workspace: PreparedWorkspace, cwd: string): Promise<string> {
  const paths = files(workspace);
  const outcome = await runSubprocess(
    workspace,
    cwd,
    bootstrap,
    [workspace.entrypoint, paths.status, paths.statusTemporary],
  );
  const termination = await classifyTermination(paths, outcome);
  if (!termination.ok) throw procError(termination, outcome);
  if (outcome.cleanupError !== undefined) {
    throw procError(
      { ok: false, message: outcome.cleanupError.message, cause: outcome.cleanupError },
      outcome,
    );
  }
  return outcome.stdout;
}
