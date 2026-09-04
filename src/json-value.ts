import type { JsonValue } from "./types.js";

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type InputEnvelope =
  | { readonly hasInput: false }
  | { readonly hasInput: true; readonly value: JsonValue };

export type ResultEnvelope =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: SerializedError };

// Capture the operations used for validation and encoding before submitted code
// can replace globals or mutate intrinsic prototypes in its subprocess.
const IntrinsicError = Error;
const IntrinsicTypeError = TypeError;
const IntrinsicSet = Set;
const arrayIsArray = Array.isArray;
const arrayPrototype = Array.prototype;
const arrayIncludes = Array.prototype.includes;
const arrayPush = Array.prototype.push;
const functionHasInstance = Function.prototype[Symbol.hasInstance];
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const numberIsFinite = Number.isFinite;
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectKeys = Object.keys;
const objectPrototype = Object.prototype;
const objectSetPrototypeOf = Object.setPrototypeOf;
const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const regexpTest = RegExp.prototype.test;
const setAdd = Set.prototype.add;
const setDelete = Set.prototype.delete;
const setHas = Set.prototype.has;
const toString = String;

function valueError(label: string, path: string, detail: string): never {
  throw new IntrinsicTypeError(`${label} at ${path} ${detail}`);
}

function propertyPath(path: string, key: string): string {
  return reflectApply(regexpTest, identifier, [key])
    ? `${path}.${key}`
    : `${path}[${jsonStringify(key)}]`;
}

function ownKeys(value: object, label: string, path: string): readonly PropertyKey[] {
  try {
    return reflectOwnKeys(value);
  } catch {
    return valueError(label, path, "must expose ordinary own properties");
  }
}

function ownDataValue(
  value: object,
  key: PropertyKey,
  label: string,
  path: string,
): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = objectGetOwnPropertyDescriptor(value, key);
  } catch {
    return valueError(label, path, "must expose ordinary own properties");
  }
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    return valueError(label, path, "must be an enumerable data property");
  }
  return descriptor.value;
}

function includes(values: readonly string[], expected: string): boolean {
  return reflectApply(arrayIncludes, values, [expected]) as boolean;
}

function normalize(
  value: unknown,
  label: string,
  path: string,
  ancestors: Set<object>,
): JsonValue {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!numberIsFinite(value)) valueError(label, path, "must be a finite number");
    return value;
  }
  if (typeof value !== "object") {
    return valueError(label, path, `has unsupported type ${typeof value}`);
  }
  if (reflectApply(setHas, ancestors, [value]) as boolean) {
    valueError(label, path, "must not contain a cycle");
  }

  reflectApply(setAdd, ancestors, [value]);
  try {
    if (arrayIsArray(value)) {
      let prototype: object | null;
      try {
        prototype = objectGetPrototypeOf(value);
      } catch {
        return valueError(label, path, "must have the plain array prototype");
      }
      if (prototype !== arrayPrototype) {
        valueError(label, path, "must have the plain array prototype");
      }

      const keys = ownKeys(value, label, path);
      const stringKeys: string[] = [];
      for (const key of keys) {
        if (typeof key !== "string") valueError(label, path, "must not have symbol keys");
        reflectApply(arrayPush, stringKeys, [key]);
      }
      if (stringKeys.length !== value.length + 1 || !includes(stringKeys, "length")) {
        valueError(label, path, "must be dense and have no extra properties");
      }

      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = toString(index);
        if (!includes(stringKeys, key)) {
          valueError(label, `${path}[${index}]`, "must be present in a dense array");
        }
        reflectApply(arrayPush, result, [normalize(
          ownDataValue(value, key, label, `${path}[${index}]`),
          label,
          `${path}[${index}]`,
          ancestors,
        )]);
      }
      // Prevent a submitted Array.prototype.toJSON from affecting encoding.
      objectSetPrototypeOf(result, null);
      return result;
    }

    let prototype: object | null;
    try {
      prototype = objectGetPrototypeOf(value);
    } catch {
      return valueError(label, path, "must have a plain object prototype");
    }
    if (prototype !== objectPrototype && prototype !== null) {
      valueError(label, path, "must have a plain object prototype");
    }

    // A null prototype prevents submitted Object.prototype hooks from affecting
    // the captured JSON encoder. Parsed boundary values are returned separately.
    const result = objectCreate(null) as Record<string, JsonValue>;
    for (const key of ownKeys(value, label, path)) {
      if (typeof key !== "string") valueError(label, path, "must not have symbol keys");
      const childPath = propertyPath(path, key);
      objectDefineProperty(result, key, {
        value: normalize(
          ownDataValue(value, key, label, childPath),
          label,
          childPath,
          ancestors,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    reflectApply(setDelete, ancestors, [value]);
  }
}

export function normalizeJsonValue(value: unknown, label = "JSON value"): JsonValue {
  return normalize(value, label, "$", new IntrinsicSet<object>());
}

export function stringifyJsonValue(value: unknown, label = "JSON value"): string {
  const result = jsonStringify(normalizeJsonValue(value, label));
  if (result === undefined) valueError(label, "$", "could not be encoded");
  return result;
}

export function inputEnvelopeJson(hasInput: boolean, value: unknown): string {
  if (!hasInput) return '{"hasInput":false}';
  return `{"hasInput":true,"value":${stringifyJsonValue(value, "Execution input")}}`;
}

function parseJson(text: string, label: string): unknown {
  try {
    return jsonParse(text) as unknown;
  } catch (error) {
    throw new IntrinsicError(`${label} is not valid JSON`, { cause: error });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !arrayIsArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = objectKeys(value);
  if (keys.length !== expected.length) return false;
  for (const key of expected) {
    if (!objectHasOwn(value, key)) return false;
  }
  return true;
}

export function parseInputEnvelope(text: string): InputEnvelope {
  const value = parseJson(text, "Execution input envelope");
  if (!isRecord(value) || typeof value.hasInput !== "boolean") {
    throw new IntrinsicError("Execution input envelope has an invalid shape");
  }
  if (value.hasInput === false) {
    if (!hasExactKeys(value, ["hasInput"])) {
      throw new IntrinsicError("Execution input envelope has an invalid shape");
    }
    return { hasInput: false };
  }
  if (!hasExactKeys(value, ["hasInput", "value"])) {
    throw new IntrinsicError("Execution input envelope has an invalid shape");
  }
  normalizeJsonValue(value.value, "Execution input");
  return { hasInput: true, value: value.value as JsonValue };
}

function isSerializedError(value: unknown): value is SerializedError {
  if (!isRecord(value)) return false;
  const expected = value.stack === undefined ? ["name", "message"] : ["name", "message", "stack"];
  return hasExactKeys(value, expected)
    && typeof value.name === "string"
    && typeof value.message === "string"
    && (value.stack === undefined || typeof value.stack === "string");
}

export function parseResultEnvelope(text: string): ResultEnvelope {
  const value = parseJson(text, "Execution result envelope");
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw new IntrinsicError("Execution result envelope has an invalid shape");
  }
  if (value.ok) {
    if (!hasExactKeys(value, ["ok", "value"])) {
      throw new IntrinsicError("Execution result envelope has an invalid shape");
    }
    normalizeJsonValue(value.value, "Execution result");
    return { ok: true, value: value.value as JsonValue };
  }
  if (!hasExactKeys(value, ["ok", "error"]) || !isSerializedError(value.error)) {
    throw new IntrinsicError("Execution result envelope has an invalid shape");
  }
  return { ok: false, error: value.error };
}

function printable(value: unknown): string {
  try {
    return toString(value);
  } catch {
    return "[unprintable]";
  }
}

function errorProperty(value: Error, property: "name" | "message" | "stack"): string | undefined {
  try {
    const result = value[property];
    return typeof result === "string" ? result : undefined;
  } catch {
    return undefined;
  }
}

export function serializeError(value: unknown): SerializedError {
  let isError = false;
  try {
    isError = reflectApply(functionHasInstance, IntrinsicError, [value]) as boolean;
  } catch {
    // Hostile values are reduced to their safest printable representation below.
  }
  if (isError) {
    const error = value as Error;
    const stack = errorProperty(error, "stack");
    return {
      name: errorProperty(error, "name") ?? "Error",
      message: errorProperty(error, "message") ?? "An Error was thrown",
      ...(stack === undefined ? {} : { stack }),
    };
  }
  return {
    name: "Error",
    message: typeof value === "string" ? value : `Non-Error value thrown: ${printable(value)}`,
  };
}

export function deserializeError(value: SerializedError): Error {
  const error = new IntrinsicError(value.message);
  error.name = value.name;
  if (value.stack !== undefined) error.stack = value.stack;
  return error;
}
