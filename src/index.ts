export { ProcExecutionError, TypeCheckError } from "./errors.js";
export { packageModule } from "./modules/package-module.js";
export { ProcExecutor } from "./proc-executor.js";
export { TSFuncExecutor } from "./ts-func-executor.js";

export type {
  CheckRequest,
  CheckResult,
  DeclarationTree,
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
