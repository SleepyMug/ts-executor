import { stringifyJsonValue } from "../json-value.js";
import type { SerializedError } from "../json-value.js";
import type { JsonValue } from "../types.js";

export const HOST_REQUEST_TYPE = "ts-executor:host-request:v1";
export const HOST_RESPONSE_TYPE = "ts-executor:host-response:v1";

export interface HostRequest {
  readonly type: typeof HOST_REQUEST_TYPE;
  readonly id: number;
  readonly moduleId: string;
  readonly method: string;
  readonly input: JsonValue;
}

export type HostResponse =
  | {
    readonly type: typeof HOST_RESPONSE_TYPE;
    readonly id: number;
    readonly ok: true;
    readonly value: JsonValue;
  }
  | {
    readonly type: typeof HOST_RESPONSE_TYPE;
    readonly id: number;
    readonly ok: false;
    readonly error: SerializedError;
  };

export type HostMessage = HostRequest | HostResponse;

// This module is loaded by executor-owned bootstrap code before guest import.
const SafeError = Error;
const arrayIsArray = Array.isArray;
const jsonParse = JSON.parse;
const numberIsSafeInteger = Number.isSafeInteger;
const objectHasOwn = Object.hasOwn;
const objectKeys = Object.keys;
const reflectApply = Reflect.apply;
const stringStartsWith = String.prototype.startsWith;

function invalid(detail: string): never {
  throw new SafeError(`Invalid host-call protocol: ${detail}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !arrayIsArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  if (objectKeys(value).length !== keys.length) return false;
  for (let index = 0; index < keys.length; index += 1) {
    if (!objectHasOwn(value, keys[index]!)) return false;
  }
  return true;
}

function isProtocol(value: unknown): value is Readonly<Record<string, unknown>> {
  return isRecord(value)
    && objectHasOwn(value, "type")
    && typeof value.type === "string"
    && (reflectApply(stringStartsWith, value.type, ["ts-executor:host-"]) as boolean);
}

export function isHostRequestId(value: unknown): value is number {
  return typeof value === "number" && numberIsSafeInteger(value) && value > 0;
}

function isSerializedError(value: unknown): value is SerializedError {
  if (!isRecord(value)) return false;
  const hasStack = objectHasOwn(value, "stack");
  return exactKeys(value, hasStack ? ["name", "message", "stack"] : ["name", "message"])
    && typeof value.name === "string"
    && typeof value.message === "string"
    && (!hasStack || typeof value.stack === "string");
}

/**
 * IPC carries JSON TEXT, never a native object envelope. Unrelated native
 * messages and valid JSON without our discriminator are ignored. Invalid JSON
 * text, non-text envelopes claiming our namespace, unknown protocol versions,
 * and malformed protocol envelopes are fatal to the channel; callers disconnect
 * rather than attempting an ambiguous response or replay.
 */
export function parseHostMessage(message: unknown): HostMessage | null {
  if (typeof message !== "string") {
    if (isProtocol(message)) invalid("envelopes must be JSON text");
    return null;
  }

  let value: unknown;
  try {
    value = jsonParse(message) as unknown;
  } catch {
    return invalid("message is not valid JSON text");
  }
  if (!isProtocol(value)) return null;
  if (!isHostRequestId(value.id)) invalid("request id must be a positive safe integer");

  if (value.type === HOST_REQUEST_TYPE) {
    if (
      !exactKeys(value, ["type", "id", "moduleId", "method", "input"])
      || typeof value.moduleId !== "string"
      || typeof value.method !== "string"
    ) invalid("request envelope has an invalid shape");
  } else if (value.type === HOST_RESPONSE_TYPE) {
    if (value.ok === true) {
      if (!exactKeys(value, ["type", "id", "ok", "value"])) {
        invalid("success envelope has an invalid shape");
      }
    } else if (value.ok === false) {
      if (!exactKeys(value, ["type", "id", "ok", "error"]) || !isSerializedError(value.error)) {
        invalid("error envelope has an invalid shape");
      }
    } else {
      invalid("response envelope has an invalid shape");
    }
  } else {
    invalid("unknown message type or version");
  }

  // JSON.parse accepts overflowing numbers such as 1e999. Apply the same strict
  // value rules in both directions, then return ordinary parsed JSON objects.
  stringifyJsonValue(value, "Host-call envelope");
  return value as unknown as HostMessage;
}

/** Strictly validates before Node's IPC serializer can coerce a value. */
export function encodeHostMessage(message: HostMessage): string {
  return stringifyJsonValue(message, "Host-call envelope");
}
