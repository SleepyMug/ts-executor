# Node Child-process File Execution

> Records plain `spawn()` startup, regular-file output, atomic result, environment, reaping, and type-check subprocess behavior used by the subprocess backend.

## Overview

A plain Node subprocess can provide a per-execution working directory without an IPC channel. These probes cover the file and lifecycle primitives used by the executor and deliberately make no claim beyond the runtime and platform actually tested.

## 2026-09-03: Plain spawn, TSX preload, file capture, atomic rename, and reaping work on Linux

### Context

The executor needs to start a TypeScript-export bootstrap with `spawn(process.execPath, ["--import", absoluteTsx, bootstrap, ...])`, give concurrent runs independent working directories, restore the caller-visible `TSX_TSCONFIG_PATH` after preload, capture output without pipe EOF dependence, publish one result atomically, and reap a direct child that retains handles.

### Finding

A probe on Node v24.15.0, Linux x64, with `tsx` 4.23.13 successfully ran two concurrent children using an absolute string `cwd` and a `file:` URL `cwd`. Both imported an absolute `.ts` entrypoint through the absolute `tsx` loader, observed their distinct working directories, and saw the restored caller value of `TSX_TSCONFIG_PATH` rather than the operation config used for preload.

Each child wrote 131,072 Greek characters to each stream (262,144 UTF-8 bytes per stream), flushed direct-child stdout/stderr with write callbacks, wrote a mode-`0o600` temporary JSON result, renamed it to the destination, and called a bootstrap-captured `process.exit`. Both direct children exited with status 0 in under 100 ms despite retained intervals, and `process.kill(pid, 0)` then reported `ESRCH`. The temporary result paths were absent after rename.

Stdout and stderr were regular files opened by the parent and passed as fd 1 and fd 2. A finite descendant inherited those descriptors and wrote after the direct child exited: the parent could close its own handles and read immediately without waiting for descendant EOF; the later descendant bytes appeared only in a later read. This confirms the intended direct-child output guarantee and the documented race for descendant output on this environment.

### Implications

The implementation can use plain `spawn`, absolute operation paths, regular-file descriptors, callback-based direct-child stream flushing, same-directory temporary-file rename, and direct-child `exit` as its sole lifecycle wait on the tested environment. Current-state docs and tests must identify Node v24.15.0 on Linux x64 as the verified environment; they must not claim the untested Node-major, Windows, or macOS matrix. Descendant output remains intentionally outside the guaranteed capture boundary.

### References

- [Node.js `child_process.spawn()`](https://nodejs.org/api/child_process.html#child_processspawncommand-args-options)
- [Node.js file-system rename](https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath)
- [`tsx` Node.js usage](https://tsx.is/node-enhancement)

## 2026-09-03: A corked process stream must be uncorked before the flush sentinel

### Context

A submitted program can call `process.stdout.cork()` and settle without uncorking it. The bootstrap still needs to publish its result and force direct-child completion rather than waiting indefinitely for the flush callback.

### Finding

On Node v24.15.0, Linux x64, a callback for an empty write remains behind previously corked writes until the stream is uncorked. Capturing each stream's `uncork` and `write` functions before guest import, uncorking until `writableCorked` reaches zero, and then issuing the empty callback write flushes the queued bytes and allows deterministic completion. An end-to-end regression returned the exact corked output and JSON result while a retained-handle timeout remained active.

### Implications

The subprocess bootstrap must actively uncork stdout and stderr before its callback-based flush. Merely writing an empty chunk is insufficient when guest code leaves a stream corked. Ended or destroyed streams remain execution failures rather than successful output captures.

### References

- [Node.js writable stream corking](https://nodejs.org/api/stream.html#writablecork)

## 2026-09-04: Writable end fully uncorks despite shadowed public cork counters

### Context

The prior callback-write flush used the guest-visible `writableCorked` property to decide how often to uncork. An own property can shadow that inherited accessor with either a false positive, causing an unbounded synchronous loop, or a false zero after a real `cork()`, leaving the callback write queued indefinitely.

### Finding

On Node v24.15.0, Linux x64, calling a pre-bound `Writable.end` once on stdout backed by a regular file completed and preserved output in both probes: an uncorked stream with an own positive `writableCorked` value, and a genuinely corked stream with an own zero value. The end callback received no error, and the expected bytes were present in each file. Node's Writable implementation uses its private writable state for terminal ending and fully uncorks as part of `end()`, rather than consulting the shadowable public accessor.

### Implications

A bootstrap can terminally flush these private execution streams with one captured `end` call per stream, avoiding both a guest-visible cork counter and any unbounded uncork loop. This is appropriate here because fd 1 and fd 2 name operation-private regular files and the direct process exits immediately after result publication. The observation is limited to the tested runtime and the cork-counter shadow cases; it does not turn the subprocess into an adversarial sandbox.

### References

- [Node.js `writable.end()`](https://nodejs.org/api/stream.html#writableendchunk-encoding-callback)

## 2026-09-14: Forced console colors survive regular-file stdout capture

### Context

An example that expected exact numeric stdout passed without color settings but failed when launched with `FORCE_COLOR=1`. The child inherits the host environment even though its stdout descriptor is a regular file rather than a terminal.

### Finding

On Node v24.15.0, Linux x64, `console.log(5)` under `FORCE_COLOR=1` emitted `"\u001b[33m5\u001b[39m\n"` into the captured stdout file. The numeric value is formatted through console inspection, which honors forced colors despite non-TTY output. `process.stdout.write(String(5) + "\n")` instead emitted exactly `"5\n"`. Human-readable object and numeric logs in the parent process were colored as well.

### Implications

Do not strip colors in the executor or override the inherited environment to make an example's assertion pass: exact capture must preserve what guest code emits. Programs requiring deterministic text should write explicitly formatted strings. Tests of human-readable example logs can normalize ANSI presentation separately and exercise both `FORCE_COLOR=0` and `FORCE_COLOR=1`.

### References

- [Node.js FORCE_COLOR environment variable](https://nodejs.org/api/cli.html#force_color1-2-3)
- [Node.js console](https://nodejs.org/api/console.html)

## 2026-09-16: Pipe capture drains completely after direct-child exit, and group kill reaches descendants

### Context

Decision 0006 replaces regular-file capture with host-owned pipes so retained output can be bounded, while keeping direct-child `exit` as the only lifecycle wait. Two behaviours needed verification on Node v24.15.0, Linux x64: that every byte the direct child wrote before exiting is readable by the host after `exit` even when the host event loop was blocked, and that `process.kill(-pid, signal)` on a `detached` child reaches guest-created descendants.

### Finding

A child wrote 300 KiB to a pipe-backed `process.stdout`, spawned a detached descendant that inherited the pipe and would write 300 ms later, then ended stdout and exited. The parent drained `data` events into a 100 KiB cap and, in its `exit` handler, blocked the event loop synchronously for 200 ms before scheduling two `setImmediate` turns and destroying the pipes. All 307 200 bytes were received (102 400 retained, `truncated` true) about 220 ms after exit, and the descendant's later bytes never arrived. A separate probe with a SIGTERM-ignoring child that spawned `sleep 300`: `process.kill(-pid, "SIGTERM")` killed the sleeper but not the child; `process.kill(-pid, "SIGKILL")` killed the child, which the parent reaped with `signal: "SIGKILL"`.

Also observed while testing: a guest whose only pending work is an unresolved promise exits with code 0 immediately (Node's loop has nothing to wait on), so a hung-program fixture must hold a handle such as an interval or a child process. The `tsx` entry resolved by `require.resolve("tsx")` is `dist/loader.mjs`, loaded in-process by `--import`; no wrapper process exists, so the direct child is the guest.

### Implications

- Waiting for `exit` plus one further poll phase (two `setImmediate` turns) recovers every direct-child byte without waiting for pipe EOF, so descendants cannot delay completion.
- SIGTERM followed by SIGKILL to the group is sufficient to terminate a guest that ignores SIGTERM together with its ordinary descendants.
- Tests of cancellation must keep the guest alive with a real handle.

### References

- Probe scripts: `/tmp/tsx-probe/parent.mjs`, `/tmp/tsx-probe/child.mjs`, `/tmp/tsx-probe/kill.mjs` (not retained).
- Implementation: `src/runtime/run-subprocess.ts`; tests: `test/cancellation.test.js`, `test/output-limits.test.js`.

## 2026-09-24: Type-checking in a child process: cost, termination, and out-of-memory

### Context

A review found that `checkWorkspace` ran TypeScript synchronously in the caller's process, so an expensive type blocked the caller's event loop or exhausted its heap. Moving the check into its own Node subprocess needed three facts on Node v24.15.0, Linux x64, TypeScript 5.9.3: what an expensive type does, whether a busy check child dies promptly on SIGTERM, and what the move costs per check.

### Finding

- A program whose return type is a permutation of 9 union members (`type Permutation<T, U = T> = [T] extends [never] ? [] : T extends U ? [T, ...Permutation<Exclude<U, T>>] : never`) ran the checker for about 12 s and then ended the process with V8's "JavaScript heap out of memory" fatal error at about 4 GB (SIGABRT, shell status 134). 8 members took 3.5 s and produced an ordinary TS2322 diagnostic; 7 took 0.6 s.
- With `NODE_OPTIONS=--max-old-space-size=128` inherited by the check child, the 9-member check died with signal SIGABRT after about 0.7 s and published nothing. A trivial check succeeds with 64 MB.
- SIGTERM to the group of a check child busy in the checker ended it at once: Node installs no SIGTERM handler, so the default disposition applies even during synchronous JavaScript.
- A trivial check through a child took about 385 ms end to end (Node start, loading `typescript.js`, parsing `lib.es2022.d.ts` and `@types/node`, all cold). The same check in a warm process took about 120 ms (220 ms the first time, plus about 110 ms to load TypeScript). With `NODE_COMPILE_CACHE` set, the child took about 325 ms.
- TypeScript is CommonJS: imported from ESM it still appears in `require.cache`, which is how a test shows the caller never loaded it.

### Implications

- A check in a child process can be killed by the same SIGTERM-then-SIGKILL group termination as a guest, and SIGTERM suffices. A check that runs out of memory then kills only its child.
- Each check would cost about a quarter of a second more than a warm in-process check.
- Outcome: a type-check subprocess was built on these facts during the 0.4.0 review and then removed when the trust model was set ([Decision 0008](../decisions/0008-one-executor-callers-own-limits-host-modules-carry-declarations.md)). Checking runs in the caller's process, so an expensive type blocks or exhausts the caller; that is left to the environment.

### References

- [Node.js module compile cache](https://nodejs.org/api/module.html#module-compile-cache)

## 2026-09-24: Enabling the compile cache from the type-check bootstrap

### Context

The type-check subprocess pays a cold TypeScript load on every check (entry above). Node 22.1+ can cache compiled code on disk via `module.enableCompileCache(directory)`, which must run before the cached module loads. Node v24.15.0, Linux x64.

### Finding

The check bootstrap calls `module.enableCompileCache("<resolutionRoot>/.ts-executor/compile-cache")` and then imports the TypeScript-loading module dynamically. For a trivial program, the first check under a new resolution root took about 400 ms and later ones about 325 ms, against about 385 ms each without the cache. The cache is written even though the bootstrap ends with `process.exit`. It held about 3 MB, mostly for `typescript.js`.

### Implications

A retained directory under `.ts-executor/` saved about 60 ms per check. Node keys the cache by content and version, so it needs no cleanup, and the check result did not depend on it. Outcome: removed with the type-check subprocess; an in-process check loads TypeScript once per caller process.

### References

- [Node.js module compile cache](https://nodejs.org/api/module.html#module-compile-cache)
