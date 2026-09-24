import type { ExecutionControl } from "./types.js";

/** Pause between SIGTERM and SIGKILL when an aborted guest's process group is terminated. */
export const KILL_GRACE_MS = 2000;

/**
 * Environment variables the executor sets for every guest. A caller's `env` may not
 * name one: the bootstrap reads both to restore the caller's original `tsx` config,
 * so overriding either would corrupt the guest's own module resolution.
 */
export const RESERVED_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  "TSX_TSCONFIG_PATH",
  "__TS_EXECUTOR_RESTORE_ENVIRONMENT",
]);

export type OutputSink = (text: string) => void;

/** Validated control values for one execution. */
export interface ResolvedControl {
  readonly signal: AbortSignal | undefined;
  readonly startedAt: number;
  /** Validated extra variables for this guest, or undefined when the caller passed none. */
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly onStdout: OutputSink | undefined;
  readonly onStderr: OutputSink | undefined;
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

function sinkOption(value: unknown, label: string): OutputSink | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") throw new TypeError(`${label} must be a function`);
  return value as OutputSink;
}

/**
 * Options of 0.3 whose job is now the caller's. A caller still passing one would otherwise lose a
 * deadline or an output cap without noticing.
 */
const REMOVED_OPTIONS: Readonly<Record<string, string>> = {
  timeoutMs: "abort `signal` instead, e.g. AbortSignal.any([signal, AbortSignal.timeout(ms)])",
  maxOutputBytes: "bound what onStdout/onStderr keep instead",
  killGraceMs: "the grace period is fixed",
  killGroupOnExit: "the process group is always killed when the guest exits",
};

/** Validate the caller's control values synchronously, before any asynchronous work. */
export function resolveControl(control: ExecutionControl, startedAt: number): ResolvedControl {
  for (const [name, instead] of Object.entries(REMOVED_OPTIONS)) {
    if (Object.hasOwn(control, name)) throw new TypeError(`execute.${name} was removed in 0.4: ${instead}`);
  }
  const signal = control.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("execute.signal must be an AbortSignal");
  }
  return Object.freeze({
    signal,
    startedAt,
    env: environmentOption(control.env),
    onStdout: sinkOption(control.onStdout, "execute.onStdout"),
    onStderr: sinkOption(control.onStderr, "execute.onStderr"),
  });
}
