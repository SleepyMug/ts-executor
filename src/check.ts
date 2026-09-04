import { relative } from "node:path";
import ts from "typescript";
import { compilerOptions } from "./compiler-options.js";
import type { CheckResult, Diagnostic, DiagnosticCategory } from "./types.js";
import type { PreparedWorkspace } from "./workspace.js";

function category(value: ts.DiagnosticCategory): DiagnosticCategory {
  switch (value) {
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
  }
}

function formatDiagnostic(workspace: PreparedWorkspace, value: ts.Diagnostic): Diagnostic {
  const base = {
    category: category(value.category),
    code: value.code,
    message: ts.flattenDiagnosticMessageText(value.messageText, "\n"),
  };
  if (value.file === undefined || value.start === undefined) return Object.freeze(base);
  const position = value.file.getLineAndCharacterOfPosition(value.start);
  return Object.freeze({
    ...base,
    file: relative(workspace.root, value.file.fileName).replaceAll("\\", "/"),
    line: position.line + 1,
    column: position.character + 1,
  });
}

export function checkWorkspace(workspace: PreparedWorkspace): CheckResult {
  const program = ts.createProgram({
    rootNames: [workspace.entrypoint],
    options: compilerOptions(workspace.root),
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((value) => formatDiagnostic(workspace, value));
  return Object.freeze({
    ok: diagnostics.every((value) => value.category !== "error"),
    diagnostics: Object.freeze(diagnostics),
  });
}
