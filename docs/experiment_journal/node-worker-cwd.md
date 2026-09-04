# Node Worker Current Directory

> Node Worker threads inherit the process current directory and cannot change it independently.

## Overview

Worker threads share process-level state where Node does not provide per-Worker variants. This matters when a host process runs agents associated with different logical workspace directories.

## 2026-09-03: `process.chdir()` is unavailable in Workers

### Context

The executor's Worker backend was evaluated for supporting a guest working directory distinct from the host process current directory.

### Finding

On Node v24.15.0, a Worker reports the host process directory from `process.cwd()`. Calling `process.chdir("/tmp")` in the Worker throws `TypeError` with code `ERR_WORKER_UNSUPPORTED_OPERATION` and message `process.chdir() is not supported in workers`.

### Implications

A Worker-based executor cannot provide independent native relative-filesystem semantics for multiple agent working directories. A framework must either keep the host process current directory aligned, pass absolute paths to guest code, use a project-specific filesystem abstraction, or choose a child-process backend when a true per-run OS working directory is required.

### References

- [Node.js Worker threads: unavailable process APIs](https://nodejs.org/api/worker_threads.html)
