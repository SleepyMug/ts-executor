import type { AbortReason, ExecutionControl } from "./types.js";

/** Default per-stream retention cap: 4 MiB of stdout and 4 MiB of stderr. */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Default pause between SIGTERM and SIGKILL when terminating a guest process group. */
export const DEFAULT_KILL_GRACE_MS = 2000;

/** Resolved, validated control values for one execution. */
export interface ResolvedControl {
  readonly signal: AbortSignal | undefined;
  readonly startedAt: number;
  /** `performance.now()` timestamp after which the execution is terminated; undefined = none. */
  readonly deadlineAt: number | undefined;
  readonly maxOutputBytes: number;
  readonly killGraceMs: number;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

/** Validate caller-supplied limits synchronously, before any asynchronous work. */
export function resolveControl(control: ExecutionControl, startedAt: number): ResolvedControl {
  const signal = control.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("execute.signal must be an AbortSignal");
  }
  const timeoutMs = control.timeoutMs === undefined
    ? undefined
    : positiveInteger(control.timeoutMs, "execute.timeoutMs");
  return Object.freeze({
    signal,
    startedAt,
    deadlineAt: timeoutMs === undefined ? undefined : startedAt + timeoutMs,
    maxOutputBytes: control.maxOutputBytes === undefined
      ? DEFAULT_MAX_OUTPUT_BYTES
      : positiveInteger(control.maxOutputBytes, "execute.maxOutputBytes"),
    killGraceMs: control.killGraceMs === undefined
      ? DEFAULT_KILL_GRACE_MS
      : positiveInteger(control.killGraceMs, "execute.killGraceMs"),
  });
}

/** The reason an execution must not start (or continue) right now, if any. */
export function pendingAbort(control: ResolvedControl, now: number): AbortReason | undefined {
  if (control.signal?.aborted === true) return "signal";
  if (control.deadlineAt !== undefined && now >= control.deadlineAt) return "timeout";
  return undefined;
}
