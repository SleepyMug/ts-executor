import { normalizeJsonValue, type SerializedError } from "./json-value.js";

export type ProcStatusEnvelope =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SerializedError };

const jsonParse = JSON.parse;
const objectHasOwn = Object.hasOwn;
const objectKeys = Object.keys;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = objectKeys(value);
  return keys.length === expected.length && expected.every((key) => objectHasOwn(value, key));
}

function isSerializedError(value: unknown): value is SerializedError {
  if (!isRecord(value)) return false;
  const expected = value.stack === undefined ? ["name", "message"] : ["name", "message", "stack"];
  return hasExactKeys(value, expected)
    && typeof value.name === "string"
    && typeof value.message === "string"
    && (value.stack === undefined || typeof value.stack === "string");
}

export function parseProcStatusEnvelope(text: string): ProcStatusEnvelope {
  let value: unknown;
  try {
    value = jsonParse(text) as unknown;
  } catch (error) {
    throw new Error("Proc execution status envelope is not valid JSON", { cause: error });
  }
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new Error("Proc execution status envelope has an invalid shape");
  }
  if (value.ok) {
    if (!hasExactKeys(value, ["ok"])) {
      throw new Error("Proc execution status envelope has an invalid shape");
    }
    return { ok: true };
  }
  if (!hasExactKeys(value, ["ok", "error"]) || !isSerializedError(value.error)) {
    throw new Error("Proc execution status envelope has an invalid shape");
  }
  // Validate strings and the plain envelope without sharing permissive JSON behavior.
  normalizeJsonValue(value, "Proc execution status envelope");
  return { ok: false, error: value.error };
}
