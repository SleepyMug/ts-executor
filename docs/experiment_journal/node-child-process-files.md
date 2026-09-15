# Node Child-process File Execution

> Records plain `spawn()` startup, regular-file output, atomic result, environment, and reaping behavior used by the subprocess backend.

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
