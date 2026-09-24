import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { instructions } from "./agent-instructions.js";
import { checkWorkspace } from "./check.js";
import { resolveControl } from "./control.js";
import { attachCleanupError, ExecutionAbortedError, TypeCheckError } from "./errors.js";
import { acquireHostModules, assertHostModulesOpen } from "./host-bindings.js";
import { inputEnvelopeJson } from "./json-value.js";
import { ModuleRegistry } from "./registry.js";
import { runTSFuncProcess } from "./runtime/run-ts-func.js";
import { fileUrlPath, resolveResolutionRoot } from "./storage.js";
import type {
  CheckRequest,
  CheckResult,
  ExecutorOptions,
  JsonValue,
  ListModulesRequest,
  ModuleSummary,
  TSFuncExecuteRequest,
  TSFuncExecuteResult,
} from "./types.js";
import { prepareWorkspace, removeWorkspace, type PreparedWorkspace } from "./workspace.js";

const IntrinsicURL = URL;
const objectHasOwn = Object.hasOwn;

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

/**
 * Checks and runs one TypeScript program per call, each in a fresh Node subprocess:
 * `main(input)` receives JSON input and resolves to a JSON result. Registered modules
 * (local packages and host modules) are importable by specifier.
 */
export class TSFuncExecutor {
  readonly modules = new ModuleRegistry();
  readonly #resolutionRoot: string;

  constructor(options: ExecutorOptions) {
    this.#resolutionRoot = resolveResolutionRoot(options?.resolutionRoot, "TSFuncExecutor");
  }

  /** Model-facing instructions for the `listModules` and `execute` tools. */
  getInstructions(): string {
    return instructions;
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
   * A pre-aborted signal rejects before any lease, workspace, or check. Checking is
   * synchronous and cannot be interrupted; the subprocess primitive checks the signal
   * once more immediately before spawning.
   */
  async execute<
    Input extends JsonValue = JsonValue,
    Output extends JsonValue = JsonValue,
  >(
    request: TSFuncExecuteRequest<Input>,
  ): Promise<TSFuncExecuteResult<Output>> {
    const control = resolveControl(request, performance.now());
    if (control.signal?.aborted === true) throw new ExecutionAbortedError(0);
    const snapshot = this.modules.snapshot();
    const host = acquireHostModules(snapshot);
    try {
      const inputEnvelope = inputEnvelopeJson(objectHasOwn(request, "input"), request.input);
      const cwd = await executionCwd(request.cwd);
      const workspace = await prepareWorkspace(this.#resolutionRoot, snapshot, request.source, host.bindings);
      const value = await withWorkspace(workspace, async () => {
        if (request.check !== false) {
          const checked = checkWorkspace(workspace);
          if (!checked.ok) throw new TypeCheckError(checked.diagnostics);
        }
        return runTSFuncProcess(workspace, cwd, inputEnvelope, control);
      });
      return Object.freeze({ value: value as Output, durationMs: performance.now() - control.startedAt });
    } finally {
      host.release();
    }
  }
}
