import { ExecutorCore } from "./executor-core.js";
import { runProcProcess } from "./runtime/run-proc.js";
import type {
  CheckRequest,
  CheckResult,
  ExecutorOptions,
  ListModulesRequest,
  ModuleSummary,
  ProcExecuteRequest,
} from "./types.js";

export class ProcExecutor {
  readonly #core: ExecutorCore;
  readonly modules;

  constructor(options: ExecutorOptions) {
    this.#core = new ExecutorCore(options, "ProcExecutor");
    this.modules = this.#core.modules;
  }

  getInstructions(): string {
    return this.#core.getInstructions();
  }

  async listModules(request?: ListModulesRequest): Promise<readonly ModuleSummary[]> {
    return this.#core.listModules(request);
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    return this.#core.check(request);
  }

  async execute(request: ProcExecuteRequest): Promise<string> {
    return this.#core.execute(
      request,
      () => undefined,
      async (workspace, cwd) => runProcProcess(workspace, cwd),
    );
  }
}
