import type { AbortReason, ExecutionControl } from "./types.js";

/** Default per-stream retention cap: 4 MiB of stdout and 4 MiB of stderr. */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Default pause between SIGTERM and SIGKILL when terminating a guest process group. */
export const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * Environment variables the executor sets for every guest. A caller's `env` may not
 * name one: the bootstrap reads both to restore the caller's original `tsx` config,
 * so overriding either would corrupt the guest's own module resolution.
 */
export const RESERVED_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  "TSX_TSCONFIG_PATH",
  "__TS_EXECUTOR_RESTORE_ENVIRONMENT",
]);

/** Resolved, validated control values for one execution. */
export interface ResolvedControl {
  readonly signal: AbortSignal | undefined;
  readonly startedAt: number;
  /** `performance.now()` timestamp after which the execution is terminated; undefined = none. */
  readonly deadlineAt: number | undefined;
  readonly maxOutputBytes: number;
  readonly killGraceMs: number;
  readonly killGroupOnExit: boolean;
  /** Validated extra variables for this guest, or undefined when the caller passed none. */
  readonly env: Readonly<Record<string, string>> | undefined;
}

function booleanOption(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function environmentOption(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("execute.env must be an object of string values");
  }
  const entries: [string, string][] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (name === "" || name.includes("=") || name.includes("\0")) {
      throw new TypeError(`execute.env name ${JSON.stringify(name)} is not a valid variable name`);
    }
    if (RESERVED_ENVIRONMENT_NAMES.includes(name)) {
      throw new TypeError(`execute.env may not override the executor's own ${name}`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new TypeError(`execute.env.${name} must be a string without NUL`);
    }
    entries.push([name, entry]);
  }
  return entries.length === 0 ? undefined : Object.freeze(Object.fromEntries(entries));
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
    killGroupOnExit: booleanOption(control.killGroupOnExit, "execute.killGroupOnExit"),
    env: environmentOption(control.env),
  });
}

/** The reason an execution must not start (or continue) right now, if any. */
export function pendingAbort(control: ResolvedControl, now: number): AbortReason | undefined {
  if (control.signal?.aborted === true) return "signal";
  if (control.deadlineAt !== undefined && now >= control.deadlineAt) return "timeout";
  return undefined;
}
