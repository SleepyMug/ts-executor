import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachCleanupError } from "../errors.js";
import { bindHostModule, type HostBinding } from "../host-bindings.js";
import { assertPackageSpecifier } from "../registry.js";
import { resolveResolutionRoot, storageDirectory } from "../storage.js";
import type { JsonValue, Module } from "../types.js";

export interface HostCallContext {
  /**
   * Aborted when the calling execution ends (it settled or its channel closed), and at once
   * when the caller aborts it, before its guest is terminated.
   */
  readonly signal: AbortSignal;
}

/** Runs in the executor's process for every call a guest makes to a host module function. */
export type HostCall = (
  fn: string,
  args: readonly JsonValue[],
  context: HostCallContext,
) => JsonValue | Promise<JsonValue>;

export interface HostModuleOptions {
  /** Storage base for generated packages; normally the executor's resolutionRoot. */
  readonly resolutionRoot: string | URL;
  readonly specifier: string;
  readonly description?: string;
  /**
   * The package's `index.d.ts`, written as given: what guests are type-checked
   * against. It should declare each function in `functions` and nothing else that
   * is runtime-visible; its accuracy is the caller's responsibility.
   */
  readonly declarations: string;
  /** Exported function names. Each forwards its arguments, as a JSON array, to `call`. */
  readonly functions: readonly string[];
  /**
   * Handles every call. Its result, or its error's name and message, is returned to
   * the guest; a result that is not strict JSON rejects the guest's call instead.
   */
  readonly call: HostCall;
}

export interface HostModule extends Module {
  /** Stop new operations, await existing operations, then remove owned artifacts. */
  dispose(): Promise<void>;
}

const clientUrl = new URL("../runtime/host-client.js", import.meta.url).href;
const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
// Strict-mode and module reserved bindings, not just parser keywords.
const reservedNames = new Set([
  "arguments", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "eval", "export", "extends",
  "false", "finally", "for", "function", "if", "implements", "import", "in",
  "instanceof", "interface", "let", "new", "null", "package", "private", "protected",
  "public", "return", "static", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield",
]);

function functionNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError("Host module functions must be an array of names");
  const names = [...value];
  for (const name of names) {
    if (typeof name !== "string" || !identifier.test(name) || reservedNames.has(name)) {
      throw new TypeError(`Host function name ${JSON.stringify(name)} must be a non-reserved identifier`);
    }
    // An exported then makes dynamic import treat the module namespace as a thenable.
    if (name === "then") throw new TypeError('Host function name "then" is reserved for ESM interoperability');
  }
  if (new Set(names).size !== names.length) throw new TypeError("Host function names must be distinct");
  return Object.freeze(names);
}

/**
 * The generated JavaScript: every function forwards its arguments. Trailing
 * `undefined` arguments are dropped, so omitting an optional argument and passing
 * `undefined` for it are the same call; any other `undefined` is not JSON and
 * rejects the call in the guest.
 */
function moduleSource(id: string, names: readonly string[]): string {
  const forwarders = names.map((name, index) =>
    `function fn${index}(...args) { return forward(${JSON.stringify(name)}, args); }\nexport { fn${index} as ${name} };`,
  );
  return [
    `import { callHost } from ${JSON.stringify(clientUrl)};`,
    `function forward(name, args) {`,
    `  let length = args.length;`,
    `  while (length > 0 && args[length - 1] === undefined) length -= 1;`,
    `  args.length = length;`,
    `  return callHost(${JSON.stringify(id)}, name, args);`,
    `}`,
    ...forwarders,
    "",
  ].join("\n");
}

/** Generate once. Reuse this handle across checks, executions, and executors. */
export async function hostModule(options: HostModuleOptions): Promise<HostModule> {
  const { specifier, description, declarations, call } = options;
  const resolutionRoot = resolveResolutionRoot(options.resolutionRoot, "hostModule");
  assertPackageSpecifier(specifier);
  if (description !== undefined && typeof description !== "string") {
    throw new TypeError("Host module description must be a string");
  }
  if (typeof declarations !== "string") throw new TypeError("Host module declarations must be a string");
  if (typeof call !== "function") throw new TypeError("Host module call must be a function");
  // Everything is captured before the first await.
  const names = functionNames(options.functions);
  const known = new Set(names);
  const id = randomUUID();
  const directory = await storageDirectory(resolutionRoot, "modules");
  const packageRoot = await mkdtemp(join(directory, "module-"));
  try {
    await chmod(packageRoot, 0o700);
    // Sequential writes prevent a failed write racing directory cleanup.
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: specifier,
      private: true,
      type: "module",
      types: "./index.d.ts",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(packageRoot, "index.d.ts"), declarations, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(packageRoot, "index.js"), moduleSource(id, names), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    try {
      await rm(packageRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }

  let closing = false;
  let leases = 0;
  let onIdle: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  function assertOpen(): void {
    if (closing) throw new Error(`Host module ${JSON.stringify(specifier)} is disposed or disposing`);
  }
  const module: HostModule = Object.freeze({
    specifier,
    packageRoot,
    ...(description === undefined ? {} : { description }),
    async materialize() {
      // Core acquires a lease before awaiting. Already-started operations must
      // still materialize if dispose() was called while they validated cwd.
      if (closing && leases === 0) assertOpen();
      return { packageRoot };
    },
    dispose() {
      if (disposal !== undefined) return disposal;
      closing = true;
      const idle = leases === 0 ? Promise.resolve() : new Promise<void>(resolve => { onIdle = resolve; });
      disposal = idle.then(async () => rm(packageRoot, { recursive: true, force: true }));
      return disposal;
    },
  });
  bindHostModule(module, Object.freeze<HostBinding>({
    id,
    assertOpen,
    acquire() {
      assertOpen();
      leases += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases -= 1;
        if (leases === 0) onIdle?.();
      };
    },
    async invoke(method, input, signal) {
      // A guest can reach the client directly, so neither the name nor the shape is trusted.
      if (!known.has(method)) throw new Error(`Unknown host function ${JSON.stringify(specifier)}.${method}`);
      if (!Array.isArray(input)) throw new TypeError(`Host function ${method} expects an argument array`);
      return call(method, input, Object.freeze({ signal }));
    },
  }));
  return module;
}
