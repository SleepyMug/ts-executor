import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkspace } from "./check.js";
import { declarationTree } from "./declarations.js";
import { TypeCheckError } from "./errors.js";
import { ModuleRegistry } from "./registry.js";
import type {
  CheckRequest,
  CheckResult,
  DeclarationTree,
  ExecutorOptions,
  ListModulesRequest,
  Module,
  ModuleSummary,
} from "./types.js";
import { prepareWorkspace, removeWorkspace, type PreparedWorkspace } from "./workspace.js";

const IntrinsicURL = URL;

interface SharedExecuteRequest {
  readonly source: string;
  readonly cwd: string | URL;
  readonly check?: boolean;
}

function owningModule(modules: readonly Module[], requested: string): Module | undefined {
  return modules
    .filter((module) => requested === module.specifier || requested.startsWith(`${module.specifier}/`))
    .sort((left, right) => right.specifier.length - left.specifier.length)[0];
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
  readonly #resolutionRoot: string;

  constructor(options: ExecutorOptions, executorName: string) {
    this.#resolutionRoot = resolutionRootPath(options?.resolutionRoot, executorName);
  }

  async listModules(request?: ListModulesRequest): Promise<readonly ModuleSummary[]> {
    const snapshot = this.modules.snapshot();
    const query = request?.query?.trim().toLowerCase();
    const summaries = snapshot
      .filter((module) => {
        if (query === undefined || query.length === 0) return true;
        return `${module.specifier}\n${module.description ?? ""}`.toLowerCase().includes(query);
      })
      .map((module) =>
        Object.freeze({
          specifier: module.specifier,
          ...(module.description === undefined ? {} : { description: module.description }),
        }),
      );
    return Object.freeze(summaries);
  }

  async getTypes(requested: string): Promise<DeclarationTree> {
    if (typeof requested !== "string" || requested.length === 0) {
      throw new TypeError("getTypes requires a module specifier");
    }
    const snapshot = this.modules.snapshot();
    const owner = owningModule(snapshot, requested);
    if (owner === undefined) {
      throw new Error(`No registered module owns ${JSON.stringify(requested)}`);
    }
    const workspace = await prepareWorkspace(this.#resolutionRoot, snapshot, "export {};\n");
    return withWorkspace(workspace, async () => declarationTree(workspace, requested, owner.specifier));
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    const snapshot = this.modules.snapshot();
    const workspace = await prepareWorkspace(this.#resolutionRoot, snapshot, request.source);
    return withWorkspace(workspace, async () => checkWorkspace(workspace));
  }

  async execute<State, Result>(
    request: SharedExecuteRequest,
    captureFlavorState: () => State,
    operation: (workspace: PreparedWorkspace, cwd: string, state: State) => Promise<Result>,
  ): Promise<Result> {
    const snapshot = this.modules.snapshot();
    const state = captureFlavorState();
    const cwd = await executionCwd(request.cwd);
    const workspace = await prepareWorkspace(this.#resolutionRoot, snapshot, request.source);
    return withWorkspace(workspace, async () => {
      if (request.check !== false) {
        const checked = checkWorkspace(workspace);
        if (!checked.ok) throw new TypeCheckError(checked.diagnostics);
      }
      return operation(workspace, cwd, state);
    });
  }
}
