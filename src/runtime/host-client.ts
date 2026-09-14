import { deserializeError } from "../json-value.js";
import type { JsonValue } from "../types.js";
import {
  encodeHostMessage,
  HOST_REQUEST_TYPE,
  HOST_RESPONSE_TYPE,
  isHostRequestId,
  parseHostMessage,
} from "./host-protocol.js";

// Captured before submitted code runs. In particular, neither sending nor
// promise bookkeeping looks up guest-replaceable prototype methods later.
const SafeError = Error;
const SafePromise = Promise;
const SafeMap = Map;
const reflectApply = Reflect.apply;
const promiseThen = Promise.prototype.then;
const mapSet = Map.prototype.set;
const mapGet = Map.prototype.get;
const mapDelete = Map.prototype.delete;
const mapForEach = Map.prototype.forEach;
const mapClear = Map.prototype.clear;
const childProcess = process;
const ignoreRejection = (): void => {};

interface PendingCall {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: unknown) => void;
}

interface HostClient {
  readonly call: (moduleId: string, method: string, input: unknown) => Promise<JsonValue>;
  readonly close: () => void;
}

let initialized = false;
let terminal = false;
let client: HostClient | undefined;

function handled(promise: Promise<JsonValue>): Promise<JsonValue> {
  // Mark the ORIGINAL promise handled, not a replacement that would reject
  // unobserved. Awaiting this same promise still observes its original error.
  reflectApply(promiseThen, promise, [undefined, ignoreRejection]);
  return promise;
}

function rejected(error: unknown): Promise<JsonValue> {
  return handled(new SafePromise<JsonValue>((_resolve, reject) => reject(error)));
}

/** Called by bootstrap before guest import; never creates an IPC channel. */
export function initializeHostClient(): void {
  if (initialized || terminal) return;
  initialized = true;
  const send = childProcess.send;
  if (typeof send !== "function") return;

  const on = childProcess.on;
  const removeListener = childProcess.removeListener;
  const disconnect = childProcess.disconnect;
  const pending = new SafeMap<number, PendingCall>();
  let nextId = 1;
  let active = true;
  let connected = childProcess.connected === true;
  let closeReason: unknown = new SafeError("Host-call client is closed");

  function stop(reason: unknown): void {
    if (!active) return;
    active = false;
    closeReason = reason;
    reflectApply(mapForEach, pending, [(call: PendingCall) => call.reject(reason)]);
    reflectApply(mapClear, pending, []);

    // Disconnect even at ordinary terminal completion, so host work is aborted
    // promptly without waiting for handlers or terminal-file publication.
    if (connected && typeof disconnect === "function") {
      connected = false;
      try {
        reflectApply(disconnect, childProcess, []);
      } catch {
        // Pending calls are already rejected; disconnect is best effort.
      }
    }
    remove("message", onMessage);
    remove("disconnect", onDisconnect);
    remove("error", onError);
  }

  function remove(event: string, listener: (...args: never[]) => void): void {
    try {
      reflectApply(removeListener, childProcess, [event, listener]);
    } catch {
      // EventEmitter removes the listener before emitting guest-installed
      // removeListener hooks. A throwing hook must not interrupt completion.
    }
  }

  function onDisconnect(): void {
    connected = false;
    stop(new SafeError("Host-call channel disconnected"));
  }

  function onError(error: unknown): void {
    stop(error);
  }

  function onMessage(message: unknown): void {
    if (!active) return;
    try {
      const response = parseHostMessage(message);
      if (response === null) return;
      if (response.type !== HOST_RESPONSE_TYPE) {
        throw new SafeError("Invalid host-call protocol: expected a response");
      }
      const call = reflectApply(mapGet, pending, [response.id]) as PendingCall | undefined;
      if (call === undefined) {
        throw new SafeError("Invalid host-call protocol: unknown or duplicate response id");
      }
      // Decode before removing the call so even a decoding failure rejects it.
      const error = response.ok ? undefined : deserializeError(response.error);
      reflectApply(mapDelete, pending, [response.id]);
      if (response.ok) call.resolve(response.value);
      else call.reject(error);
    } catch (error) {
      stop(error);
    }
  }

  function call(moduleId: string, method: string, input: unknown): Promise<JsonValue> {
    return handled(new SafePromise<JsonValue>((resolve, reject) => {
      if (!active) {
        reject(closeReason);
        return;
      }
      const id = nextId;
      if (!isHostRequestId(id)) {
        reject(new SafeError("Host-call request ids are exhausted"));
        return;
      }
      nextId += 1;

      let text: string;
      try {
        if (typeof moduleId !== "string" || typeof method !== "string") {
          throw new SafeError("Host-call module id and method must be strings");
        }
        text = encodeHostMessage({
          type: HOST_REQUEST_TYPE,
          id,
          moduleId,
          method,
          input: input as JsonValue,
        });
      } catch (error) {
        reject(error);
        return;
      }
      // A hostile input Proxy can run arbitrary guest code during validation.
      if (!active) {
        reject(closeReason);
        return;
      }
      reflectApply(mapSet, pending, [id, { resolve, reject }]);
      try {
        reflectApply(send!, childProcess, [text, (error: Error | null) => {
          if (error !== null && error !== undefined) stop(error);
        }]);
        // send() === false is backpressure: the request remains queued.
      } catch (error) {
        stop(error);
      }
    }));
  }

  client = { call, close: () => stop(new SafeError("Host-call client is closed")) };
  reflectApply(on, childProcess, ["message", onMessage]);
  reflectApply(on, childProcess, ["disconnect", onDisconnect]);
  reflectApply(on, childProcess, ["error", onError]);
  if (!connected) onDisconnect();
}

/** Always returns a promise, including validation, unavailable, and closed errors. */
export function callHost(moduleId: string, method: string, input: unknown): Promise<JsonValue> {
  if (terminal) return rejected(new SafeError("Host-call client is closed"));
  if (client === undefined) return rejected(new SafeError("Host-call IPC is unavailable"));
  return client.call(moduleId, method, input);
}

/** Stop immediately; never await outstanding host handlers. Idempotent. */
export function closeHostClient(): void {
  terminal = true;
  client?.close();
}
