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

/**
 * The caller's signal aborted, so the guest process group was terminated (or never
 * started). Effects the guest already had are not rolled back.
 */
export class ExecutionAbortedError extends Error {
  readonly durationMs: number;

  constructor(durationMs: number) {
    super("Execution was aborted by the caller's signal and terminated");
    this.name = "ExecutionAbortedError";
    this.durationMs = durationMs;
  }
}

/** Keeps the primary failure and records a secondary cleanup failure on it, when it can. */
export function attachCleanupError(primary: unknown, cleanup: unknown): void {
  if ((typeof primary !== "object" && typeof primary !== "function") || primary === null) return;
  try {
    Object.defineProperty(primary, "cleanupError", {
      value: cleanup,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Preserve the primary failure even when it cannot accept metadata.
  }
}
