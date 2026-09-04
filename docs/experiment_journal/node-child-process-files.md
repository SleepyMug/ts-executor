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
