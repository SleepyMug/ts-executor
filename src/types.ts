/// <reference types="node" preserve="true" />

import type { URL } from "node:url";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface DeclarationTree {
  readonly entrypoint: string;
  readonly files: Readonly<Record<string, string>>;
}

export interface MaterializeContext {
  /** Operation-local directory a module may populate. */
  readonly packageRoot: string;
  readonly workspaceRoot: string;
}

export interface MaterializedModule {
  /** Directory containing this module's package.json. */
  readonly packageRoot: string;
}

export interface Module {
  readonly specifier: string;
  readonly description?: string;
  materialize(context: MaterializeContext): Promise<MaterializedModule>;
}

export interface ModuleSummary {
  readonly specifier: string;
  readonly description?: string;
}

export interface ListModulesRequest {
  readonly query?: string;
}

export interface CheckRequest {
  readonly source: string;
}

export type DiagnosticCategory = "warning" | "error" | "suggestion" | "message";

export interface Diagnostic {
  readonly category: DiagnosticCategory;
  readonly code: number;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ExecutorOptions {
  /** Package-resolution base and parent of ephemeral operation workspaces. */
  readonly resolutionRoot: string | URL;
}

export interface TSFuncExecuteRequest<Input extends JsonValue = JsonValue> {
  readonly source: string;
  /** Absolute directory path or file URL used only as the subprocess working directory. */
  readonly cwd: string | URL;
  readonly input?: Input;
  /** Typecheck before execution. Defaults to true. */
  readonly check?: boolean;
}

export interface TSFuncExecuteResult<Output extends JsonValue = JsonValue> {
  readonly value: Output;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface ProcExecuteRequest {
  readonly source: string;
  /** Absolute directory path or file URL used only as the subprocess working directory. */
  readonly cwd: string | URL;
  /** Typecheck before execution. Defaults to true. */
  readonly check?: boolean;
}

export interface PackageModuleOptions {
  readonly specifier: string;
  readonly root: string;
  readonly description?: string;
}
