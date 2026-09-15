import type { AbortReason, Diagnostic, OutputTruncation } from "./types.js";

export class TypeCheckError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const detail = diagnostics
      .filter((diagnostic) => diagnostic.category === "error")
      .slice(0, 5)
      .map((diagnostic) => {
        const location = diagnostic.file === undefined
          ? ""
          : `${diagnostic.file}:${diagnostic.line ?? 1}:${diagnostic.column ?? 1} `;
        return `${location}TS${diagnostic.code}: ${diagnostic.message}`;
      })
      .join("\n");
    super(`TypeScript check failed${detail.length === 0 ? "" : `:\n${detail}`}`);
    this.name = "TypeCheckError";
    this.diagnostics = diagnostics;
  }
}

/** Captured termination details shared by the post-start error classes. */
export interface CapturedTermination {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: OutputTruncation;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A failure reported after ProcExecutor starts its fresh subprocess. */
export class ProcExecutionError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: OutputTruncation;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(message: string, details: CapturedTermination, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProcExecutionError";
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.truncated = details.truncated;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
  }
}

/**
 * The host terminated the guest process group because the caller's signal aborted
 * or the deadline passed. Thrown by both flavors; carries whatever output was
 * captured before termination. Effects the guest already had are not rolled back.
 */
export class ExecutionAbortedError extends Error {
  readonly reason: AbortReason;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: OutputTruncation;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;

  constructor(reason: AbortReason, details: CapturedTermination & { readonly durationMs: number }) {
    super(
      reason === "timeout"
        ? `Execution exceeded its deadline after ${Math.round(details.durationMs)} ms and was terminated`
        : "Execution was aborted by the caller's signal and terminated",
    );
    this.name = "ExecutionAbortedError";
    this.reason = reason;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.truncated = details.truncated;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.durationMs = details.durationMs;
  }
}
