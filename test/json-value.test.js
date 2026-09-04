import assert from "node:assert/strict";
import test from "node:test";
import {
  inputEnvelopeJson,
  normalizeJsonValue,
  parseInputEnvelope,
  parseResultEnvelope,
  stringifyJsonValue,
} from "../dist/json-value.js";

function roundTrip(value) {
  return JSON.parse(stringifyJsonValue(value));
}

test("strict JSON validation accepts every JSON data shape without invoking object hooks", () => {
  const shared = { value: 1 };
  const nullPrototype = Object.assign(Object.create(null), { okay: true });
  const protoKey = JSON.parse('{"__proto__":{"safe":true}}');
  const accepted = [
    null,
    false,
    true,
    0,
    -0,
    1.25,
    "",
    "unicode ☃",
    [],
    [null, true, 2, "three", []],
    {},
    { nested: { list: [1, 2] } },
    nullPrototype,
    protoKey,
    { first: shared, second: shared },
    Object.freeze({ frozen: Object.freeze([1, 2]) }),
  ];

  for (const value of accepted) {
    assert.doesNotThrow(() => stringifyJsonValue(value));
    assert.deepEqual(roundTrip(value), JSON.parse(JSON.stringify(value)));
  }
  const normalized = normalizeJsonValue(nullPrototype);
  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.equal(normalized.okay, true);
  assert.equal(Object.hasOwn(normalizeJsonValue(protoKey), "__proto__"), true);
});

test("strict JSON validation rejects coercive, sparse, cyclic, and non-plain values", () => {
  class Custom {
    value = 1;
  }
  class CustomArray extends Array {}
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse.length = 1;
  const extraArrayProperty = [1];
  extraArrayProperty.extra = true;
  const symbolObject = { okay: true };
  symbolObject[Symbol("hidden")] = 1;
  const symbolArray = [1];
  symbolArray[Symbol("hidden")] = 1;
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, "hidden", { value: 1 });
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      throw new Error("getter must not run");
    },
  });

  const rejected = [
    undefined,
    1n,
    Symbol("value"),
    () => undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date(0),
    /pattern/u,
    new Map(),
    new Set(),
    new Uint8Array([1]),
    new Custom(),
    new CustomArray(1, 2),
    Object.setPrototypeOf([1, 2], null),
    cyclic,
    sparse,
    extraArrayProperty,
    symbolObject,
    symbolArray,
    nonEnumerable,
    accessor,
    { missing: undefined },
    { method() {} },
  ];

  for (const value of rejected) {
    assert.throws(() => stringifyJsonValue(value), TypeError);
  }
});

test("validation and encoding use captured intrinsics instead of mutable hooks", () => {
  const originalFinite = Number.isFinite;
  const originalStringify = JSON.stringify;
  const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  try {
    Number.isFinite = () => true;
    JSON.stringify = () => '{"forged":true}';
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value() { return { forged: "object" }; },
    });
    Object.defineProperty(Array.prototype, "toJSON", {
      configurable: true,
      value() { return ["forged-array"]; },
    });

    assert.throws(() => stringifyJsonValue(Number.NaN), /finite number/u);
    assert.equal(stringifyJsonValue({ list: [1, 2], okay: true }), '{"list":[1,2],"okay":true}');
  } finally {
    Number.isFinite = originalFinite;
    JSON.stringify = originalStringify;
    if (objectHook === undefined) delete Object.prototype.toJSON;
    else Object.defineProperty(Object.prototype, "toJSON", objectHook);
    if (arrayHook === undefined) delete Array.prototype.toJSON;
    else Object.defineProperty(Array.prototype, "toJSON", arrayHook);
  }
});

test("input and result envelopes require exact discriminated JSON shapes", () => {
  assert.deepEqual(parseInputEnvelope(inputEnvelopeJson(false, undefined)), { hasInput: false });
  assert.deepEqual(parseInputEnvelope(inputEnvelopeJson(true, { value: 1 })), {
    hasInput: true,
    value: { value: 1 },
  });
  assert.deepEqual(parseResultEnvelope('{"ok":true,"value":[1,null]}'), {
    ok: true,
    value: [1, null],
  });
  assert.deepEqual(parseResultEnvelope(
    '{"ok":false,"error":{"name":"RangeError","message":"bad","stack":"trace"}}',
  ), {
    ok: false,
    error: { name: "RangeError", message: "bad", stack: "trace" },
  });

  const invalidInputs = [
    "not json",
    "null",
    "{}",
    '{"hasInput":false,"value":null}',
    '{"hasInput":true}',
    '{"hasInput":true,"value":null,"extra":1}',
    '{"hasInput":true,"value":1e999}',
  ];
  for (const input of invalidInputs) assert.throws(() => parseInputEnvelope(input));

  const invalidResults = [
    "not json",
    "null",
    "{}",
    '{"ok":true}',
    '{"ok":true,"value":null,"extra":1}',
    '{"ok":true,"value":1e999}',
    '{"ok":false}',
    '{"ok":false,"error":{"name":"Error"}}',
    '{"ok":false,"error":{"name":"Error","message":"bad","extra":1}}',
    '{"ok":false,"error":{"name":"Error","message":"bad","stack":1}}',
  ];
  for (const result of invalidResults) assert.throws(() => parseResultEnvelope(result));
});

test("supplied non-JSON input is rejected before a workspace is created", async (t) => {
  const { TSFuncExecutor } = await import("../dist/index.js");
  const { project, workspaceNames } = await import("./helpers.js");
  const root = await project(t);
  const executor = new TSFuncExecutor({ resolutionRoot: root });

  for (const input of [undefined, Number.NaN, 1n, () => undefined, new Date(), [, 1]]) {
    await assert.rejects(executor.execute({
      cwd: root,
      source: "export function main(): null { return null; }\n",
      input,
    }), TypeError);
    assert.deepEqual(await workspaceNames(root), []);
  }
});
