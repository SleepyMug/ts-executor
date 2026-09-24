import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { KILL_GRACE_MS, type OutputSink, type ResolvedControl } from "../control.js";
import type { PreparedWorkspace } from "../workspace.js";
import { attachHostBridge } from "./host-bridge.js";

export interface SubprocessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /**
   * True when the caller's signal aborted before the child's exit was observed: the
   * group was terminated, or nothing was spawned because it had already aborted.
   */
  readonly aborted: boolean;
  /** A process-level failure, or the error an output sink threw. */
  readonly error?: Error;
}

interface ExitOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

const require = createRequire(import.meta.url);
const tsxImport = require.resolve("tsx");
const RESTORE_ENVIRONMENT = "__TS_EXECUTOR_RESTORE_ENVIRONMENT";

function environment(workspace: PreparedWorkspace, control: ResolvedControl): NodeJS.ProcessEnv {
  const state = {
    ...(process.env.TSX_TSCONFIG_PATH === undefined
      ? {}
      : { tsxConfigPath: process.env.TSX_TSCONFIG_PATH }),
    ...(process.env[RESTORE_ENVIRONMENT] === undefined
      ? {}
      : { privateValue: process.env[RESTORE_ENVIRONMENT] }),
  };
  // The caller's additions sit between the inherited environment and the executor's
  // own variables, so they can shadow an inherited value but never the two names the
  // bootstrap needs. `resolveControl` rejects those names as well; this is belt and braces.
  return {
    ...process.env,
    ...control.env,
    TSX_TSCONFIG_PATH: workspace.tsconfig,
    [RESTORE_ENVIRONMENT]: JSON.stringify(state),
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function waitForExit(child: ChildProcess): Promise<ExitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let processError: Error | undefined;
    child.on("error", (error) => {
      if (settled) return;
      processError ??= error;
      // A failed spawn has no process to reap. IPC errors after a successful
      // spawn do NOT mean the child exited: retain leases until exit.
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

/**
 * Bytes the direct child wrote before exiting are already in the kernel pipe buffer
 * when `exit` is observed; one further poll phase reads them. Two `setImmediate`
 * turns guarantee that poll phase ran even if the event loop was blocked when the
 * child exited. Descendants holding the pipe open are cut off afterwards (EPIPE).
 */
function drainAfterExit(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(resolve));
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (error) {
    // ESRCH: no member of the group remains. Anything else: fall back to the direct child.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

/**
 * Terminates the guest's process group once: SIGTERM first, SIGKILL after the grace
 * period. `beforeKill` runs first, so the host bridge is closed before the group is
 * signalled. The caller's signal counts only until the child's exit is observed.
 */
class Terminator {
  readonly #child: ChildProcess;
  readonly #signal: AbortSignal | undefined;
  readonly #beforeKill: () => void;
  #triggered = false;
  #disposed = false;
  #aborted = false;
  #escalation: NodeJS.Timeout | undefined;
  readonly #onAbort = (): void => {
    this.#aborted = true;
    this.trigger();
  };
  readonly #onExit = (): void => {
    this.#signal?.removeEventListener("abort", this.#onAbort);
  };

  constructor(child: ChildProcess, signal: AbortSignal | undefined, beforeKill: () => void) {
    this.#child = child;
    this.#signal = signal;
    this.#beforeKill = beforeKill;
    // Not yet aborted: runSubprocess spawns nothing for an aborted signal, and runs no
    // other code between that check and here.
    signal?.addEventListener("abort", this.#onAbort, { once: true });
    // Ahead of every other exit listener, so nothing they run can still count as an abort.
    child.prependOnceListener("exit", this.#onExit);
  }

  /** Whether the caller's signal aborted before the child exited (not a later abort). */
  get aborted(): boolean {
    return this.#aborted;
  }

  trigger(): void {
    // After dispose the child has been reaped: a late trigger (a sink throwing on the
    // final decoder flush) must not arm a SIGKILL for a process group id that may be reused.
    if (this.#triggered || this.#disposed) return;
    this.#triggered = true;
    this.#beforeKill();
    killGroup(this.#child, "SIGTERM");
    this.#escalation = setTimeout(() => killGroup(this.#child, "SIGKILL"), KILL_GRACE_MS);
  }

  dispose(): void {
    this.#disposed = true;
    this.#onExit();
    this.#child.removeListener("exit", this.#onExit);
    if (this.#escalation !== undefined) clearTimeout(this.#escalation);
  }
}

/**
 * Delivers one output stream to the caller's sink as UTF-8 text. A sink that throws
 * is reported through `onFailure` and receives nothing further.
 */
function forward(stream: Readable | null, sink: OutputSink | undefined, onFailure: (error: Error) => void): () => void {
  if (stream === null || sink === undefined) return () => {};
  const decoder = new StringDecoder("utf8");
  let failed = false;
  const deliver = (text: string): void => {
    if (failed || text.length === 0) return;
    try {
      sink(text);
    } catch (error) {
      failed = true;
      onFailure(toError(error));
    }
  };
  stream.on("data", (chunk: Buffer) => deliver(decoder.write(chunk)));
  stream.on("error", () => {});
  return () => deliver(decoder.end());
}

/**
 * Starts and reaps one child without interpreting the result envelope.
 * stdout and stderr go to the caller's sinks (or nowhere); the host waits only for
 * the direct child's exit, never for pipe EOF. After the child exits, whatever is left
 * in its process group is killed, so nothing the guest started outlives the execution.
 */
export async function runSubprocess(
  workspace: PreparedWorkspace,
  cwd: string,
  bootstrap: string,
  arguments_: readonly string[],
  control: ResolvedControl,
): Promise<SubprocessResult> {
  // An abort while the caller was still preparing (workspace, check, input file) starts nothing.
  if (control.signal?.aborted === true) return Object.freeze({ exitCode: null, signal: null, aborted: true });

  let outcome: ExitOutcome = { exitCode: null, signal: null };
  let sinkError: Error | undefined;
  let closeBridge: (() => void) | undefined;
  let terminator: Terminator | undefined;
  let child: ChildProcess | undefined;
  const flushes: (() => void)[] = [];
  try {
    child = spawn(
      process.execPath,
      ["--import", tsxImport, bootstrap, ...arguments_],
      {
        cwd,
        env: environment(workspace, control),
        // Own process group so an abort and the final reaping reach guest descendants too.
        detached: process.platform !== "win32",
        stdio: [
          "ignore",
          control.onStdout === undefined ? "ignore" : "pipe",
          control.onStderr === undefined ? "ignore" : "pipe",
          ...(workspace.hostBindings.size === 0 ? [] : ["ipc" as const]),
        ],
        serialization: "json",
      },
    );
    const started = child;
    if (workspace.hostBindings.size > 0) {
      closeBridge = attachHostBridge(started, async (id, method, input, signal) => {
        const binding = workspace.hostBindings.get(id);
        if (binding === undefined) throw new Error("Host module is not registered for this execution");
        return binding.invoke(method, input, signal);
      });
    }
    terminator = new Terminator(started, control.signal, closeBridge ?? (() => {}));
    const stop = terminator;
    const onSinkFailure = (error: Error): void => {
      sinkError ??= error;
      stop.trigger();
    };
    flushes.push(forward(started.stdout, control.onStdout, onSinkFailure));
    flushes.push(forward(started.stderr, control.onStderr, onSinkFailure));
    outcome = await waitForExit(started);
    if (started.pid !== undefined) {
      await drainAfterExit();
      // The leader is gone, so this only reaches remaining members of its group
      // (ESRCH when none remain). A descendant that moved to its own session is out of reach.
      killGroup(started, "SIGKILL");
    }
  } catch (error) {
    outcome = { exitCode: null, signal: null, error: toError(error) };
  } finally {
    closeBridge?.();
    terminator?.dispose();
    for (const flush of flushes) flush();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
  }

  const aborted = sinkError === undefined && terminator?.aborted === true;
  const error = sinkError ?? outcome.error;
  return Object.freeze({
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    aborted,
    ...(error === undefined ? {} : { error }),
  });
}
