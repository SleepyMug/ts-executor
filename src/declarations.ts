import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { compilerOptions } from "./compiler-options.js";
import type { DeclarationTree } from "./types.js";
import type { PreparedWorkspace } from "./workspace.js";

const DECLARATION_EXTENSION = /\.d\.(?:ts|mts|cts)$/u;

function isPackageOwned(packageRoot: string, file: string): boolean {
  const path = relative(packageRoot, file);
  const outside = path === ".." || path.startsWith(`..${sep}`);
  return path !== "" && !outside && !isAbsolute(path) && path.split(/[\\/]/u)[0] !== "node_modules";
}

function resolveImport(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
  mode: ts.ResolutionMode,
): string | undefined {
  return ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    ts.sys,
    undefined,
    undefined,
    mode,
  ).resolvedModule?.resolvedFileName;
}

function moduleUsages(
  source: string,
  file: string,
  options: ts.CompilerOptions,
): readonly { readonly specifier: string; readonly mode: ts.ResolutionMode }[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    {
      languageVersion: ts.ScriptTarget.Latest,
      impliedNodeFormat: ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options),
    },
    true,
  );
  const usages: Array<{ readonly specifier: string; readonly mode: ts.ResolutionMode }> = [];
  const add = (literal: ts.StringLiteralLike): void => {
    usages.push({
      specifier: literal.text,
      mode: ts.getModeForUsageLocation(sourceFile, literal, options),
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier);
      return;
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression);
      return;
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      add(node.argument.literal);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return usages;
}

async function canonicalDeclaration(
  candidate: string | undefined,
  packageRoot: string,
): Promise<string | undefined> {
  if (candidate === undefined || !DECLARATION_EXTENSION.test(candidate)) return undefined;
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    return undefined;
  }
  return isPackageOwned(packageRoot, canonical) ? canonical : undefined;
}

export async function declarationTree(
  workspace: PreparedWorkspace,
  requestedSpecifier: string,
  ownerSpecifier: string,
): Promise<DeclarationTree> {
  const packageRootInput = workspace.packageRoots.get(ownerSpecifier);
  if (packageRootInput === undefined) {
    throw new Error(`Registered module ${JSON.stringify(ownerSpecifier)} was not materialized`);
  }
  const packageRoot = await realpath(packageRootInput);
  const options = compilerOptions(workspace.root);
  const resolved = resolveImport(
    requestedSpecifier,
    workspace.entrypoint,
    options,
    ts.ModuleKind.ESNext,
  );
  const entry = await canonicalDeclaration(resolved, packageRoot);
  if (entry === undefined) {
    throw new Error(
      `No package-owned TypeScript declaration entrypoint was found for ${JSON.stringify(requestedSpecifier)}`,
    );
  }

  const queue = [entry];
  const seen = new Set<string>();
  const files: Record<string, string> = {};
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    const key = relative(packageRoot, file).replaceAll("\\", "/");
    files[key] = source;

    const information = ts.preProcessFile(source, true, true);
    for (const usage of moduleUsages(source, file, options)) {
      const next = await canonicalDeclaration(
        resolveImport(usage.specifier, file, options, usage.mode),
        packageRoot,
      );
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
    for (const referenced of information.referencedFiles) {
      const next = await canonicalDeclaration(resolve(dirname(file), referenced.fileName), packageRoot);
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
    for (const typeReference of information.typeReferenceDirectives) {
      const resolution = ts.resolveTypeReferenceDirective(
        typeReference.fileName,
        file,
        options,
        ts.sys,
      ).resolvedTypeReferenceDirective?.resolvedFileName;
      const next = await canonicalDeclaration(resolution, packageRoot);
      if (next !== undefined && !seen.has(next)) queue.push(next);
    }
  }

  return Object.freeze({
    entrypoint: relative(packageRoot, entry).replaceAll("\\", "/"),
    files: Object.freeze(files),
  });
}
