import type { Diagnostic } from "./types.js";

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

/** A failure reported after ProcExecutor starts its fresh subprocess. */
export class ProcExecutionError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProcExecutionError";
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}
