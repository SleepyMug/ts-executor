import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { constants } from "node:fs";
import { assertPackageSpecifier } from "../registry.js";
import type { Module, PackageModuleOptions } from "../types.js";

export function packageModule(options: PackageModuleOptions): Module {
  const specifier = options.specifier;
  const description = options.description;
  assertPackageSpecifier(specifier);
  const packageRoot = resolve(options.root);

  return Object.freeze({
    specifier,
    packageRoot,
    ...(description === undefined ? {} : { description }),
    async materialize() {
      let rootStat;
      try {
        rootStat = await stat(packageRoot);
        await access(resolve(packageRoot, "package.json"), constants.R_OK);
      } catch (error) {
        throw new Error(
          `Package module ${JSON.stringify(specifier)} is not a readable package at ${JSON.stringify(packageRoot)}`,
          { cause: error },
        );
      }
      if (!rootStat.isDirectory()) {
        throw new Error(`Package module root is not a directory: ${JSON.stringify(packageRoot)}`);
      }
      return { packageRoot };
    },
  });
}
