import type { Module } from "./types.js";

const PACKAGE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function assertPackageSpecifier(specifier: string): void {
  const parts = specifier.split("/");
  const valid = specifier.startsWith("@")
    ? parts.length === 2 && PACKAGE_PART.test(parts[0]?.slice(1) ?? "") && PACKAGE_PART.test(parts[1] ?? "")
    : parts.length === 1 && PACKAGE_PART.test(parts[0] ?? "");

  if (!valid || specifier === "." || specifier === "..") {
    throw new TypeError(`Invalid package module specifier: ${JSON.stringify(specifier)}`);
  }
}

export class ModuleRegistry {
  readonly #modules = new Map<string, Module>();

  register(module: Module): void {
    const specifier = module.specifier;
    const description = module.description;
    const materialize = module.materialize;
    assertPackageSpecifier(specifier);
    if (typeof materialize !== "function") {
      throw new TypeError(`Module ${JSON.stringify(specifier)} has no materialize function`);
    }
    if (this.#modules.has(specifier)) {
      throw new Error(`Module ${JSON.stringify(specifier)} is already registered`);
    }
    const captured: Module = {
      specifier,
      ...(description === undefined ? {} : { description }),
      materialize: materialize.bind(module),
    };
    Object.freeze(captured);
    this.#modules.set(specifier, captured);
  }

  snapshot(): readonly Module[] {
    return Object.freeze([...this.#modules.values()]);
  }
}
