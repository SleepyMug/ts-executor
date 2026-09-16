import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { ResolvedControl } from "../limits.js";
import type { AbortReason, OutputTruncation } from "../types.js";
import type { PreparedWorkspace } from "../workspace.js";
import { attachHostBridge } from "./host-bridge.js";

export interface SubprocessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: OutputTruncation;
  /** Set when the host terminated the process group on abort or deadline. */
  readonly aborted?: AbortReason;
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

/**
 * Retains at most `limit` bytes of a stream and discards the rest. Bytes beyond the
 * limit are still consumed so the guest is never blocked on a full pipe.
 */
class BoundedCapture {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #retained = 0;
  #truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    const room = this.#limit - this.#retained;
    if (room <= 0) {
      if (chunk.length > 0) this.#truncated = true;
      return;
    }
    if (chunk.length <= room) {
      this.#chunks.push(chunk);
      this.#retained += chunk.length;
      return;
    }
    this.#chunks.push(chunk.subarray(0, room));
    this.#retained = this.#limit;
    this.#truncated = true;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  text(): string {
    return Buffer.concat(this.#chunks, this.#retained).toString("utf8");
  }
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
 * Terminates the guest process group on abort or deadline: SIGTERM first, SIGKILL
 * after the grace period. Returns the abort reason once triggered.
 */
class Terminator {
  readonly #child: ChildProcess;
  readonly #control: ResolvedControl;
  #reason: AbortReason | undefined;
  #deadline: NodeJS.Timeout | undefined;
  #escalation: NodeJS.Timeout | undefined;
  readonly #onAbort = (): void => this.trigger("signal");

  constructor(child: ChildProcess, control: ResolvedControl) {
    this.#child = child;
    this.#control = control;
    control.signal?.addEventListener("abort", this.#onAbort, { once: true });
    if (control.deadlineAt !== undefined) {
      const remaining = Math.max(0, control.deadlineAt - performance.now());
      this.#deadline = setTimeout(() => this.trigger("timeout"), remaining);
    }
    if (control.signal?.aborted === true) this.trigger("signal");
  }

  trigger(reason: AbortReason): void {
    if (this.#reason !== undefined) return;
    this.#reason = reason;
    killGroup(this.#child, "SIGTERM");
    this.#escalation = setTimeout(() => killGroup(this.#child, "SIGKILL"), this.#control.killGraceMs);
  }

  get reason(): AbortReason | undefined {
    return this.#reason;
  }

  dispose(): void {
    this.#control.signal?.removeEventListener("abort", this.#onAbort);
    if (this.#deadline !== undefined) clearTimeout(this.#deadline);
    if (this.#escalation !== undefined) clearTimeout(this.#escalation);
  }
}

/**
 * Starts and reaps one child without interpreting any flavor-specific status file.
 * fd 1 and fd 2 are pipes drained into bounded buffers; the host waits only for the
 * direct child's exit, never for pipe EOF.
 */
export async function runSubprocess(
  workspace: PreparedWorkspace,
  cwd: string,
  bootstrap: string,
  arguments_: readonly string[],
  control: ResolvedControl,
): Promise<SubprocessResult> {
  const stdout = new BoundedCapture(control.maxOutputBytes);
  const stderr = new BoundedCapture(control.maxOutputBytes);
  let outcome: ExitOutcome = { exitCode: null, signal: null };
  let closeBridge: (() => void) | undefined;
  let terminator: Terminator | undefined;
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      ["--import", tsxImport, bootstrap, ...arguments_],
      {
        cwd,
        env: environment(workspace, control),
        // Own process group so abort/timeout can terminate guest descendants too.
        detached: process.platform !== "win32",
        stdio: workspace.hostBindings.size === 0
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
      },
    );
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    terminator = new Terminator(child, control);
    if (workspace.hostBindings.size > 0) {
      closeBridge = attachHostBridge(child, async (id, method, input, signal) => {
        const binding = workspace.hostBindings.get(id);
        if (binding === undefined) throw new Error("Host module is not registered for this execution");
        return binding.invoke(method, input, signal);
      });
    }
    outcome = await waitForExit(child);
    if (child.pid !== undefined) {
      await drainAfterExit();
      // Opt-in reaping of children the guest left behind: the leader is gone, so
      // this only reaches remaining members of its group (ESRCH when none remain).
      if (control.killGroupOnExit) killGroup(child, "SIGKILL");
    }
  } catch (error) {
    outcome = {
      exitCode: null,
      signal: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    closeBridge?.();
    terminator?.dispose();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
  }

  const aborted = terminator?.reason;
  return Object.freeze({
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: Object.freeze({ stdout: stdout.truncated, stderr: stderr.truncated }),
    ...(aborted === undefined ? {} : { aborted }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  });
}
