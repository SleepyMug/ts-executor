import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { attachHostBridge } from "../dist/runtime/host-bridge.js";
import {
  HOST_REQUEST_TYPE, HOST_RESPONSE_TYPE, encodeHostMessage, isHostRequestId, parseHostMessage,
} from "../dist/runtime/host-protocol.js";

const timeout = 20_000;
const execFileAsync = promisify(execFile);
const clientUrl = new URL("../dist/runtime/host-client.js", import.meta.url).href;
const protocolUrl = new URL("../dist/runtime/host-protocol.js", import.meta.url).href;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function request(id = 1, overrides = {}) {
  return { type: HOST_REQUEST_TYPE, id, moduleId: "module", method: "effect", input: null, ...overrides };
}

function response(id = 1, overrides = {}) {
  return { type: HOST_RESPONSE_TYPE, id, ok: true, value: null, ...overrides };
}

class FakeChild extends EventEmitter {
  connected = true;
  sent = [];
  callbacks = [];
  disconnectCalls = 0;
  backpressure = false;
  sendError;
  synchronousSendError;

  send(text, callback) {
    this.sent.push(text);
    if (this.synchronousSendError) throw this.synchronousSendError;
    this.callbacks.push(callback);
    if (this.sendError) callback(this.sendError);
    return !this.backpressure;
  }

  disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
    this.emit("disconnect");
  }

  incoming(message) {
    this.emit("message", typeof message === "string" ? message : encodeHostMessage(message));
  }
}

function assertDetached(child) {
  for (const event of ["message", "disconnect", "exit", "error"]) assert.equal(child.listenerCount(event), 0, event);
}

test("host protocol round-trips exact JSON-text envelopes, Unicode and prototype-named data", () => {
  const value = JSON.parse('{"__proto__":"data","constructor":1,"toString":"own","text":"☃ α","array":[null,false,3.5]}');
  const messages = [
    request(1, { input: value }),
    response(Number.MAX_SAFE_INTEGER, { value }),
    { type: HOST_RESPONSE_TYPE, id: 2, ok: false, error: { name: "RangeError", message: "bad" } },
    { type: HOST_RESPONSE_TYPE, id: 3, ok: false, error: { name: "Error", message: "bad", stack: "remote stack" } },
  ];
  for (const message of messages) {
    const text = encodeHostMessage(message);
    assert.equal(typeof text, "string");
    assert.deepEqual(parseHostMessage(text), message);
  }
  assert.equal(Object.getPrototypeOf(parseHostMessage(encodeHostMessage(request(1, { input: value }))).input), Object.prototype);
  for (const id of [1, 42, Number.MAX_SAFE_INTEGER]) assert.equal(isHostRequestId(id), true);
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined]) assert.equal(isHostRequestId(id), false);
});

test("unrelated IPC messages are ignored but malformed or non-text protocol claims are fatal", () => {
  for (const message of [null, undefined, false, 1, [], {}, { type: "other" }, Buffer.from("bytes"),
    "null", "false", "42", "[]", "{}", '"text"', '{"type":"other"}', '{"type":5}']) {
    assert.equal(parseHostMessage(message), null);
  }
  for (const message of ["", "not-json", "{", "undefined", request(), response(), { type: "ts-executor:host-unknown" }]) {
    assert.throws(() => parseHostMessage(message), /Invalid host-call protocol/u);
  }
});

test("protocol parsing rejects unknown versions, invalid ids, missing/extra fields and malformed errors", () => {
  const malformed = [
    request(0), request(-1), request(1.5), request("1"), request(Number.MAX_SAFE_INTEGER + 1),
    request(1, { type: "ts-executor:host-request:v2" }),
    request(1, { type: "ts-executor:host-unrecognized:v1" }),
    request(1, { moduleId: 1 }), request(1, { method: null }), request(1, { extra: true }),
    response(1, { ok: "true" }), response(1, { extra: true }), response(1, { error: { name: "Error", message: "bad" } }),
    { type: HOST_RESPONSE_TYPE, id: 1, ok: false, error: {} },
    ...[null, [], "failure", { name: "Error" }, { name: 5, message: "bad" }, { name: "Error", message: null },
      { name: "Error", message: "bad", stack: 1 }, { name: "Error", message: "bad", extra: true }]
      .map(error => ({ type: HOST_RESPONSE_TYPE, id: 1, ok: false, error })),
  ];
  for (const key of ["id", "moduleId", "method", "input"]) {
    const value = request(); delete value[key]; malformed.push(value);
  }
  for (const key of ["id", "ok", "value"]) {
    const value = response(); delete value[key]; malformed.push(value);
  }
  for (const message of malformed) {
    assert.throws(() => parseHostMessage(JSON.stringify(message)), /Invalid host-call protocol/u, JSON.stringify(message));
  }
  for (const message of [request(1, { input: "OVERFLOW" }), response(1, { value: "OVERFLOW" })]) {
    const text = JSON.stringify(message).replace('"OVERFLOW"', "1e999");
    assert.throws(() => parseHostMessage(text), /finite number/u);
  }
});

test("encoding rejects non-JSON before IPC serialization can coerce values or invoke hooks", () => {
  let hooks = 0;
  const cyclic = {}; cyclic.self = cyclic;
  const invalid = [
    undefined, NaN, Infinity, 1n, Symbol("value"), () => null, cyclic, new Date(), new Map(),
    new Uint8Array([1]), Array(1), { nested: undefined }, Object.assign([], { extra: true }),
    Object.defineProperty({}, "secret", { value: 1 }),
    Object.defineProperty({}, "getter", { enumerable: true, get() { hooks += 1; return null; } }),
    { toJSON() { hooks += 1; return null; } },
  ];
  for (const value of invalid) {
    assert.throws(() => encodeHostMessage(request(1, { input: value })), /Host-call envelope/u);
    assert.throws(() => encodeHostMessage(response(1, { value })), /Host-call envelope/u);
  }
  assert.equal(hooks, 0);
});

test("bridge dispatches concurrently, correlates replies and treats send(false) as backpressure without retries", { timeout }, async t => {
  const child = new FakeChild();
  child.backpressure = true;
  const gates = Array.from({ length: 3 }, deferred);
  const calls = [];
  const close = attachHostBridge(child, async (moduleId, method, input, signal) => {
    calls.push({ moduleId, method, input, signal });
    return gates[input].promise;
  });
  t.after(close);
  for (let index = 0; index < 3; index += 1) child.incoming(request(index + 1, { input: index }));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.signal === calls[0].signal && !call.signal.aborted));
  for (const index of [2, 0, 1]) {
    gates[index].resolve(`value:${index}`);
    await nextTurn();
    const reply = parseHostMessage(child.sent.at(-1));
    assert.deepEqual(reply, response(index + 1, { value: `value:${index}` }));
  }
  assert.deepEqual(child.sent.map(text => parseHostMessage(text).id), [3, 1, 2]);
  assert.equal(child.disconnectCalls, 0);
  for (const callback of child.callbacks) callback(null);
  await nextTurn();
  assert.equal(child.sent.length, 3, "a queued send is never replayed");
  close(); close();
  assert.equal(child.disconnectCalls, 1);
  assert.ok(calls[0].signal.aborted);
  assertDetached(child);
});

test("bridge reports host exceptions and invalid results, then accepts another independent call", { timeout }, async t => {
  const child = new FakeChild();
  const badError = new Error("hidden");
  for (const property of ["name", "message", "stack"]) Object.defineProperty(badError, property, { get() { throw new Error("hostile error getter"); } });
  const close = attachHostBridge(child, async (_module, method) => {
    if (method === "error") throw new RangeError("host range");
    if (method === "arbitrary") throw Object.create(null);
    if (method === "hostile") throw badError;
    if (method === "invalid") return { bad: undefined };
    return "valid";
  });
  t.after(close);
  for (const [index, method] of ["error", "arbitrary", "hostile", "invalid", "okay"].entries()) {
    child.incoming(request(index + 1, { method }));
  }
  await nextTurn();
  const replies = child.sent.map(parseHostMessage);
  assert.equal(replies.length, 5);
  assert.equal(replies[0].error.name, "RangeError");
  assert.equal(replies[0].error.message, "host range");
  assert.match(replies[0].error.stack, /host range/u);
  assert.equal(replies[1].error.message, "Non-Error value thrown: [unprintable]");
  assert.deepEqual(replies[2].error, { name: "Error", message: "An Error was thrown" });
  assert.equal(replies[3].error.name, "TypeError");
  assert.match(replies[3].error.message, /Host-call envelope.*undefined/u);
  assert.deepEqual(replies[4], response(5, { value: "valid" }));
  assert.equal(child.connected, true);
});

for (const completed of [false, true]) {
  test(`bridge never replays ${completed ? "completed" : "in-flight"} request ids`, { timeout }, async () => {
    const child = new FakeChild();
    const gate = deferred();
    let calls = 0;
    let signal;
    const close = attachHostBridge(child, async (_module, _method, _input, contextSignal) => {
      calls += 1;
      signal = contextSignal;
      return gate.promise;
    });
    try {
      child.incoming(request());
      if (completed) { gate.resolve("done"); await nextTurn(); }
      child.incoming(request(1, { method: "another-effect", input: "different payload" }));
      child.incoming(request(2));
      assert.equal(calls, 1);
      assert.equal(child.disconnectCalls, 1);
      assert.equal(signal.aborted, true);
      assertDetached(child);
      gate.reject(new Error("late callback rejection after duplicate"));
      await nextTurn();
      assert.equal(child.sent.length, completed ? 1 : 0);
    } finally {
      close(); gate.resolve(null);
    }
  });
}

test("bridge ignores unrelated messages and closes malformed channels before any further side effect", { timeout }, async () => {
  for (const malformed of ["not-json", request(), JSON.stringify(request(0)), JSON.stringify(response()),
    JSON.stringify(request(1, { extra: true })), JSON.stringify(request(1, { type: "ts-executor:host-request:v2" }))]) {
    const child = new FakeChild();
    let calls = 0;
    const close = attachHostBridge(child, async () => { calls += 1; return null; });
    try {
      for (const unrelated of [{ type: "other" }, null, "null", '{"type":"another-protocol"}']) child.emit("message", unrelated);
      assert.equal(child.connected, true);
      assert.equal(calls, 0);
      assert.doesNotThrow(() => child.emit("message", malformed));
      child.incoming(request(2));
      assert.equal(calls, 0);
      assert.equal(child.disconnectCalls, 1);
      assertDetached(child);
    } finally { close(); }
  }
});

for (const failure of ["send throw", "send callback", "disconnect", "exit", "error", "explicit close"]) {
  test(`bridge ${failure} aborts pending work, consumes late rejection and sends no retries`, { timeout }, async () => {
    const child = new FakeChild();
    const gate = deferred();
    let signal;
    let calls = 0;
    const close = attachHostBridge(child, async (_module, method, _input, contextSignal) => {
      calls += 1;
      signal = contextSignal;
      return method === "blocked" ? gate.promise : "reply";
    });
    try {
      child.incoming(request(1, { method: "blocked" }));
      if (failure === "send throw" || failure === "send callback") {
        if (failure === "send throw") child.synchronousSendError = new Error("synchronous send failure");
        else child.sendError = new Error("asynchronous send failure");
        child.incoming(request(2));
        await nextTurn();
      } else if (failure === "explicit close") close();
      else if (failure === "disconnect") {
        child.connected = false;
        child.emit("disconnect");
      } else child.emit(failure, failure === "error" ? new Error("child transport error") : 1, null);
      assert.equal(signal.aborted, true);
      assertDetached(child);
      const sent = child.sent.length;
      const invoked = calls;
      child.incoming(request(3));
      gate.reject(new Error("late host handler failure"));
      await nextTurn();
      await nextTurn();
      close();
      assert.equal(child.sent.length, sent);
      assert.equal(calls, invoked);
      assert.ok(child.disconnectCalls <= 1);
    } finally { close(); gate.resolve(null); }
  });
}

test("delayed send callback errors close the bridge even after a backpressured reply was queued", { timeout }, async () => {
  const child = new FakeChild();
  child.backpressure = true;
  const gate = deferred();
  let signal;
  const close = attachHostBridge(child, async (_module, method, _input, contextSignal) => {
    signal = contextSignal;
    return method === "blocked" ? gate.promise : null;
  });
  try {
    child.incoming(request(1));
    await nextTurn();
    child.incoming(request(2, { method: "blocked" }));
    assert.equal(child.connected, true);
    assert.equal(child.sent.length, 1);
    child.callbacks[0](new Error("queued IPC send failed"));
    assert.equal(signal.aborted, true);
    gate.resolve("too late");
    await nextTurn();
    assert.equal(child.sent.length, 1);
    assertDetached(child);
  } finally { close(); gate.resolve(null); }
});

test("bridge cleanup tolerates throwing listener hooks and uses captured transport methods", { timeout }, async () => {
  const child = new FakeChild();
  let signal;
  const close = attachHostBridge(child, async (_module, _method, _input, contextSignal) => {
    signal = contextSignal;
    return null;
  });
  child.send = child.disconnect = child.on = child.removeListener = () => { throw new Error("replacement must not run"); };
  EventEmitter.prototype.on.call(child, "removeListener", () => { throw new Error("listener hook failed"); });
  child.incoming(request());
  await nextTurn();
  assert.equal(child.sent.length, 1);
  assert.doesNotThrow(close);
  assert.equal(signal.aborted, true);
  assert.equal(child.disconnectCalls, 1);
  assertDetached(child);
});

test("bridge safely detaches from children lacking an initially usable IPC channel", () => {
  for (const kind of ["disconnected", "missing send"]) {
    const child = new FakeChild();
    if (kind === "disconnected") child.connected = false;
    else child.send = undefined;
    let calls = 0;
    const close = attachHostBridge(child, async () => { calls += 1; return null; });
    child.incoming(request());
    close();
    assert.equal(calls, 0);
    assertDetached(child);
    assert.ok(child.disconnectCalls <= 1);
  }
});

// Probe the process-global guest client in a fresh, bounded Node process. This
// avoids replacing the test runner's process.send/event listeners or retaining
// singleton state between cases. An unhandled rejection makes the probe fail.
async function clientProbe(body, { initialize = true, connected = true, available = true } = {}) {
  const script = `
    import assert from "node:assert/strict";
    import { setImmediate as nextTurn } from "node:timers/promises";
    import { initializeHostClient, callHost, closeHostClient } from ${JSON.stringify(clientUrl)};
    import { HOST_REQUEST_TYPE, HOST_RESPONSE_TYPE, encodeHostMessage, parseHostMessage } from ${JSON.stringify(protocolUrl)};
    const sent = [];
    const callbacks = [];
    let disconnects = 0;
    let sendError;
    let callbackError;
    process.connected = ${connected};
    ${available ? `process.send = function(text, callback) {
      sent.push(text);
      if (sendError) throw sendError;
      callbacks.push(callback);
      if (callbackError) callback(callbackError);
      return false;
    };` : "delete process.send;"}
    process.disconnect = () => { disconnects += 1; process.connected = false; process.emit("disconnect"); };
    function reply(id, value) { process.emit("message", encodeHostMessage({ type: HOST_RESPONSE_TYPE, id, ok: true, value })); }
    ${initialize ? "initializeHostClient(); initializeHostClient();" : ""}
    ${body}
    closeHostClient(); closeHostClient();
    await nextTurn(); await nextTurn();
    assert.ok(disconnects <= 1);
    process.stdout.write("probe passed\\n");
  `;
  const result = await execFileAsync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
    timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stdout, "probe passed\n");
  assert.equal(result.stderr, "");
}

test("guest client correlates out-of-order responses and keeps send(false) requests pending exactly once", { timeout }, async () => {
  await clientProbe(`
    const input = { count: 1 };
    const first = callHost("module", "first", input);
    input.count = 99;
    const second = callHost("module", "second", null);
    const third = callHost("module", "third", false);
    assert.equal(sent.length, 3);
    const requests = sent.map(parseHostMessage);
    assert.deepEqual(requests.map(request => request.id), [1, 2, 3]);
    assert.deepEqual(requests[0].input, { count: 1 });
    process.emit("message", { type: "unrelated" });
    process.emit("message", "null");
    reply(3, "third"); reply(1, "first"); reply(2, "second");
    assert.deepEqual(await Promise.all([first, second, third]), ["first", "second", "third"]);
    for (const callback of callbacks) callback(null);
    await nextTurn();
    assert.equal(sent.length, 3);
    assert.equal(disconnects, 0);
  `);
});

test("guest client validates locally, always returns a handled promise, and permits recovery after bad input", { timeout }, async () => {
  await clientProbe(`
    let hooks = 0;
    for (const value of [undefined, NaN, 1n, new Date(), { toJSON() { hooks += 1; return null; } }]) {
      let promise;
      assert.doesNotThrow(() => { promise = callHost("module", "method", value); });
      assert.ok(promise instanceof Promise);
      await assert.rejects(promise, /Host-call envelope/);
    }
    await assert.rejects(callHost(1, "method", null), /must be strings/);
    assert.equal(sent.length, 0);
    assert.equal(hooks, 0);
    // Deliberately abandoned invalid and pending calls must not become unhandled.
    callHost("module", "method", undefined);
    const okay = callHost("module", "method", { valid: true });
    reply(parseHostMessage(sent[0]).id, "okay");
    assert.equal(await okay, "okay");
    callHost("module", "abandoned", null);
    closeHostClient();
    callHost("module", "after-close", null);
    await assert.rejects(callHost("module", "after-close", null), /closed/);
  `);
});

test("guest client reconstructs catchable remote errors without poisoning the next request", { timeout }, async () => {
  await clientProbe(`
    const bad = callHost("module", "bad", null);
    const rejection = assert.rejects(bad, error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "RangeError");
      assert.equal(error.message, "remote failure");
      assert.equal(error.stack, "remote stack");
      return true;
    });
    process.emit("message", encodeHostMessage({ type: HOST_RESPONSE_TYPE, id: 1, ok: false,
      error: { name: "RangeError", message: "remote failure", stack: "remote stack" } }));
    await rejection;
    const okay = callHost("module", "okay", null);
    reply(2, "recovered");
    assert.equal(await okay, "recovered");
    assert.equal(disconnects, 0);
  `);
});

for (const failure of ["malformed JSON", "native envelope", "wrong direction", "unknown response", "duplicate response", "extra field", "unknown version"]) {
  test(`guest client ${failure} rejects all pending calls and permanently closes the channel`, { timeout }, async () => {
    const messages = {
      "malformed JSON": 'process.emit("message", "not-json");',
      "native envelope": 'process.emit("message", { type: HOST_RESPONSE_TYPE, id: 1, ok: true, value: null });',
      "wrong direction": 'process.emit("message", encodeHostMessage({ type: HOST_REQUEST_TYPE, id: 1, moduleId: "m", method: "f", input: null }));',
      "unknown response": 'reply(999, "unknown");',
      "duplicate response": 'reply(3, "duplicate");',
      "extra field": 'process.emit("message", JSON.stringify({ type: HOST_RESPONSE_TYPE, id: 1, ok: true, value: null, extra: true }));',
      "unknown version": 'process.emit("message", JSON.stringify({ type: "ts-executor:host-response:v2", id: 1, ok: true, value: null }));',
    };
    await clientProbe(`
      const first = callHost("module", "first", null);
      const second = callHost("module", "second", null);
      ${failure === "duplicate response" ? 'const completed = callHost("module", "completed", null); reply(3, "done"); assert.equal(await completed, "done");' : ""}
      const rejected = [assert.rejects(first, /Invalid host-call protocol/), assert.rejects(second, /Invalid host-call protocol/)];
      assert.doesNotThrow(() => { ${messages[failure]} });
      await Promise.all(rejected);
      assert.equal(disconnects, 1);
      const count = sent.length;
      await assert.rejects(callHost("module", "later", null), /Invalid host-call protocol/);
      assert.equal(sent.length, count);
    `);
  });
}

for (const failure of ["send throw", "send callback", "delayed callback", "disconnect", "error", "close"]) {
  test(`guest client ${failure} consumes abandoned rejections and never retries side effects`, { timeout }, async () => {
    await clientProbe(`
      callHost("module", "abandoned", null);
      const pending = callHost("module", "observed", null);
      const rejected = assert.rejects(pending, /failed|disconnected|closed/);
      ${failure === "send throw" ? 'sendError = new Error("send failed"); callHost("module", "trigger", null);' : ""}
      ${failure === "send callback" ? 'callbackError = new Error("callback failed"); callHost("module", "trigger", null);' : ""}
      ${failure === "delayed callback" ? 'callbacks[0](new Error("queued send failed"));' : ""}
      ${failure === "disconnect" ? 'process.connected = false; process.emit("disconnect");' : ""}
      ${failure === "error" ? 'process.emit("error", new Error("transport failed"));' : ""}
      ${failure === "close" ? "closeHostClient();" : ""}
      await rejected;
      const count = sent.length;
      callHost("module", "abandoned-after-close", null);
      await assert.rejects(callHost("module", "later", null), /failed|disconnected|closed/);
      for (const callback of callbacks) callback(new Error("late callback failed"));
      await nextTurn();
      assert.equal(sent.length, count);
    `);
  });
}

test("guest client unavailable/initially disconnected paths reject as promises without installing a channel", { timeout }, async () => {
  await clientProbe(`
    callHost("module", "abandoned", null);
    await assert.rejects(callHost("module", "method", null), /IPC is unavailable/);
    assert.equal(sent.length, 0);
  `, { available: false });
  await clientProbe(`
    callHost("module", "abandoned", null);
    await assert.rejects(callHost("module", "method", null), /channel disconnected/);
    assert.equal(sent.length, 0);
  `, { connected: false });
  await clientProbe(`
    await assert.rejects(callHost("module", "method", null), /IPC is unavailable/);
    assert.equal(sent.length, 0);
  `, { initialize: false });
});
