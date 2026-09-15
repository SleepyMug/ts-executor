# 0006: Cancellation and Bounded Output

> Executions accept a signal, a wall-clock deadline, and a per-stream retention cap; the guest process group is terminated on abort or timeout, and output is captured through pipes into bounded buffers.

## Context

An agent harness runs model-written programs. A program whose `main` never settles previously hung the harness's tool call and everything serialized behind it, and a program that printed tens of megabytes produced a tool result of the same size. The executor offered no cancellation, no deadline, and captured stdout/stderr into regular files that grew without bound.

[Decision 0002](0002-subprocess-json-execution.md) chose regular files over pipes so that direct-child `exit` is the only lifecycle wait: descendants inheriting a pipe delay its EOF. Bounding capture at the source, however, requires the host to own the sink; a file the child appends to cannot be capped by the parent.

## Decision

- `TSFuncExecuteRequest` and `ProcExecuteRequest` gain `signal?: AbortSignal`, `timeoutMs?: number`, `maxOutputBytes?: number` (default `DEFAULT_MAX_OUTPUT_BYTES`, 4 MiB per stream), and `killGraceMs?: number` (default `DEFAULT_KILL_GRACE_MS`, 2 s). Values are validated synchronously before any work.
- The guest is spawned in its own process group (`detached`, POSIX). On abort or deadline the host sends SIGTERM to the group, SIGKILL after the grace period, waits for the direct child's exit, and rejects with `ExecutionAbortedError { reason: "signal" | "timeout", stdout, stderr, truncated, exitCode, signal, durationMs }`. A normal completion never kills descendants; the group is killed only on abort or timeout.
- The deadline clock starts when `execute` is called and covers checking. Checking is synchronous and cannot be interrupted, so a signal or deadline is honoured before checking and again immediately before spawning; during execution a timer or the signal terminates the group. A pre-aborted signal rejects before any lease, workspace, or check.
- Capture uses pipes drained into bounded buffers. The host still waits only for the direct child's `exit`, never for pipe EOF; after exit it runs one more event-loop poll phase (two `setImmediate` turns) to read bytes the child wrote before exiting, then destroys the pipes. Descendants still holding the pipe receive EPIPE afterwards. The regular-file capture and its `stdout.log`/`stderr.log` workspace entries are removed.
- Bytes beyond `maxOutputBytes` are read and discarded so the guest is never blocked; `truncated: { stdout, stderr }` is reported on `TSFuncExecuteResult`, on TSFunc runtime errors, on `ProcExecutionError`, and on `ExecutionAbortedError`.
- `ProcExecutor.execute` keeps returning exact stdout. When stdout was truncated the exact string does not exist, so `execute` rejects with `ProcExecutionError` (`truncated.stdout` true, `exitCode` 0) instead of returning a silently incomplete value. New `ProcExecutor.executeDetailed` returns `{ stdout, truncated, durationMs }` and never rejects merely because output was capped. `ProcExecutionError`'s constructor now takes a details object.
- `getInstructions(options?)` states the effective output cap and, when the harness supplies `timeoutMs`, the deadline, so the model plans around the same limits the harness enforces.

## Alternatives Considered

- Keep regular files and cap only at read-back — rejected: memory would be bounded but disk would not, and a runaway guest could fill the filesystem until its deadline.
- Keep regular files and kill the guest when the file exceeds a size — rejected: turns verbose-but-correct programs into failures and can only bound disk within one polling interval.
- Cap output inside the bootstrap by wrapping `process.stdout.write` — rejected: `fs.writeSync(1, …)` and descendants bypass it.
- Race `execute` against a timeout promise — rejected: leaves the guest and its descendants running and the workspace allocated.
- A `Promise<{ stdout, truncated }>` return from `ProcExecutor.execute` — rejected as a silent breaking change for every caller; `executeDetailed` adds the richer result beside the exact-stdout contract.

## Consequences

- Harnesses can forward a per-call `AbortSignal` and a deadline; a hung program no longer blocks the caller, and killed programs report the output captured so far.
- Memory per execution is bounded by `2 × maxOutputBytes`; no output files are written.
- Direct-child output remains complete: bytes the child wrote before exiting are in the kernel pipe buffer when `exit` is observed and are read in the following poll phase. Descendant output racing exit was never guaranteed and remains so; descendants writing after the host closes the pipe get EPIPE.
- Node's synchronous pipe writes on Linux mean a guest blocks while the host is not draining, for example during another execution's synchronous type-check in the same host process. This slows the guest; it cannot deadlock because the host always resumes draining.
- Process-group termination is POSIX behaviour; on Windows only the direct child is killed.
- The library still provides no security boundary, environment filtering, or resource limits beyond output retention.
