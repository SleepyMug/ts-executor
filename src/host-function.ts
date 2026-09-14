import {
  Hint,
  Kind,
  OptionalKind,
  ReadonlyKind,
  TransformKind,
  TypeGuard,
  type Static,
  type TSchema,
} from "@sinclair/typebox";
import { TypeCompiler, type TypeCheck } from "@sinclair/typebox/compiler";
import { TypeSystemPolicy } from "@sinclair/typebox/system";
import { compile, type JSONSchema } from "json-schema-to-typescript";
import { stringifyJsonValue } from "./json-value.js";
import type { JsonValue } from "./types.js";

export interface HostCallContext {
  readonly signal: AbortSignal;
}

declare const hostFunctionBrand: unique symbol;

/** An opaque, immutable handle. Only hostFunction() can create usable handles. */
export interface HostFunction {
  readonly [hostFunctionBrand]: true;
}

export interface HostFunctionOptions<I extends TSchema, O extends TSchema> {
  readonly input: I;
  readonly output: O;
  readonly description?: string;
  readonly handler: (input: Static<I>, context: HostCallContext) => Static<O> | Promise<Static<O>>;
}

/** @internal Captured capabilities, not caller-owned schemas or a raw handler. */
export interface CapturedHostFunction {
  readonly description?: string;
  readonly declaration: (name: string) => Promise<string>;
  readonly invoke: (input: unknown, context: HostCallContext) => Promise<JsonValue>;
}

const definitions = new WeakMap<HostFunction, CapturedHostFunction>();
const jsonParse = JSON.parse;
const reservedNames = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export", "extends",
  "false", "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private", "protected",
  "public", "return", "static", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield",
]);
const annotations = new Set([
  "$id", "$schema", "$comment", "title", "description", "default", "examples",
  "readOnly", "writeOnly", "deprecated",
]);
const keywords: Readonly<Record<string, readonly string[]>> = {
  Any: [],
  Unknown: [],
  String: ["type", "minLength", "maxLength", "pattern"],
  Number: ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  Integer: ["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  Boolean: ["type"],
  Null: ["type"],
  Literal: ["type", "const"],
  Never: ["not"],
  Object: ["type", "properties", "required", "additionalProperties", "minProperties", "maxProperties"],
  Array: ["type", "items", "minItems", "maxItems", "uniqueItems"],
  Tuple: ["type", "items", "additionalItems", "minItems", "maxItems"],
  Union: ["anyOf"],
  Intersect: ["type", "allOf", "unevaluatedProperties"],
  Record: ["type", "patternProperties", "additionalProperties", "minProperties", "maxProperties"],
};

type SchemaData = Record<PropertyKey, unknown>;

function schemaError(path: string, detail: string): never {
  throw new TypeError(`Host function schema at ${path} ${detail}`);
}

/** Clone data descriptors, including TypeBox symbols, without executing getters. */
function cloneSchemaData(value: unknown, path: string, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) {
    return schemaError(path, "must contain only schema data (no callbacks or non-JSON values)");
  }
  if (ancestors.has(value)) return schemaError(path, "must not contain cycles or recursive references");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return schemaError(path, "must use plain objects and arrays");
  }
  ancestors.add(value);
  try {
    const result: SchemaData | unknown[] = array ? [] : Object.create(null) as SchemaData;
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) return schemaError(path, "must use dense arrays without extras");
    for (const key of keys) {
      if (array && key === "length") continue;
      if (array && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) {
        return schemaError(path, "must use dense arrays without extras");
      }
      if (typeof key === "symbol" && key !== Kind && key !== OptionalKind && key !== ReadonlyKind && key !== Hint) {
        return schemaError(path, key === TransformKind ? "does not support transforms" : "has an unsupported symbol");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return schemaError(path, "must use enumerable data properties, not accessors");
      }
      Object.defineProperty(result, key, {
        value: cloneSchemaData(descriptor.value, `${path}[${JSON.stringify(String(key))}]`, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function asObject(value: unknown, path: string): SchemaData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return schemaError(path, "must be a schema object");
  }
  return value as SchemaData;
}

/** An explicit keyword allowlist prevents the compiler and generator disagreeing silently. */
function inspectSchema(value: unknown, path: string): asserts value is TSchema {
  const schema = asObject(value, path);
  const kind = schema[Kind];
  if (typeof kind !== "string" || !Object.hasOwn(keywords, kind)) {
    return schemaError(path, `has unsupported TypeBox kind ${String(kind)}`);
  }
  for (const symbol of Object.getOwnPropertySymbols(schema)) {
    if (symbol === OptionalKind && schema[symbol] === "Optional") continue;
    if (symbol === ReadonlyKind && schema[symbol] === "Readonly") continue;
    if (symbol === Hint && (schema[symbol] === "Record" || schema[symbol] === "Enum")) continue;
    if (symbol !== Kind) return schemaError(path, `has unsupported modifier ${String(symbol)}`);
  }
  for (const key of Object.keys(schema)) {
    const childPath = `${path}.${key}`;
    const entry = schema[key];
    if (annotations.has(key)) {
      stringifyJsonValue(entry, `Host function schema annotation ${childPath}`);
      if (["$id", "$schema", "$comment", "title", "description"].includes(key) && typeof entry !== "string") {
        return schemaError(childPath, "must be a string");
      }
      if (["readOnly", "writeOnly", "deprecated"].includes(key) && typeof entry !== "boolean") {
        return schemaError(childPath, "must be a boolean");
      }
      continue;
    }
    if (!keywords[kind]!.includes(key)) return schemaError(childPath, "is not a supported keyword");
    if (["additionalProperties", "unevaluatedProperties", "additionalItems", "uniqueItems"].includes(key)) {
      if (typeof entry !== "boolean") return schemaError(childPath, "must be a boolean in the supported subset");
    }
    if (key === "uniqueItems" && entry === true) {
      return schemaError(childPath, "does not support uniqueItems: true (TypeBox's hash-only check can reject distinct values)");
    }
    if (["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"].includes(key)) {
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
        return schemaError(childPath, "must be a nonnegative safe integer");
      }
    }
    if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].includes(key)) {
      if (typeof entry !== "number" || !Number.isFinite(entry) || (key === "multipleOf" && entry <= 0)) {
        return schemaError(childPath, "must be a finite number (positive for multipleOf)");
      }
    }
  }
  // References are forbidden, so identifiers have no validation meaning. Removing
  // them also avoids TypeCompiler conflating distinct schemas with the same $id.
  delete schema.$id;
  delete schema.$schema;

  if (kind === "Object" || kind === "Record") {
    const key = kind === "Object" ? "properties" : "patternProperties";
    const properties = asObject(schema[key], `${path}.${key}`);
    if (Object.getOwnPropertySymbols(properties).length !== 0) return schemaError(path, "has symbol property names");
    for (const [name, child] of Object.entries(properties)) {
      if (kind === "Object" && name === "[k: string]") {
        return schemaError(path, 'does not support the literal property "[k: string]" (reserved by the declaration generator)');
      }
      inspectSchema(child, `${path}.${key}[${JSON.stringify(name)}]`);
    }
    if (kind === "Object" && schema.required !== undefined) {
      if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !Object.hasOwn(properties, key))
        || new Set(schema.required).size !== schema.required.length) {
        return schemaError(`${path}.required`, "must list distinct declared property names");
      }
    }
  }
  if (kind === "Array") inspectSchema(schema.items, `${path}.items`);
  if (kind === "Tuple" || kind === "Union" || kind === "Intersect") {
    const key = kind === "Tuple" ? "items" : kind === "Union" ? "anyOf" : "allOf";
    const children = schema[key];
    if (kind === "Tuple" && children === undefined && schema.minItems === 0 && schema.maxItems === 0) {
      // Type.Tuple([]) omits items and additionalItems.
    } else {
      if (!Array.isArray(children) || (kind !== "Tuple" && children.length === 0)) {
        return schemaError(`${path}.${key}`, "must be an array of schemas");
      }
      children.forEach((child, index) => inspectSchema(child, `${path}.${key}[${index}]`));
      if (kind === "Tuple" && (children.length !== schema.minItems || children.length !== schema.maxItems)) {
        return schemaError(path, "must describe a fixed-length tuple");
      }
    }
    if (kind === "Tuple" && schema.additionalItems !== undefined && schema.additionalItems !== false) {
      return schemaError(path, "does not support tuple rest items");
    }
  }
  if (kind === "Literal" && schema.type !== typeof schema.const) return schemaError(path, "has an inconsistent literal type");
  if (kind === "Never" && Reflect.ownKeys(asObject(schema.not, `${path}.not`)).length !== 0) {
    return schemaError(path, "must use Type.Never() rather than general negation");
  }
  if (!TypeGuard.IsSchema(schema)) return schemaError(path, "is not a well-formed TypeBox schema");
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as SchemaData)[key]);
  Object.freeze(value);
}

function captureSchema(value: TSchema, path: string): TSchema {
  const schema = cloneSchemaData(value, path);
  inspectSchema(schema, path);
  deepFreeze(schema);
  return schema;
}

function escapeComment(value: string): string {
  return value.replaceAll("*/", "*\\/");
}

/** Strip caller-controlled naming/code-generation extensions and TypeBox symbols. */
function declarationSchema(schema: TSchema): JSONSchema {
  const result: Record<string, unknown> = {};
  if (schema.description !== undefined) result.description = escapeComment(schema.description);
  if (schema.deprecated !== undefined) result.deprecated = schema.deprecated;
  if (schema[Kind] === "Never") return { ...result, tsType: "never" } as JSONSchema;
  // TypeBox's empty schemas mean any JSON at this boundary, not an empty object.
  if (schema[Kind] === "Any" || schema[Kind] === "Unknown") return { ...result, tsType: "unknown" } as JSONSchema;
  for (const key of Object.keys(schema)) {
    if (annotations.has(key)) continue;
    // Array length constraints are runtime-only. Passing enormous bounds to the
    // generator would expand them into enormous tuples; actual Tuple schemas
    // retain their fixed items and bounds below.
    if (schema[Kind] === "Array" && (key === "minItems" || key === "maxItems")) continue;
    const value: unknown = schema[key];
    if (key === "properties") {
      result[key] = Object.fromEntries(Object.entries(value as Record<string, TSchema>)
        .map(([name, child]) => [name, declarationSchema(child)]));
    } else if (key === "items" && !Array.isArray(value)) {
      result[key] = declarationSchema(value as TSchema);
    } else if (key === "items" || key === "allOf" || key === "anyOf") {
      result[key] = (value as TSchema[]).map(declarationSchema);
    } else if (key !== "patternProperties") {
      result[key] = value;
    }
  }
  if (schema[Kind] === "Record") {
    const [pattern, child] = Object.entries(schema.patternProperties as Record<string, TSchema>)[0]!;
    // Patterned records can admit arbitrary nonmatching properties. The upstream
    // generator incorrectly gives *all* keys the pattern's value type, even for
    // open records. Emit a conservative index signature instead. Closed records
    // retain their value type; key patterns remain runtime-only constraints.
    const matchesEveryKey = pattern === "^[\\s\\S]*$";
    result.additionalProperties = schema.additionalProperties === false || matchesEveryKey
      ? declarationSchema(child)
      : true;
  }
  return result as JSONSchema;
}

function validateName(name: string): void {
  // Include strict-mode/module reserved bindings, not just parser keywords.
  if (typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) || reservedNames.has(name)) {
    throw new TypeError("Host function name must be a non-reserved TypeScript identifier");
  }
}

async function declaration(input: TSchema, output: TSchema, description: string | undefined, name: string): Promise<string> {
  validateName(name);
  // Uppercase hex is injective and unchanged by the generator's identifier
  // normalization (unlike camel-casing names such as a_b, aB, and A_B).
  const prefix = `HostFunction${Buffer.from(name, "utf8").toString("hex").toUpperCase()}`;
  const inputName = `${prefix}Input`;
  const outputName = `${prefix}Output`;
  const options = { bannerComment: "", unknownAny: true };
  const [inputDeclaration, outputDeclaration] = await Promise.all([
    compile(declarationSchema(input), inputName, options),
    compile(declarationSchema(output), outputName, options),
  ]);
  const comment = description === undefined ? "" : `/**\n${escapeComment(description).split(/\r\n|\r|\n/u).map(line => ` * ${line}`).join("\n")}\n */\n`;
  return `${inputDeclaration}\n${outputDeclaration}\n${comment}export declare function ${name}(input: ${inputName}): Promise<${outputName}>;\n`;
}

function validatedSnapshot(value: unknown, validator: TypeCheck<TSchema>, label: string): JsonValue {
  // Strict JSON validation precedes both schema checking and JSON encoding. Never
  // pass the caller's object, accessors, toJSON hooks, or shared references through.
  const encoded = stringifyJsonValue(value, label);
  // TypeCompiler uses inherited-property lookups for object properties. Validate
  // a prototype-free view so required `toString`/`__proto__` cannot be inherited.
  const checkValue: unknown = jsonParse(encoded, (_key: string, child: unknown) => {
    if (typeof child === "object" && child !== null && !Array.isArray(child)) Object.setPrototypeOf(child, null);
    return child;
  });
  if (!validator.Check(checkValue)) throw new TypeError(`${label} does not match its schema`);
  return jsonParse(encoded) as JsonValue;
}

/**
 * Define a JSON-only host callback, capturing schemas and handler immediately.
 *
 * Supports Object, Array, fixed Tuple, Union, Intersect, Record, String, Number,
 * Integer, Boolean, Null, Literal, Never, Any and Unknown, including optional and
 * readonly properties. Numeric/string/collection bounds and patterns are runtime
 * constraints, not TypeScript refinements. Open patterned Records have conservative
 * unknown index values in declarations; use additionalProperties: false for typed
 * closed records. Any/Unknown declarations are unknown, but still enforce JSON.
 *
 * Only boolean additionalProperties/unevaluatedProperties are supported. Refs,
 * recursion, transforms, formats (all TypeBox formats use a mutable callback
 * registry), custom kinds/keywords, contains, uniqueItems: true, general negation,
 * the literal property "[k: string]", and non-JSON schemas are rejected. Schemas
 * must contain plain data, not accessors or hooks.
 */
export function hostFunction<I extends TSchema, O extends TSchema>(options: HostFunctionOptions<I, O>): HostFunction {
  const { input, output, description, handler } = options;
  if (typeof handler !== "function") throw new TypeError("Host function handler must be a function");
  if (description !== undefined && typeof description !== "string") throw new TypeError("Host function description must be a string");
  if (TypeSystemPolicy.AllowArrayObject) throw new TypeError("Host functions require TypeBox AllowArrayObject to be false");
  const inputSchema = captureSchema(input, "input");
  const outputSchema = captureSchema(output, "output");
  const inputValidator = TypeCompiler.Compile(inputSchema);
  const outputValidator = TypeCompiler.Compile(outputSchema);
  const definition: CapturedHostFunction = Object.freeze({
    ...(description === undefined ? {} : { description }),
    declaration: (name: string) => declaration(inputSchema, outputSchema, description, name),
    invoke: async (value: unknown, context: HostCallContext): Promise<JsonValue> => {
      const argument = validatedSnapshot(value, inputValidator, "Host function input");
      const result: unknown = await handler(argument as Static<I>, context);
      return validatedSnapshot(result, outputValidator, "Host function output");
    },
  });
  const handle = Object.freeze(Object.create(null)) as HostFunction;
  definitions.set(handle, definition);
  return handle;
}

/** @internal Reject structurally fabricated or copied handles at registration. */
export function captureHostFunction(value: HostFunction): CapturedHostFunction {
  const definition = definitions.get(value);
  if (definition === undefined) throw new TypeError("Expected a host function created by hostFunction()");
  return definition;
}
