# Host Functions Component

> Immutable TypeBox contracts supply inferred host handlers, strict JSON validation, and generated asynchronous guest declarations.

## Overview

`hostFunction` captures a handler and a supported pair of TypeBox input/output schemas. The resulting opaque handle is consumed by `hostModule`; it cannot be fabricated by copying properties. Schema capture occurs synchronously, before caller-owned schemas or options can change. The host owns the callback, its closures, and any persistent state it accesses.

## Provided APIs

- `Type` — re-export of `@sinclair/typebox`'s schema builder. Only the subset below is accepted by `hostFunction`.
- `hostFunction<I extends TSchema, O extends TSchema>({ input, output, description?, handler }): HostFunction` — infers `handler(input: Static<I>, context: HostCallContext): Static<O> | Promise<Static<O>>`. Captures and freezes schema data and the handler reference, compiles validators, and rejects unsupported schemas immediately. It does not execute the handler or write files.
- `HostCallContext` — `{ readonly signal: AbortSignal }`. All calls in one execution share its signal; channel closure/child exit aborts it. Handlers must cooperate to stop. No deadline or forced cancellation is supplied.
- `HostFunction` — immutable opaque handle. It exposes no raw callback or mutable schemas.
- Internal `captureHostFunction(handle)` — returns a frozen definition with `declaration(name): Promise<string>` and `invoke(input, context): Promise<JsonValue>`. Declarations are standalone named functions with one required input and a Promise result; schemas and descriptions become declarations/JSDoc. Names must be non-reserved ASCII TypeScript identifiers. Invocation validates a detached strict-JSON input against its schema, awaits the captured handler, and validates/snapshots the result. Validation failures throw TypeError; handler exceptions propagate to the bridge for serialization.

### Supported schema subset

Supports JSON Object, Array, fixed Tuple, Union, Intersect, Record, String, Number, Integer, Boolean, Null, Literal, Never, Any, and Unknown, with optional/readonly property modifiers. Numeric/string/collection bounds and patterns are runtime constraints, not TypeScript refinements. Any/Unknown declarations are `unknown` and still require strict JSON. Additional/unevaluated properties must be boolean. Closed records retain typed index values; open patterned records use conservative unknown values.

Rejects references/recursion, transforms, custom kinds/keywords, all formats (TypeBox's mutable callback registry), contains, general negation, non-JSON schema kinds, `uniqueItems: true`, and the literal property name `"[k: string]"`. Schemas must be ordinary data without accessors, hooks, or arbitrary symbols. TypeBox AllowArrayObject policy must be false at capture.

Use `Type.Null()` and pass/return `null` for no-data calls. Guest calls are always asynchronous, even when the host handler is synchronous. No undefined, dates, class instances, callbacks, streaming objects, or live object references cross this boundary.

## Consumed APIs

- [Modules](../modules/index.md#provided-apis) — host modules consume captured function definitions to generate a reusable package and route invocations.
- [Host-subprocess boundary](../../boundaries/host-subprocess-execution.md#host-call-protocol) — carries strict JSON values and serialized errors; closes execution signals.
- `@sinclair/typebox/compiler` — compiles immutable schema snapshots without coercion. A prototype-free validation view prevents inherited properties satisfying required fields.
- `json-schema-to-typescript` — emits declarations from a filtered schema view; caller naming/type overrides are not passed through. Descriptions are escaped and generated type names avoid collisions.
- [Schema tooling journal](../../experiment_journal/json-schema-tooling.md) — records validation/generator mismatches requiring the supported-subset exclusions and conservative mappings.

## Workflows

1. Define a function using `Type` schemas and a host callback; capture, inspect, freeze, and compile the contract.
2. `hostModule` requests declarations once while constructing its package; later checks/executions reuse those files.
3. A guest proxy sends a call. The host validates and detaches input before invoking the callback, then validates and detaches output before replying.
4. Schema validation is enforced even if the harness skips guest TypeScript checking. Host exceptions become catchable guest promise rejections.

## Execution-context Constraints

Schemas describe data, not authority. A host callback executes with ordinary host permissions and may persist effects even if an execution fails. Concurrent calls share the caller's host state; synchronization belongs to the handler. Disconnection and module disposal cannot undo effects or forcibly terminate arbitrary host work. TypeScript declarations cannot encode every runtime numeric/string constraint, and this component is not a security sandbox.
