# pnpm Package Management

> Records pnpm 10 behavior that differs from npm in ways the repository's scripts and packaging test depend on.

## Overview

The package is installed, built, tested, and packed with pnpm. pnpm uses an isolated `node_modules` layout, blocks dependency build scripts by default, and exposes a `pack` command whose CLI surface and JSON output differ from npm's. These differences matter for tests that inspect the physical package graph or drive packing from Node.

## 2026-09-15: pack flags, pack JSON shape, non-hoisted transitive packages, and blocked esbuild build

### Context

Migrating the repository from npm to pnpm. Probes used pnpm 10.33.2 (compiled binary, bundled Node v20.11.1) driven from Node v24.15.0 on Linux x64, with `@types/node` 18.19.130 and `tsx` 4.23.13 installed.

### Finding

- `pnpm pack --ignore-scripts` fails with `ERROR  Unknown option: 'ignore-scripts'`; `pack` accepts only its own options. Both `pnpm --config.ignore-scripts=true pack` and the environment variable `npm_config_ignore_scripts=true` skip the `prepack` lifecycle script. Without either, `pnpm pack` and `pnpm pack --dry-run` both run `prepack`.
- `pnpm pack` takes no directory argument; it packs the package at the current working directory. `--pack-destination <dir>` and `--json` work as with npm.
- `pnpm pack --json` prints a single object `{ name, version, filename, files: [{ path }] }`, not npm's one-element array, and `filename` is an absolute path to the tarball rather than a bare file name.
- With the default isolated linker, only direct dependencies appear at the top of `node_modules`. `undici-types`, a transitive dependency of `@types/node`, lives only at `node_modules/.pnpm/undici-types@5.26.5/node_modules/undici-types` and beside `@types/node` inside its `.pnpm` directory. Resolving it through a `createRequire` anchored at the real path of `@types/node/package.json` works under both pnpm and npm layouts.
- Fresh `pnpm install` reports `Ignored build scripts: esbuild@0.28.2`. `tsx` still compiles and runs TypeScript without that script because pnpm installs the `@esbuild/linux-x64` optional package, which is the binary esbuild's `postinstall` would otherwise download. Declaring `pnpm.ignoredBuiltDependencies: ["esbuild"]` in `package.json` silences the warning on a fresh install; an existing `node_modules` keeps reporting the warning until it is recreated.

### Implications

The packaging test drives `pnpm pack` from the repository root with `--config.ignore-scripts=true`, reads the object-shaped JSON, and resolves `@types/node` and `undici-types` through Node resolution instead of fixed `node_modules` paths. Executor code already resolves `tsx` with `require.resolve` and reads `@types` only from direct-dependency locations, so no runtime change was needed. Any future test that reaches into `node_modules` for a transitive package must resolve it the same way.

### References

- pnpm `pack` options: https://pnpm.io/cli/pack
- pnpm build-script approval settings: https://pnpm.io/settings#ignoredbuiltdependencies
