export { ProcExecutionError, TypeCheckError } from "./errors.js";
export { packageModule } from "./modules/package-module.js";
export { Type } from "@sinclair/typebox";
export { hostFunction } from "./host-function.js";
export type { HostCallContext, HostFunction, HostFunctionOptions } from "./host-function.js";
export { hostModule } from "./modules/host-module.js";
export type { HostModule, HostModuleOptions } from "./modules/host-module.js";
export { ProcExecutor } from "./proc-executor.js";
export { TSFuncExecutor } from "./ts-func-executor.js";

export type {
  CheckRequest,
  CheckResult,
  Diagnostic,
  DiagnosticCategory,
  ExecutorOptions,
  JsonValue,
  ListModulesRequest,
  MaterializeContext,
  MaterializedModule,
  Module,
  ModuleSummary,
  PackageModuleOptions,
  ProcExecuteRequest,
  TSFuncExecuteRequest,
  TSFuncExecuteResult,
} from "./types.js";
