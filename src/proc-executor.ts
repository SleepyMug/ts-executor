import { ProcExecutionError } from "./errors.js";
import { ExecutorCore } from "./executor-core.js";
import { runProcProcess } from "./runtime/run-proc.js";
import type {
  CheckRequest,
  CheckResult,
  ExecutorOptions,
  InstructionsOptions,
  ListModulesRequest,
  ModuleSummary,
  ProcExecuteRequest,
  ProcExecuteResult,
} from "./types.js";

export class ProcExecutor {
  readonly #core: ExecutorCore;
  readonly modules;

  constructor(options: ExecutorOptions) {
    this.#core = new ExecutorCore(options, "ProcExecutor");
    this.modules = this.#core.modules;
  }

  getInstructions(options?: InstructionsOptions): string {
    return this.#core.getInstructions(options);
  }

  async listModules(request?: ListModulesRequest): Promise<readonly ModuleSummary[]> {
    return this.#core.listModules(request);
  }

  async check(request: CheckRequest): Promise<CheckResult> {
    return this.#core.check(request);
  }

  /**
   * Exact captured stdout. When stdout exceeded `maxOutputBytes` the exact string no
   * longer exists, so this rejects with `ProcExecutionError` (`truncated.stdout` true)
   * rather than returning a silently incomplete value; use `executeDetailed` to
   * receive the retained prefix with its truncation flags.
   */
  async execute(request: ProcExecuteRequest): Promise<string> {
    const result = await this.executeDetailed(request);
    if (result.truncated.stdout) {
      throw new ProcExecutionError(
        "Proc stdout exceeded maxOutputBytes; the retained prefix is available via executeDetailed",
        { stdout: result.stdout, stderr: "", truncated: result.truncated, exitCode: 0, signal: null },
      );
    }
    return result.stdout;
  }

  /** Stdout plus truncation flags and duration; never rejects merely because output was capped. */
  async executeDetailed(request: ProcExecuteRequest): Promise<ProcExecuteResult> {
    return this.#core.execute(
      request,
      () => undefined,
      async (workspace, cwd, _state, control) => {
        const process = await runProcProcess(workspace, cwd, control);
        return Object.freeze({
          stdout: process.stdout,
          truncated: process.truncated,
          durationMs: performance.now() - control.startedAt,
        });
      },
    );
  }
}
