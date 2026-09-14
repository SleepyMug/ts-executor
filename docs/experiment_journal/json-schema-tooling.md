# JSON Schema Tooling

> Records TypeBox validation and declaration-generation behavior that constrains JSON-only interfaces.

## Overview

TypeBox schemas carry static TypeScript types and runtime symbols; json-schema-to-typescript emits readable declarations from JSON Schema data. Combining them requires a supported subset rather than assuming the validator and generator interpret every construct identically.

## 2026-09-12: Hash-only uniqueness and index-signature sentinels need explicit exclusions

### Context

Validation and generated declarations must describe the same interface. Probes used Node v24.15.0 on Linux x64, `@sinclair/typebox` 0.34.52, and `json-schema-to-typescript` 15.0.4.

### Finding

- `TypeCompiler.Compile(Type.Array(Type.Any(), { uniqueItems: true })).Check([[[[]]], [[], []]])` returned `false`, although the two elements are distinct. The compiled uniqueness check uses hashes without an equality check, and nested array structure can collide.
- Compiling an object with the required literal property `"[k: string]"` emitted `[k: string]: string` instead of a quoted property. The generator uses that spelling as an internal index-signature sentinel.
- Compiling `Type.Never()` directly emitted an open object interface rather than `never`. An executor-controlled `tsType: "never"` override emits the intended declaration.

### Implications

The supported host-function schema subset rejects `uniqueItems: true` and the literal property name `"[k: string]"`. Never declarations require a controlled mapping; caller-supplied `tsType` must not be passed through unchecked. Revisit these exclusions only after verifying dependency behavior again.

### References

- TypeBox compiler and value hash implementations under `@sinclair/typebox/build/esm/`.
- `json-schema-to-typescript/dist/src/parser.js` and `generator.js`.

## 2026-09-12: Schema snapshots, own properties, and conservative records

### Context

Host contracts must remain fixed after construction, and declaration output must not silently change naming or admit code-generation extensions from caller metadata.

### Finding

Focused tests on the versions above verified:

- TypeBox schema symbols must be retained for `TypeCompiler.Compile`; a JSON-only clone loses kind metadata. Cloning plain data descriptors including supported symbols and then freezing the clone preserves compilation and isolates later schema mutations.
- Compiled object validators use inherited-property lookup. Checking a parsed ordinary `{}` against an object requiring `toString: Type.Any()` can see the inherited property. A prototype-free validation view prevents this while the actual handler can receive a separate ordinary JSON snapshot.
- Open patterned records can admit keys outside the pattern. The declaration generator's uniform typed string index signature is too narrow for those keys. Conservative `unknown` index values avoid that declaration overclaim; closed records can retain their value type.
- Caller-provided titles and IDs affect generated naming, and `tsType` can inject a type override. Stripping naming/code-generation annotations, using collision-safe generated names, and escaping `*/` in descriptions produced standalone declarations that passed strict TypeScript 5.9.3 consumer checks.

### Implications

Schema capture, validation, and declaration preparation are distinct steps. The host-function component should retain an explicit supported subset, reject refs/transforms/custom formats, and not expose arbitrary declaration-generator extensions. Runtime numeric bounds and patterns remain stronger than the corresponding TypeScript primitive types.
