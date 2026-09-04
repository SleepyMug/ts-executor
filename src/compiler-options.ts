import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const bundledTypeRoot = dirname(dirname(require.resolve("@types/node/package.json")));

export const runtimeCompilerOptions = Object.freeze({
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  moduleDetection: "force",
  strict: true,
  skipLibCheck: true,
  types: ["node"],
});

export function compilerOptions(workspaceRoot: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
    types: ["node"],
    typeRoots: [
      resolve(workspaceRoot, "node_modules", "@types"),
      resolve(dirname(workspaceRoot), "node_modules", "@types"),
      bundledTypeRoot,
    ],
  };
}
