export { ExecutionAbortedError, ProcExecutionError, TypeCheckError } from "./errors.js";
export type { CapturedTermination } from "./errors.js";
export { DEFAULT_KILL_GRACE_MS, DEFAULT_MAX_OUTPUT_BYTES, RESERVED_ENVIRONMENT_NAMES } from "./limits.js";
export { packageModule } from "./modules/package-module.js";
export { Type } from "@sinclair/typebox";
export { hostFunction } from "./host-function.js";
export type { HostCallContext, HostFunction, HostFunctionOptions } from "./host-function.js";
export { hostModule } from "./modules/host-module.js";
export type { HostModule, HostModuleOptions } from "./modules/host-module.js";
export { ProcExecutor } from "./proc-executor.js";
export { TSFuncExecutor } from "./ts-func-executor.js";

export type {
  AbortReason,
  CheckRequest,
  CheckResult,
  Diagnostic,
  DiagnosticCategory,
  ExecutionControl,
  ExecutorOptions,
  InstructionsOptions,
  JsonValue,
  ListModulesRequest,
  MaterializeContext,
  MaterializedModule,
  Module,
  ModuleSummary,
  OutputTruncation,
  PackageModuleOptions,
  ProcExecuteRequest,
  ProcExecuteResult,
  TSFuncExecuteRequest,
  TSFuncExecuteResult,
} from "./types.js";
