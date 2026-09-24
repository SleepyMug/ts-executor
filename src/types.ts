/// <reference types="node" preserve="true" />

import type { URL } from "node:url";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface MaterializeContext {
  /** Operation-local directory a module may populate. */
  readonly packageRoot: string;
  readonly workspaceRoot: string;
}

export interface MaterializedModule {
  /** Directory containing this module's package.json. */
  readonly packageRoot: string;
}

export interface Module extends ModuleSummary {
  materialize(context: MaterializeContext): Promise<MaterializedModule>;
}

export interface ModuleSummary {
  readonly specifier: string;
  /** Absolute package directory for API inspection; must remain readable between operations. */
  readonly packageRoot: string;
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

/**
 * How the caller controls one execution. Deadlines and output limits are the caller's:
 * abort `signal` when time is up, and bound what `onStdout`/`onStderr` keep.
 */
export interface ExecutionControl {
  /**
   * Aborting closes the guest's host-call channel, terminates its whole process group
   * (SIGTERM, then SIGKILL after a grace period), and rejects with
   * `ExecutionAbortedError`. Type-checking is synchronous: an abort during it takes
   * effect before the guest would spawn. An abort after the guest exited does not count.
   * Combine the caller's own signals, e.g. `AbortSignal.any([signal, AbortSignal.timeout(ms)])`,
   * for a deadline.
   */
  readonly signal?: AbortSignal;
  /**
   * Extra environment variables for this one guest, merged over the inherited
   * environment. The host's own `process.env` is never modified, so concurrent
   * executions cannot observe each other's values. Keys must be non-empty and free
   * of `=` and NUL; values must be strings without NUL. The executor's own variables
   * (`TSX_TSCONFIG_PATH` and its private restore variable) may not be overridden —
   * naming one throws rather than being ignored. This adds variables; it does not
   * remove or filter inherited ones.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Receives the guest's stdout as it is written, decoded as UTF-8. The executor keeps
   * none of it; without a sink the stream is discarded. A sink that throws aborts the
   * execution, which then rejects with that error.
   */
  readonly onStdout?: (text: string) => void;
  /** Like `onStdout`, for stderr. */
  readonly onStderr?: (text: string) => void;
}

export interface TSFuncExecuteRequest<Input extends JsonValue = JsonValue> extends ExecutionControl {
  readonly source: string;
  /** Absolute directory path or file URL used only as the subprocess working directory. */
  readonly cwd: string | URL;
  readonly input?: Input;
  /** Typecheck before execution. Defaults to true. */
  readonly check?: boolean;
}

export interface TSFuncExecuteResult<Output extends JsonValue = JsonValue> {
  readonly value: Output;
  readonly durationMs: number;
}

export interface PackageModuleOptions {
  readonly specifier: string;
  readonly root: string;
  readonly description?: string;
}
