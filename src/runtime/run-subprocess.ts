import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile, type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import type { PreparedWorkspace } from "../workspace.js";
import { attachHostBridge } from "./host-bridge.js";

export interface SubprocessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
  readonly cleanupError?: Error;
}

interface ExitOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

const require = createRequire(import.meta.url);
const tsxImport = require.resolve("tsx");
const RESTORE_ENVIRONMENT = "__TS_EXECUTOR_RESTORE_ENVIRONMENT";

function environment(workspace: PreparedWorkspace): NodeJS.ProcessEnv {
  const state = {
    ...(process.env.TSX_TSCONFIG_PATH === undefined
      ? {}
      : { tsxConfigPath: process.env.TSX_TSCONFIG_PATH }),
    ...(process.env[RESTORE_ENVIRONMENT] === undefined
      ? {}
      : { privateValue: process.env[RESTORE_ENVIRONMENT] }),
  };
  return {
    ...process.env,
    TSX_TSCONFIG_PATH: workspace.tsconfig,
    [RESTORE_ENVIRONMENT]: JSON.stringify(state),
  };
}

function waitForExit(child: ChildProcess): Promise<ExitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let processError: Error | undefined;
    child.on("error", (error) => {
      if (settled) return;
      processError ??= error;
      // A failed spawn has no process to reap. IPC errors after a successful
      // spawn do NOT mean the child exited: retain files and leases until exit.
      if (child.pid !== undefined) return;
      settled = true;
      resolve({ exitCode: null, signal: null, error });
    });
    child.once("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, ...(processError === undefined ? {} : { error: processError }) });
    });
  });
}

async function closeHandles(handles: readonly FileHandle[]): Promise<Error | undefined> {
  const results = await Promise.allSettled(handles.map(async (handle) => handle.close()));
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed === undefined) return undefined;
  return failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
}

async function readOutputs(workspace: PreparedWorkspace): Promise<{
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}> {
  const [stdoutResult, stderrResult] = await Promise.allSettled([
    readFile(workspace.stdout, "utf8"),
    readFile(workspace.stderr, "utf8"),
  ]);
  const stdout = stdoutResult.status === "fulfilled" ? stdoutResult.value : "";
  const stderr = stderrResult.status === "fulfilled" ? stderrResult.value : "";
  const failure = stdoutResult.status === "rejected"
    ? stdoutResult.reason
    : stderrResult.status === "rejected"
      ? stderrResult.reason
      : undefined;
  if (failure === undefined) return { stdout, stderr };
  return {
    stdout,
    stderr,
    error: failure instanceof Error ? failure : new Error(String(failure)),
  };
}

/** Starts and reaps one child without interpreting any flavor-specific status file. */
export async function runSubprocess(
  workspace: PreparedWorkspace,
  cwd: string,
  bootstrap: string,
  arguments_: readonly string[],
): Promise<SubprocessResult> {
  const handles: FileHandle[] = [];
  let outcome: ExitOutcome = { exitCode: null, signal: null };
  let closeBridge: (() => void) | undefined;
  try {
    handles.push(await open(workspace.stdout, "w", 0o600));
    handles.push(await open(workspace.stderr, "w", 0o600));
    const child = spawn(
      process.execPath,
      ["--import", tsxImport, bootstrap, ...arguments_],
      {
        cwd,
        env: environment(workspace),
        stdio: workspace.hostBindings.size === 0
          ? ["ignore", handles[0]?.fd ?? "ignore", handles[1]?.fd ?? "ignore"]
          : ["ignore", handles[0]?.fd ?? "ignore", handles[1]?.fd ?? "ignore", "ipc"],
        serialization: "json",
      },
    );
    if (workspace.hostBindings.size > 0) {
      closeBridge = attachHostBridge(child, async (id, method, input, signal) => {
        const binding = workspace.hostBindings.get(id);
        if (binding === undefined) throw new Error("Host module is not registered for this execution");
        return binding.invoke(method, input, signal);
      });
    }
    outcome = await waitForExit(child);
  } catch (error) {
    outcome = {
      exitCode: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    closeBridge?.();
  }

  const cleanupError = await closeHandles(handles);
  const output = await readOutputs(workspace);
  return Object.freeze({
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: output.stdout,
    stderr: output.stderr,
    ...(outcome.error === undefined && output.error === undefined
      ? {}
      : { error: outcome.error ?? output.error }),
    ...(cleanupError === undefined ? {} : { cleanupError }),
  });
}
