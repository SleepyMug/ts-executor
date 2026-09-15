import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instructionsFor } from "./agent-instructions.js";
import { checkWorkspace } from "./check.js";
import { ExecutionAbortedError, TypeCheckError } from "./errors.js";
import { acquireHostModules, assertHostModulesOpen } from "./host-bindings.js";
import { pendingAbort, resolveControl, type ResolvedControl } from "./limits.js";
import { ModuleRegistry } from "./registry.js";
import type {
  AbortReason,
  CheckRequest,
  CheckResult,
  ExecutionControl,
  ExecutorOptions,
  InstructionsOptions,
  ListModulesRequest,
  ModuleSummary,
} from "./types.js";
import { prepareWorkspace, removeWorkspace, type PreparedWorkspace } from "./workspace.js";

const IntrinsicURL = URL;

interface SharedExecuteRequest extends ExecutionControl {
  readonly source: string;
  readonly cwd: string | URL;
  readonly check?: boolean;
}

function abortedBeforeStart(reason: AbortReason, control: ResolvedControl): ExecutionAbortedError {
  return new ExecutionAbortedError(reason, {
    stdout: "",
    stderr: "",
    truncated: Object.freeze({ stdout: false, stderr: false }),
    exitCode: null,
    signal: null,
    durationMs: performance.now() - control.startedAt,
  });
}

function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if ((typeof primary !== "object" && typeof primary !== "function") || primary === null) return;
  try {
    Object.defineProperty(primary, "cleanupError", {
      value: cleanup,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Preserve the primary operation failure even if it cannot accept metadata.
  }
}

async function withWorkspace<Result>(
  workspace: PreparedWorkspace,
  operation: () => Promise<Result>,
): Promise<Result> {
  let failed = false;
  let primaryFailure: unknown;
  try {
    return await operation();
  } catch (error) {
    failed = true;
    primaryFailure = error;
    throw error;
  } finally {
    try {
      await removeWorkspace(workspace);
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      attachCleanupError(primaryFailure, cleanupError);
    }
  }
}

function fileUrlPath(value: URL, label: string): string {
  if (!value.href.startsWith("file:") || value.search.length > 0 || value.hash.length > 0) {
    throw new TypeError(`${label} must be a file: URL without a query or fragment`);
  }
  try {
    return fileURLToPath(value);
  } catch (error) {
    throw new TypeError(`${label} must be a valid local file: URL`, { cause: error });
  }
}

function resolutionRootPath(value: string | URL | undefined, executorName: string): string {
  if (typeof value === "string") {
    if (value.length === 0) throw new TypeError(`${executorName} requires resolutionRoot`);
    return resolve(value);
  }
  if (value instanceof IntrinsicURL) return resolve(fileUrlPath(value, "resolutionRoot"));
  throw new TypeError(`${executorName} requires resolutionRoot`);
}

async function executionCwd(value: string | URL | undefined): Promise<string> {
  let cwd: string;
  if (typeof value === "string") {
    if (!isAbsolute(value)) {
      throw new TypeError("execute.cwd must be an absolute filesystem path or file: URL");
    }
    cwd = resolve(value);
  } else if (value instanceof IntrinsicURL) {
    cwd = resolve(fileUrlPath(value, "execute.cwd"));
  } else {
    throw new TypeError("execute.cwd is required and must be an absolute filesystem path or file: URL");
  }

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch (error) {
    throw new Error(`execute.cwd does not exist: ${JSON.stringify(cwd)}`, { cause: error });
  }
  if (!cwdStat.isDirectory()) {
    throw new Error(`execute.cwd is not a directory: ${JSON.stringify(cwd)}`);
  }
  return cwd;
}

export class ExecutorCore {
  readonly modules = new ModuleRegistry();
  readonly #executorName: "TSFuncExecutor" | "ProcExecutor";
  readonly #resolutionRoot: string;

  constructor(options: ExecutorOptions, executorName: "TSFuncExecutor" | "ProcExecutor") {
    this.#executorName = executorName;
    this.#resolutionRoot = resolutionRootPath(options?.resolutionRoot, executorName);
  }

  getInstructions(options?: InstructionsOptions): string {
    return instructionsFor(this.#executorName, options);
  }

  async listModules(request?: ListModulesRequest): Promise<readonly ModuleSummary[]> {
    const snapshot = this.modules.snapshot();
    assertHostModulesOpen(snapshot);
    const query = request?.query?.trim().toLowerCase();
    const summaries = snapshot
      .filter((module) => {
        if (query === undefined || query.length === 0) return true;
        return `${module.specifier}\n${module.description ?? ""}`.toLowerCase().includes(query);
      })
      .map((module) =>
        Object.freeze({
          specifier: module.specifier,
          packageRoot: module.packageRoot,
          ...(module.description === undefined ? {} : { description: module.description }),
        }),
      );
    return Object.freeze(summaries);
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    const snapshot = this.modules.snapshot();
    const host = acquireHostModules(snapshot);
    try {
      const workspace = await prepareWorkspace(this.#resolutionRoot, snapshot, request.source, host.bindings);
      return await withWorkspace(workspace, async () => checkWorkspace(workspace));
    } finally {
      host.release();
    }
  }

  /**
   * The deadline clock starts here. A pre-aborted signal rejects before any lease,
   * workspace, or check; checking is synchronous and cannot be interrupted, so the
   * signal and deadline are re-checked once more immediately before spawning.
   */
  async execute<State, Result>(
    request: SharedExecuteRequest,
    captureFlavorState: () => State,
    operation: (
      workspace: PreparedWorkspace,
      cwd: string,
      state: State,
      control: ResolvedControl,
    ) => Promise<Result>,
  ): Promise<Result> {
    const control = resolveControl(request, performance.now());
    const early = pendingAbort(control, control.startedAt);
    if (early !== undefined) throw abortedBeforeStart(early, control);
    const snapshot = this.modules.snapshot();
    const host = acquireHostModules(snapshot);
    try {
      const state = captureFlavorState();
      const cwd = await executionCwd(request.cwd);
      const workspace = await prepareWorkspace(this.#resolutionRoot, snapshot, request.source, host.bindings);
      return await withWorkspace(workspace, async () => {
        if (request.check !== false) {
          const checked = checkWorkspace(workspace);
          if (!checked.ok) throw new TypeCheckError(checked.diagnostics);
        }
        const late = pendingAbort(control, performance.now());
        if (late !== undefined) throw abortedBeforeStart(late, control);
        return operation(workspace, cwd, state, control);
      });
    } finally {
      host.release();
    }
  }
}
