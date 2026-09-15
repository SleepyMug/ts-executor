import { ExecutorCore } from "./executor-core.js";
import { inputEnvelopeJson } from "./json-value.js";
import { runTSFuncProcess } from "./runtime/run-ts-func.js";
import type {
  CheckRequest,
  CheckResult,
  ExecutorOptions,
  InstructionsOptions,
  JsonValue,
  ListModulesRequest,
  ModuleSummary,
  TSFuncExecuteRequest,
  TSFuncExecuteResult,
} from "./types.js";

const objectHasOwn = Object.hasOwn;

export class TSFuncExecutor {
  readonly #core: ExecutorCore;
  readonly modules;

  constructor(options: ExecutorOptions) {
    this.#core = new ExecutorCore(options, "TSFuncExecutor");
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

  async execute<
    Input extends JsonValue = JsonValue,
    Output extends JsonValue = JsonValue,
  >(
    request: TSFuncExecuteRequest<Input>,
  ): Promise<TSFuncExecuteResult<Output>> {
    const result = await this.#core.execute(
      request,
      () => inputEnvelopeJson(objectHasOwn(request, "input"), request.input),
      async (workspace, cwd, inputEnvelope, control) => {
        const process = await runTSFuncProcess(workspace, cwd, inputEnvelope, control);
        return { ...process, durationMs: performance.now() - control.startedAt };
      },
    );
    return Object.freeze({
      value: result.value as Output,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      durationMs: result.durationMs,
    });
  }
}
