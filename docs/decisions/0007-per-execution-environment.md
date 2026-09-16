# 0007: A request may add environment variables for its own guest

> `ExecutionControl.env` merges extra variables into one guest's environment without touching the host's `process.env`. Adding variables is not the environment filtering the v1 scope excludes.

## Context

A harness that runs one execution per unit of work often needs to tell that
guest which unit it is — a run id, a correlation id, a per-call credential. The
guest inherits the host's environment, which is fixed for the host's lifetime,
so the only routes available were mutating `process.env` around each `execute`
or baking the value into the submitted source. The first races as soon as two
executions overlap, which is exactly the case a concurrent harness has; the
second changes the program's text and therefore its type-check.

Several scope statements said the package provides "no environment filtering"
(`docs/index.md`, `docs/architecture.md`, `docs/components/runtime/index.md`,
the README, and Decision 0006's consequences). Those statements are about
*restricting* what a guest inherits, which remains out of scope: this package
is a lifecycle boundary, not a security boundary, and a guest keeps the host's
full authority. Adding a variable does not restrict anything, so the two are
separate questions that shared one sentence.

## Decision

Add optional `env?: Readonly<Record<string, string>>` to `ExecutionControl`, so
both flavours accept it.

- The child's environment is `process.env`, then the request's `env`, then the
  executor's own variables. A caller may therefore shadow an inherited variable
  for its own guest, and cannot shadow an executor-owned one.
- `RESERVED_ENVIRONMENT_NAMES` (`TSX_TSCONFIG_PATH` and the private restore
  variable) are **rejected by name** in `resolveControl`, not silently dropped:
  the bootstrap reads both to rebuild the caller's original `tsx`
  configuration, so accepting an override would corrupt the guest's module
  resolution in a way the caller could not diagnose. Layering order is belt and
  braces behind the rejection.
- Names must be non-empty and contain neither `=` nor NUL; values must be
  strings without NUL. Validation is synchronous, before any lease, workspace,
  or check, like every other control value.
- The host's `process.env` is never written. Two concurrent executions see only
  their own additions, and nothing persists into a later execution.
- An empty object is equivalent to omitting the field.

## Consequences

- A harness can attribute a guest's actions to the call that spawned it without
  serializing its executions or rewriting submitted source.
- The environment is still additive only. There is no way to hide an inherited
  variable from a guest, so a secret in the host's environment remains visible
  to every program — unchanged, and still not a sandbox.
- The scope statements now say "no environment *filtering*" and point here, so
  the distinction is on the record rather than resting on one word.
