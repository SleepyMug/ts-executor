import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Kind, Type } from "@sinclair/typebox";
import { TypeSystemPolicy } from "@sinclair/typebox/system";
import ts from "typescript";
import { captureHostFunction, hostFunction } from "../dist/host-function.js";

const context = Object.freeze({ signal: new AbortController().signal });

function captured(input, output = input, handler = value => value) {
  return captureHostFunction(hostFunction({ input, output, handler }));
}

function checkSources(sources) {
  const files = new Map(Object.entries(sources).map(([file, text]) => [resolve(file), text]));
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: false,
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalSource = host.getSourceFile.bind(host);
  host.readFile = file => files.get(resolve(file)) ?? originalRead(file);
  host.fileExists = file => files.has(resolve(file)) || originalExists(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) => {
    const text = files.get(resolve(file));
    return text === undefined
      ? originalSource(file, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(file, text, languageVersion, true);
  };
  const program = ts.createProgram([...files.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, diagnostics.map(diagnostic => {
    const location = diagnostic.file === undefined ? "" : `${diagnostic.file.fileName}:${diagnostic.start}: `;
    return `${location}${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  }).join("\n"));
}

test("host function captures immutable schemas, description, handler and detached boundary values", async () => {
  const input = Type.Object({ value: Type.Number() }, { additionalProperties: false });
  const output = Type.Object({ result: Type.Number() }, { additionalProperties: false });
  let seen;
  const result = { result: 2 };
  const options = {
    input,
    output,
    description: "original description",
    handler(value, callContext) {
      assert.equal(callContext, context);
      seen = value;
      value.value = 8;
      return result;
    },
  };
  const handle = hostFunction(options);
  const definition = captureHostFunction(handle);
  assert.ok(Object.isFrozen(handle));
  assert.ok(Object.isFrozen(definition));
  assert.equal(definition, captureHostFunction(handle));
  options.handler = () => { throw new Error("replacement must not run"); };
  options.description = "replacement";
  input.properties.value.type = "string";
  output.properties.result.type = "string";
  input.required.length = 0;
  const original = { value: 1 };
  const returned = await definition.invoke(original, context);
  assert.notEqual(seen, original);
  assert.deepEqual(original, { value: 1 });
  assert.notEqual(returned, result);
  result.result = 100;
  assert.deepEqual(returned, { result: 2 });
  assert.equal(definition.description, "original description");
  await assert.rejects(definition.invoke({ value: "1" }, context), /input does not match its schema/u);
  await assert.rejects(definition.invoke({}, context), /input does not match its schema/u);
  const declaration = await definition.declaration("immutable");
  assert.match(declaration, /value: number/u);
  assert.match(declaration, /result: number/u);
  assert.match(declaration, /original description/u);
  assert.doesNotMatch(declaration, /replacement/u);
});

test("host function handles cannot be fabricated, copied, or proxied", () => {
  const handle = hostFunction({ input: Type.Null(), output: Type.Null(), handler: () => null });
  for (const value of [undefined, null, false, "function", {}, { ...handle }, new Proxy(handle, {}), { invoke() {} }]) {
    assert.throws(() => captureHostFunction(value), /created by hostFunction/u);
  }
});

test("host function validates all supported kinds without coercion", async () => {
  const cases = [
    [Type.String({ minLength: 2, pattern: "^a" }), "abc", "z"],
    [Type.Number({ minimum: 1, maximum: 3 }), 2, "2"],
    [Type.Integer(), 2, 1.5],
    [Type.Boolean(), true, 1],
    [Type.Null(), null, false],
    [Type.Literal("yes"), "yes", "no"],
    [Type.Array(Type.Number(), { minItems: 1, maxItems: 2 }), [1, 2], [1, 2, 3]],
    [Type.Tuple([Type.String(), Type.Number()]), ["x", 2], ["x"]],
    [Type.Tuple([]), [], [null]],
    [Type.Union([Type.String(), Type.Null()]), null, 1],
    [Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.Number() })], { unevaluatedProperties: false }), { a: "x", b: 2 }, { a: "x", b: 2, c: true }],
    [Type.Record(Type.String(), Type.Number(), { additionalProperties: false }), { a: 1 }, { a: "1" }],
    [Type.Record(Type.Number(), Type.Boolean(), { additionalProperties: false }), { 1: true }, { x: true }],
    [Type.Object({ id: Type.Readonly(Type.Integer()), tag: Type.Optional(Type.String()) }, { additionalProperties: false }), { id: 1 }, { id: 1, extra: true }],
    [Type.Enum({ A: "a", B: "b" }), "a", "c"],
  ];
  for (const [schema, valid, invalid] of cases) {
    const definition = captured(schema);
    assert.deepEqual(await definition.invoke(valid, context), valid, schema[Kind]);
    await assert.rejects(definition.invoke(invalid, context), /input does not match its schema/u, schema[Kind]);
    const output = captured(Type.Null(), schema, () => invalid);
    await assert.rejects(output.invoke(null, context), /output does not match its schema/u, schema[Kind]);
  }
  await assert.rejects(captured(Type.Never()).invoke(null, context), /input does not match its schema/u);
  await assert.rejects(captured(Type.Null(), Type.Never(), () => null).invoke(null, context), /output does not match its schema/u);
});

test("strict JSON rejects non-data before permissive schema checks and before returning results", async () => {
  let calls = 0;
  let getterCalls = 0;
  const cyclic = {};
  cyclic.self = cyclic;
  const withGetter = Object.defineProperty({}, "value", { enumerable: true, get() { getterCalls += 1; return 1; } });
  const nonEnumerable = Object.defineProperty({}, "hidden", { value: 1 });
  const withToJSON = { toJSON() { getterCalls += 1; return null; } };
  const values = [
    undefined, NaN, Infinity, -Infinity, 1n, Symbol("x"), () => null,
    new Date(), new Map(), new Set(), /x/u, new Uint8Array([1]),
    new (class { value = 1; })(), cyclic, Array(1), Object.assign([], { extra: 1 }),
    { x: undefined }, [undefined], { [Symbol("x")]: 1 }, withGetter, nonEnumerable, withToJSON,
  ];
  for (const schema of [Type.Any(), Type.Unknown()]) {
    const inputDefinition = captured(schema, schema, value => { calls += 1; return value; });
    for (const invalid of values) {
      await assert.rejects(inputDefinition.invoke(invalid, context), /Host function input at/u);
      const outputDefinition = captured(Type.Null(), schema, () => invalid);
      await assert.rejects(outputDefinition.invoke(null, context), /Host function output at/u);
    }
    assert.deepEqual(await inputDefinition.invoke({ safe: [null, true, 1] }, context), { safe: [null, true, 1] });
  }
  assert.equal(calls, 2);
  assert.equal(getterCalls, 0);
});

test("JSON property validation ignores inherited properties but preserves explicit prototype-named data", async () => {
  const definition = captured(Type.Object({ toString: Type.Any() }));
  await assert.rejects(definition.invoke({}, context), /input does not match its schema/u);
  assert.deepEqual(await definition.invoke({ toString: "data" }, context), { toString: "data" });
  const properties = Object.fromEntries([["__proto__", Type.String()], ["constructor", Type.Number()]]);
  const protoDefinition = captured(Type.Object(properties, { additionalProperties: false }));
  await assert.rejects(protoDefinition.invoke({ constructor: 1 }, context), /input does not match its schema/u);
  const value = JSON.parse('{"__proto__":"data","constructor":1}');
  assert.deepEqual(await protoDefinition.invoke(value, context), value);
  assert.equal(Object.getPrototypeOf(await protoDefinition.invoke(value, context)), Object.prototype);
});

test("unsupported schema kinds, modifiers, formats, refs and keywords fail at construction", () => {
  const refTarget = Type.Object({ value: Type.String() }, { $id: "Target" });
  const schemas = [
    Type.BigInt(), Type.Undefined(), Type.Void(), Type.Date(), Type.Uint8Array(), Type.Symbol(),
    Type.Function([], Type.Null()), Type.Constructor([], Type.Object({})), Type.Promise(Type.Null()),
    Type.Iterator(Type.Null()), Type.AsyncIterator(Type.Null()), Type.RegExp(/a/u),
    Type.Not(Type.String()), Type.TemplateLiteral("a${string}"), Type.Unsafe({ type: "string" }),
    Type.Transform(Type.String()).Decode(value => value.length).Encode(String),
    Type.Object({ nested: Type.Transform(Type.String()).Decode(value => value.length).Encode(String) }),
    Type.Ref(refTarget), Type.Object({ nested: Type.Ref(refTarget) }),
    Type.Recursive(Self => Type.Object({ child: Type.Optional(Self) })),
    Type.String({ format: "email" }), Type.String({ format: "arbitrary-custom-format" }),
    Type.String({ tsType: "Date" }), Type.String({ $ref: "https://example.invalid/schema" }),
    Type.String({ oneOf: [{ type: "number" }] }), Type.String({ callback() {} }),
    Type.Array(Type.String(), { contains: Type.String() }),
    Type.Array(Type.Any(), { uniqueItems: true }),
    Type.Object({ "[k: string]": Type.String() }, { additionalProperties: false }),
    Type.Object({ nested: Type.Object({ "[k: string]": Type.Number() }) }),
    Type.Object({}, { additionalProperties: Type.Number() }),
    Type.Intersect([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })], { unevaluatedProperties: Type.Number() }),
    Type.Object({ a: Type.String() }, { dependencies: { a: ["b"] } }),
    Type.Object({}, { default: new Date() }),
    Type.String({ minLength: -1 }), Type.Number({ multipleOf: 0 }),
    { ...Type.String(), [Symbol("custom")]: "callback" },
  ];
  for (const schema of schemas) {
    assert.throws(() => captured(schema), /Host function schema/u, String(schema[Kind]));
    assert.throws(() => captured(Type.Null(), schema), /Host function schema/u, String(schema[Kind]));
  }
  const accessor = Type.String();
  Object.defineProperty(accessor, "description", { enumerable: true, get() { throw new Error("must not read accessor"); } });
  assert.throws(() => captured(accessor), /not accessors/u);
  const cyclic = Type.Object({});
  cyclic.properties.child = cyclic;
  assert.throws(() => captured(cyclic), /cycles/u);
});

test("host functions retain TypeBox policy at capture without consulting mutable registries", async () => {
  const definition = captured(Type.Object({ value: Type.String() }));
  const previous = TypeSystemPolicy.AllowArrayObject;
  try {
    TypeSystemPolicy.AllowArrayObject = true;
    assert.throws(() => captured(Type.Object({})), /AllowArrayObject/u);
    await assert.rejects(definition.invoke([], context), /input does not match its schema/u);
  } finally {
    TypeSystemPolicy.AllowArrayObject = previous;
  }
});

test("handler failures propagate and an execution AbortSignal is forwarded", async () => {
  const controller = new AbortController();
  const error = new Error("handler failure");
  const definition = captured(Type.Null(), Type.Null(), async (_value, callContext) => {
    assert.equal(callContext.signal, controller.signal);
    await new Promise(resolve => callContext.signal.addEventListener("abort", resolve, { once: true }));
    throw error;
  });
  const promise = definition.invoke(null, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, candidate => candidate === error);
});

test("declarations are self-contained, escaped, collision-safe, typed and async", async () => {
  const method = hostFunction({
    input: Type.Object({
      id: Type.Integer({ title: "Promise", $id: "Repeated" }),
      optional: Type.Optional(Type.String()),
      nested: Type.Object({ value: Type.String() }, { title: "Collision", $id: "Repeated", additionalProperties: false }),
      pair: Type.Tuple([Type.Literal("tag"), Type.Number()]),
    }, { title: "Collision", additionalProperties: false }),
    output: Type.Object({ message: Type.String({ description: "schema */ export type Injected = string; /*" }) }, { title: "Collision", additionalProperties: false }),
    description: "method */ export type Injected = number; /*\nsecond line",
    handler: () => ({ message: "hello" }),
  });
  const definition = captureHostFunction(method);
  const declarations = await Promise.all(["a_b", "aB", "A_B", "Promise", "HostFunction615F62Input"].map(name => definition.declaration(name)));
  const impossible = await captured(Type.Never()).declaration("impossible");
  const openRecord = await captured(Type.Record(Type.String(), Type.Number())).declaration("openRecord");
  const closedRecord = await captured(Type.Record(Type.String(), Type.Number(), { additionalProperties: false })).declaration("closedRecord");
  const unknown = await captured(Type.Unknown()).declaration("unknownValue");
  const bounded = await captured(Type.Array(Type.Number(), { minItems: 1_000_000_000 })).declaration("bounded");
  assert.match(bounded, /= number\[\];/u);
  assert.match(impossible, /= never;/u);
  assert.match(openRecord, /\[k: string\]: unknown;/u);
  assert.match(closedRecord, /\[k: string\]: number;/u);
  assert.doesNotMatch(declarations.join("\n"), /export (?:type|interface) Collision/u);
  assert.match(declarations[0], /schema \*\\\//u);
  assert.match(declarations[0], /method \*\\\//u);
  checkSources({
    "host-function-generated.d.ts": [...declarations, impossible, openRecord, closedRecord, unknown, bounded].join("\n"),
    "host-function-consumer.mts": `
      import { a_b, aB, A_B, Promise as callbackPromise, closedRecord, impossible, unknownValue } from "./host-function-generated.js";
      const input = { id: 1, nested: { value: "v" }, pair: ["tag", 2] as ["tag", number] };
      const result: Promise<{ message: string }> = a_b(input);
      const other: Promise<{ message: string }> = aB(input);
      A_B(input); callbackPromise(input);
      const record: Promise<{ [key: string]: number }> = closedRecord({ a: 1 });
      const anything: Promise<unknown> = unknownValue({ data: [null] });
      // @ts-expect-error never is uncallable
      impossible(null);
      // @ts-expect-error wrong input value type
      a_b({ ...input, id: "wrong" });
      // @ts-expect-error missing required field
      aB({ id: 1 });
      // @ts-expect-error asynchronous result
      const immediate: { message: string } = a_b(input);
      // @ts-expect-error comment injection did not create an export
      import type { Injected } from "./host-function-generated.js";
    `,
  });
  for (const invalid of ["", "not-valid", "a); export const p: number; //", "default", "class", "await", "null", "eval", "arguments", "let", "interface", "implements", "package", "private", "protected", "public", "static"]) {
    await assert.rejects(definition.declaration(invalid), /TypeScript identifier/u);
  }
});

test("public hostFunction generics infer input, output and callback context", () => {
  checkSources({
    "host-function-inference.mts": `
      import { Type } from "@sinclair/typebox";
      import { hostFunction, type HostFunction } from "./dist/host-function.js";
      const definition: HostFunction = hostFunction({
        input: Type.Object({ id: Type.Integer(), tag: Type.Optional(Type.String()) }),
        output: Type.Object({ message: Type.String() }),
        handler(input, context) {
          const id: number = input.id;
          const tag: string | undefined = input.tag;
          const signal: AbortSignal = context.signal;
          // @ts-expect-error the inferred input is not any
          const wrong: string = input.id;
          // @ts-expect-error context signal is readonly
          context.signal = signal;
          return { message: String(id) };
        },
      });
      hostFunction({ input: Type.Null(), output: Type.String(), handler: async () => "okay" });
      hostFunction({ input: Type.Null(), output: Type.String(),
        // @ts-expect-error wrong synchronous output
        handler: () => 123,
      });
      hostFunction({ input: Type.Null(), output: Type.String(),
        // @ts-expect-error wrong asynchronous output
        handler: async () => 123,
      });
      // @ts-expect-error an unchecked callback cannot fabricate a host function
      const forged: HostFunction = { handler: () => null };
    `,
  });
});
