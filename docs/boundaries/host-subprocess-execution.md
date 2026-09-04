# Host-subprocess Execution Boundary

> Common process lifecycle and regular-file output capture carry separate private TSFunc result and Proc status protocols.

## Overview

Each execution owns one mode-`0o700` workspace below `resolutionRoot` and one direct Node subprocess whose native working directory is independently validated `execute.cwd`. There is no shell or message channel. Command arguments carry only executor-owned code and absolute operation paths. Common stdout/stderr files and raw process termination are flavor-neutral; private input/result/status files belong to a specific fixed bootstrap. This is a lifecycle and serialization boundary, not a security boundary.

## Common Host-to-subprocess Contract

The host opens mode-`0o600` regular `stdout.log` and `stderr.log` files and passes their descriptors as child fd 1 and fd 2. It starts one command equivalent to:

```text
process.execPath \
  --import <absolute executor-owned tsx entry> \
  <absolute compiled flavor bootstrap> \
  <absolute flavor operation paths...>
```

No submitted source or JSON value appears in an argument. The host passes normalized request `cwd` to `spawn`. Its environment copies the parent except that preload receives operation `TSX_TSCONFIG_PATH` and one private variable encodes the caller's original present/absent config plus any preexisting private value. Shared bootstrap support restores both before importing guest code.

The neutral host primitive waits for direct-child `exit`, closes its output handles, reads both logs, and returns nullable exit code, nullable signal, stdout, and stderr. It does not read or classify a flavor envelope.

## TSFunc Protocol

Before startup the TSFunc runner strictly validates optional input and writes mode-`0o600` `input.json`:

```ts
type InputEnvelope =
  | { readonly hasInput: false }
  | { readonly hasInput: true; readonly value: JsonValue };
```

It selects `ts-func-subprocess.js` and passes four paths after the bootstrap:

```text
<absolute main.ts>
<absolute input.json>
<absolute result.json>
<absolute result.tmp>
```

The bootstrap parses input, imports `main.ts`, requires callable `main`, and awaits `main(input)`; omission is represented separately and invokes `main(undefined)`. It publishes exactly one terminal envelope:

```ts
type TSFuncResultEnvelope =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly error: SerializedError };
```

Status 0 must pair with valid success. Nonzero status may pair only with valid error. Missing, malformed, partial, or mismatched files are runtime failures. Successful host output is `{ value, stdout, stderr }`; the public executor adds duration.

## Proc Protocol

Proc writes no input file and passes three paths after `proc-subprocess.js`:

```text
<absolute main.ts>
<absolute proc-status.json>
<absolute proc-status.tmp>
```

The bootstrap imports `main.ts`, requires callable `main`, and invokes `main()` with no arguments. Sync and async results are awaited. Only a resolved value exactly equal to `undefined` succeeds; every other value produces a `TypeError` failure status. The private envelope carries status, never successful output:

```ts
type ProcStatusEnvelope =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: SerializedError };
```

Status 0 must pair with `{ ok: true }`; nonzero reported failure must pair with `{ ok: false, error }`. Success returns the exact stdout file contents. Successful stderr is intentionally discarded and never appended/prepended to stdout. Every classified Proc runtime failure throws `ProcExecutionError` containing captured `stdout`, captured `stderr`, exact `exitCode` (`number | null`), and exact `signal` (`NodeJS.Signals | null`). When the envelope reports a guest error, its useful name, message, and stack become the standard properties of that `ProcExecutionError` instance.

## Shared Terminal Publication

Each flavor bootstrap captures stdout/stderr Writable terminal `end` capabilities and `process.exit` before guest import. After its call settles, it:

1. invokes each captured terminal `end` capability once, fully uncorking and flushing prior direct-child writes without guest-shadowable cork counters;
2. writes its complete envelope to the flavor's mode-`0o600` temporary path;
3. atomically renames that same-directory file over the final path; and
4. invokes captured exit with status 0 for success or 1 for a reported error.

A guest-replaced `process.exit` or retained event-loop handle cannot retain a completed direct child. A guest that calls original exit early bypasses publication and causes host-classified failure.

## JSON Data and Error Contracts

`JsonValue` applies only to TSFunc input and successful value:

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

Both TSFunc sides enforce finite numbers, standard-prototype dense arrays with no extras or symbols, acyclic data, enumerable own data properties, and plain object prototypes. BigInt, `undefined`, symbols, functions, accessors, hidden properties, cycles, typed collections, dates, regular expressions, class instances, and other non-plain objects are rejected. Shared acyclic references are repeated as JSON data; identity is not preserved. Parsed envelopes require exact fields.

Both error envelopes use:

```ts
interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}
```

Arbitrary thrown values are manually reduced to safe strings. Class identity and custom properties are not serialized.

## Failure Classification and Ownership

Spawn failure, signal exit, envelope/status mismatch, early exit, and missing, partial, or malformed envelope are runtime failures. TSFunc reconstructs its existing output-bearing `Error`. Proc normalizes every such post-start classification to `ProcExecutionError`; guest name/message/stack are retained when available. Failures before spawn—input, cwd, materialization, or checking—have no runtime output/termination contract, and checked execution throws `TypeCheckError`.

The host owns workspace, direct child, output handles, and final reads. Bootstrap owns publication and direct-child flush ordering. The core removes the workspace in `finally`. Initialization waits for sibling filesystem operations to settle before cleanup; a secondary cleanup failure does not replace a primary error and may appear as best-effort `cleanupError` metadata.

The executor does not kill or await guest-created descendants. Descendant bytes racing direct-child exit may be present or absent and cannot delay the wait. Direct-child bytes completed before bootstrap flush are guaranteed. Guest code can tamper with operation files and cleanup, so this is not adversarial isolation.

## Resolution and cwd

The host requires `cwd` to be an absolute native path string or query- and fragment-free local `file:` URL naming an existing directory. `spawn({ cwd })` gives concurrent children independent native relative-path semantics, including child-local `process.chdir()`.

The imported `main.ts` remains an absolute path below `resolutionRoot`. ESM and checking resolve linked operation packages first, ambient ancestors below `resolutionRoot` next, and linked-package dependencies from each package's real location. Changing `cwd` never redirects that package graph.
