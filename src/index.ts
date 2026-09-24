export { RESERVED_ENVIRONMENT_NAMES } from "./control.js";
export { ExecutionAbortedError, TypeCheckError } from "./errors.js";
export { hostModule } from "./modules/host-module.js";
export type { HostCall, HostCallContext, HostModule, HostModuleOptions } from "./modules/host-module.js";
export { packageModule } from "./modules/package-module.js";
export { TSFuncExecutor } from "./ts-func-executor.js";

export type {
  CheckRequest,
  CheckResult,
  Diagnostic,
  DiagnosticCategory,
  ExecutionControl,
  ExecutorOptions,
  JsonValue,
  ListModulesRequest,
  MaterializeContext,
  MaterializedModule,
  Module,
  ModuleSummary,
  PackageModuleOptions,
  TSFuncExecuteRequest,
  TSFuncExecuteResult,
} from "./types.js";
