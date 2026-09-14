import type { ChildProcess } from "node:child_process";
import { serializeError } from "../json-value.js";
import type { JsonValue } from "../types.js";
import {
  encodeHostMessage,
  HOST_REQUEST_TYPE,
  HOST_RESPONSE_TYPE,
  parseHostMessage,
} from "./host-protocol.js";
import type { HostRequest } from "./host-protocol.js";

/**
 * Attach synchronously, immediately after spawn. Protocol/transport failures
 * close the channel rather than replying to an unsafe or ambiguous request id.
 * There are no retries, and close never waits for running host code.
 */
export function attachHostBridge(
  child: ChildProcess,
  invoke: (moduleId: string, method: string, input: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
): () => void {
  const controller = new AbortController();
  const signal = controller.signal;
  const send = child.send;
  const disconnect = child.disconnect;
  const on = child.on;
  const removeListener = child.removeListener;
  const apply = Reflect.apply;
  const abort = controller.abort;
  const seen = new Set<number>();
  let active = true;
  let connected = child.connected;

  function close(): void {
    if (!active) return;
    active = false;
    try {
      apply(abort, controller, []);
    } catch {
      // A caller-supplied abort hook must not escape a transport listener.
    }
    seen.clear();
    if (connected && typeof disconnect === "function") {
      connected = false;
      try {
        apply(disconnect, child, []);
      } catch {
        // The child may already have closed its side of the channel.
      }
    }
    remove("message", onMessage);
    remove("disconnect", onDisconnect);
    remove("exit", onExit);
    remove("error", onError);
  }

  function remove(event: string, listener: (...args: never[]) => void): void {
    try {
      apply(removeListener, child, [event, listener]);
    } catch {
      // A throwing EventEmitter removeListener hook must not prevent the
      // remaining cleanup or escape a message/send-callback error handler.
    }
  }

  function onDisconnect(): void {
    connected = false;
    close();
  }

  function onExit(): void {
    close();
  }

  function onError(): void {
    close();
  }

  function reply(text: string): void {
    if (!active) return;
    try {
      apply(send, child, [text, (error: Error | null) => {
        if (error !== null && error !== undefined) close();
      }]);
      // false only means queued/backpressure. The callback reports failure.
    } catch {
      close();
    }
  }

  async function dispatch(request: HostRequest): Promise<void> {
    try {
      const value = await invoke(request.moduleId, request.method, request.input, signal);
      if (!active) return;
      // Validate BEFORE Node IPC serialization, including host return values
      // whose static JsonValue annotation cannot guarantee runtime validity.
      reply(encodeHostMessage({ type: HOST_RESPONSE_TYPE, id: request.id, ok: true, value }));
    } catch (error) {
      if (!active) return;
      try {
        reply(encodeHostMessage({
          type: HOST_RESPONSE_TYPE,
          id: request.id,
          ok: false,
          error: serializeError(error),
        }));
      } catch {
        close();
      }
    }
  }

  function onMessage(message: unknown): void {
    if (!active) return;
    try {
      const request = parseHostMessage(message);
      if (request === null) return;
      if (request.type !== HOST_REQUEST_TYPE || seen.has(request.id)) {
        close();
        return;
      }
      // Retain completed ids as well: a replay must never repeat a side effect.
      seen.add(request.id);
      // Every handler is independently in flight. Consume eventual failures
      // even after disconnect/exit/close, including uncooperative host work.
      void dispatch(request).then(undefined, close);
    } catch {
      // EventEmitter listeners must never throw on malformed guest messages.
      close();
    }
  }

  apply(on, child, ["message", onMessage]);
  apply(on, child, ["disconnect", onDisconnect]);
  apply(on, child, ["exit", onExit]);
  apply(on, child, ["error", onError]);
  if (!connected || typeof send !== "function") close();
  return close;
}
