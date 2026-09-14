import type { JsonValue, Module } from "./types.js";

/** Internal capabilities survive registry metadata capture without enlarging Module. */
export interface HostBinding {
  readonly id: string;
  readonly acquire: () => () => void;
  readonly assertOpen: () => void;
  readonly invoke: (method: string, input: JsonValue, signal: AbortSignal) => Promise<JsonValue>;
}

const bindings = new WeakMap<Module, HostBinding>();

export function bindHostModule(module: Module, binding: HostBinding): void {
  bindings.set(module, binding);
}

export function copyHostBinding(source: Module, target: Module): void {
  const binding = bindings.get(source);
  if (binding !== undefined) bindings.set(target, binding);
}

export function assertHostModulesOpen(modules: readonly Module[]): void {
  for (const module of modules) bindings.get(module)?.assertOpen();
}

export interface HostOperation {
  readonly bindings: ReadonlyMap<string, HostBinding>;
  readonly release: () => void;
}

/** Acquire synchronously with the snapshot, before any operation can suspend. */
export function acquireHostModules(modules: readonly Module[]): HostOperation {
  const releases: (() => void)[] = [];
  const captured = new Map<string, HostBinding>();
  try {
    for (const module of modules) {
      const binding = bindings.get(module);
      if (binding === undefined || captured.has(binding.id)) continue;
      releases.push(binding.acquire());
      captured.set(binding.id, binding);
    }
  } catch (error) {
    for (const release of releases) release();
    throw error;
  }
  let released = false;
  return {
    bindings: captured,
    release() {
      if (released) return;
      released = true;
      for (const release of releases) release();
    },
  };
}
