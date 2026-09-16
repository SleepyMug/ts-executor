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

/** Per-stream flags: true when captured bytes beyond `maxOutputBytes` were discarded. */
export interface OutputTruncation {
  readonly stdout: boolean;
  readonly stderr: boolean;
}

/** Why an execution was terminated by the host rather than by the guest settling. */
export type AbortReason = "signal" | "timeout";

/**
 * Cancellation and capture limits shared by both execution flavors.
 * Cancellation kills the guest's whole process group; see the executor docs.
 */
export interface ExecutionControl {
  /** Aborting terminates the guest process group and rejects with `ExecutionAbortedError`. */
  readonly signal?: AbortSignal;
  /**
   * Wall-clock deadline in milliseconds measured from the `execute` call, covering
   * checking and execution. Positive integer; omitted means no deadline.
   */
  readonly timeoutMs?: number;
  /**
   * Bytes retained per stream (stdout and stderr separately). Positive integer;
   * defaults to `DEFAULT_MAX_OUTPUT_BYTES`. Further bytes are read and discarded.
   */
  readonly maxOutputBytes?: number;
  /** Milliseconds between SIGTERM and SIGKILL on abort/timeout. Defaults to `DEFAULT_KILL_GRACE_MS`. */
  readonly killGraceMs?: number;
  /**
   * After the guest exits normally and its output is captured, SIGKILL whatever is
   * left in its process group (best effort) so leftover children do not outlive the
   * execution. Defaults to false: descendants survive a normal exit. A descendant
   * that moved to its own session (e.g. `detached: true`) is out of reach either way.
   */
  readonly killGroupOnExit?: boolean;
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
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: OutputTruncation;
  readonly durationMs: number;
}

export interface ProcExecuteRequest extends ExecutionControl {
  readonly source: string;
  /** Absolute directory path or file URL used only as the subprocess working directory. */
  readonly cwd: string | URL;
  /** Typecheck before execution. Defaults to true. */
  readonly check?: boolean;
}

/** Result of `ProcExecutor.executeDetailed`: stdout plus what `execute` cannot express. */
export interface ProcExecuteResult {
  readonly stdout: string;
  readonly truncated: OutputTruncation;
  readonly durationMs: number;
}

/** Effective limits the harness enforces, so `getInstructions` can state them to the model. */
export interface InstructionsOptions {
  /** The deadline the harness passes to every `execute`, if any. */
  readonly timeoutMs?: number;
  /** The per-stream retention cap the harness passes; defaults to `DEFAULT_MAX_OUTPUT_BYTES`. */
  readonly maxOutputBytes?: number;
  /** Whether the harness passes `killGroupOnExit`, so the model knows started processes end with the program. */
  readonly killGroupOnExit?: boolean;
}

export interface PackageModuleOptions {
  readonly specifier: string;
  readonly root: string;
  readonly description?: string;
}
