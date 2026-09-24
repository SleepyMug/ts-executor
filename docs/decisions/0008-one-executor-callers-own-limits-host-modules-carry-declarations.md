# 0008: One Executor, Caller-owned Limits, Declaration-carrying Host Modules

> `ProcExecutor`, built-in deadlines and output caps, and schema-backed host functions are removed. `TSFuncExecutor` is the only executor; the host is trusted and the program is not contained; callers abort a signal, consume output through sinks, and give host modules their declarations text and one `call` function.

## Status

Accepted (2026-09-24), version 0.4.0. Supersedes [Decision 0003](0003-composed-executor-flavors.md), [Decision 0006](0006-cancellation-and-bounded-output.md) including its 0.2.1 amendment, and the schema-backed `hostFunction` part of [Decision 0005](0005-reusable-host-backed-modules.md). Amended the same day, before release: the trust model is stated, and three abort-timing fixes from a lifecycle review are part of the decision.

## Context

- **The library owned policy its callers know better.** 0.3.0 had `timeoutMs`, `maxOutputBytes`, `killGraceMs`, `killGroupOnExit`, default caps, and a `getInstructions(options)` that restated them. The primary consumer, fyona's box daemon, enforces its own deadline and output caps and states them to its model itself. Two layers of limits meant two sets of numbers, errors and instructions to keep in step.
- **Retained output was the library's only reason for a second flavor.** `ProcExecutor` existed because success was "exact captured stdout", and bounded capture then forced `executeDetailed`, `ProcExecutionError`, and truncation flags on every result and error. Once the executor keeps no output, a stdout program is just a JSON function that prints and returns nothing (resolved as `null`), and the caller receives stdout through `onStdout`.
- **Generated declarations were poor.** `hostFunction` turned TypeBox schemas into `index.d.ts` with json-schema-to-typescript. Every type came out anonymous and inlined, with hex-suffixed names; references and recursion were rejected ([schema-tooling journal](../experiment_journal/json-schema-tooling.md)). A program's author learns a module from its declarations, so their quality is the product. Callers that already have good declarations, or derive them from their own schemas, had no way to supply them.
- **The executor validated what the caller must validate anyway.** Host calls cross into caller code that has its own contract; schema checks in the executor duplicated them and tied the package to TypeBox 0.34 and a declaration generator.
- **Review rounds on the draft of this version built defenses against hostile programs** (added by the amendment). They type-checked in a subprocess, bounded the result file, replaced Node IPC with the executor's own framing, and capped host-call messages, concurrent calls, unread replies, and diagnostics. Each defense was sound, but each added mechanism, API, and failure modes. Resource use is to be monitored outside the executor.

## Decision

- **Trust model** (amendment). The caller and its host-module `call` functions are trusted. The program is untrusted for correctness: every value crossing from it (result, error, host-call request) is strictly validated, and its failures are reported, never believed. It is not contained. The executor has no budgets, rate or concurrency limits, size caps, or mechanisms whose only purpose is to survive a hostile program. Resource limits belong to the caller and to the environment the executor runs in.
- **One executor.** Remove `ProcExecutor`, its bootstrap, status envelope, `executeDetailed`, `ProcExecutionError`, and the internal `ExecutorCore`, which merges into `TSFuncExecutor`. There is one subprocess runner and one bootstrap.
- **Caller-owned limits.** `ExecutionControl` is `{ signal?, env?, onStdout?, onStderr? }`.
  - Deadlines: the caller aborts `signal`, e.g. `AbortSignal.any([signal, AbortSignal.timeout(ms)])`. Abort terminates the whole process group (SIGTERM, then SIGKILL after a fixed 2 s grace) and rejects with `ExecutionAbortedError`, which carries only `durationMs`.
  - Abort timing (amendment):
    - On abort, or when a sink throws, the host-call bridge is closed before the group is signalled, so running host calls see their `signal` abort and no guest request is dispatched during the grace period.
    - The signal is checked immediately before spawning, after the synchronous type-check and the input file, so an abort during preparation starts no guest.
    - Only an abort before the guest's exit is observed counts; a later one leaves its result intact.
  - Output: stdout/stderr are delivered as UTF-8 text to the sinks as written, with multibyte characters kept whole. Nothing is retained. A stream without a sink is not piped. A sink that throws aborts the execution, which rejects with that error.
  - Reaping: after the guest exits, whatever remains of its process group is always SIGKILLed.
  - `TSFuncExecuteResult` is `{ value, durationMs }`; guest errors are the deserialized guest error without output decoration.
  - `getInstructions()` takes no options and states no limits.
- **Host modules carry declarations.** `hostModule({ resolutionRoot, specifier, description?, declarations, functions, call })`:
  - `declarations` is written verbatim as `index.d.ts`; `functions` lists the exported names.
  - Each generated function forwards its arguments as a JSON array to `call(fn, args, { signal })` in the host. Trailing `undefined` arguments are dropped; any other `undefined` rejects the call in the guest.
  - The host rejects unknown names and non-array inputs. Beyond that there is no validation, only strict JSON encoding in both directions.
  - Remove `hostFunction`, the `Type` re-export, and the `@sinclair/typebox` and `json-schema-to-typescript` dependencies.
- Generated-package lifecycle, leases, disposal, and the execution-scoped IPC protocol are unchanged.

## Alternatives Considered

- Keep the built-in limits as optional defaults — rejected: two sources of limits still diverge, and the library cannot know the caller's budget or how to report it to a model.
- Keep bounded retention beside the sinks — rejected: a sink is the general mechanism; a caller that wants a bounded buffer writes one (the [harness adapter example](../../examples/harness-adapter.mjs) does).
- Keep `ProcExecutor` as a thin wrapper over sinks — rejected: it would restate the same execution with a different return type; the stdout-program pattern is three lines of caller code.
- Improve the schema-to-declarations generator — rejected: a better generator still limits callers to one schema dialect; accepting text lets each caller generate, derive, or hand-write declarations.
- Validate host calls against caller-supplied JSON Schema — rejected: validation belongs where the contract is defined, in the caller's `call`.
- Defend the caller against a hostile program — built during review, then removed (amendment). The defenses were: type-checking in a killable subprocess, a `maxResultBytes` option with a hardened result read, the executor's own framing on a plain fd-3 pipe instead of Node IPC, and fixed bounds on host-call message size, concurrent calls, unread replies, and diagnostics. Rejected because under the trust model they only defend against a program attacking the executor, which is not this layer's job, and each carried API, code, and failure modes. The measurements that motivated them are in the [child-process](../experiment_journal/node-child-process-files.md#2026-09-24-type-checking-in-a-child-process-cost-termination-and-out-of-memory) and [IPC](../experiment_journal/node-child-process-ipc.md#2026-09-24-a-child-can-crash-its-parent-through-nodes-json-ipc-a-plain-fd-3-pipe-cannot) journals.

## Consequences

- Breaking changes in 0.4.0: `ProcExecutor`, `ProcExecutionError`, `executeDetailed`, `ProcExecuteRequest`/`ProcExecuteResult`, `CapturedTermination`, `hostFunction`, `Type`, `DEFAULT_MAX_OUTPUT_BYTES`, `DEFAULT_KILL_GRACE_MS`, `AbortReason`, `OutputTruncation`, and `InstructionsOptions` are removed, as are the `timeoutMs`, `maxOutputBytes`, `killGraceMs`, and `killGroupOnExit` request fields, `stdout`/`stderr`/`truncated` on results and errors, and `reason`/output fields on `ExecutionAbortedError`. `hostModule` takes new options.
- A `main` that returns nothing resolves to `null`, so a stdout-style program only prints.
- Options of 0.3 that are now the caller's (`timeoutMs`, `maxOutputBytes`, `killGraceMs`, `killGroupOnExit`) throw when passed, so a caller that still relies on them learns it instead of silently losing a deadline.
- A caller that wants a deadline, an output cap, or model-facing limit text builds it; the harness adapter example shows all three. An `ExecutionAbortedError` no longer says whether a deadline or another abort fired: the caller knows which of its signals aborted.
- Memory per execution no longer depends on output size inside the library. A slow sink slows the guest, since pipe writes are synchronous on Linux.
- Background processes a program starts always end with it; a caller that needs a long-lived helper must start it outside the guest or move it to its own session.
- Host-module declarations can be as good as the caller makes them — named types, JSDoc, recursion — but nothing checks them against `call`. A wrong declaration misleads the type-check, and `call` must validate its own arguments.
- The package drops two runtime dependencies and the supported-schema-subset rules.
- Known costs of the trust model, for the environment to cover (amendment):
  - A type that is expensive to check blocks the caller's event loop for as long as it takes, and can exhaust the caller's heap, because checking runs in the caller's process. The caller's deadline cannot interrupt it; it takes effect before the guest would spawn.
  - A result or host-call message is read and validated whole, in time linear in its size.
  - A guest that writes raw bytes to its IPC descriptor can crash the caller, because Node parses IPC lines inside the host.
  - A guest can make as many concurrent host calls as it likes.
  - A `main` that awaits a promise nothing resolves stays alive until the caller's deadline when the program has host modules, because the IPC channel keeps its event loop alive.
