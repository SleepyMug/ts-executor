import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bindHostModule, type HostBinding } from "../host-bindings.js";
import { captureHostFunction, type CapturedHostFunction, type HostFunction } from "../host-function.js";
import { assertPackageSpecifier } from "../registry.js";
import { resolveResolutionRoot, storageDirectory } from "../storage.js";
import type { Module } from "../types.js";

export interface HostModuleOptions {
  /** Storage base for generated packages; normally the executor's resolutionRoot. */
  readonly resolutionRoot: string | URL;
  readonly specifier: string;
  readonly description?: string;
  readonly functions: Readonly<Record<string, HostFunction>>;
}

export interface HostModule extends Module {
  /** Stop new operations, await existing operations, then remove owned artifacts. */
  dispose(): Promise<void>;
}

const clientUrl = new URL("../runtime/host-client.js", import.meta.url).href;

/** Generate once. Reuse this handle across checks, executions, and executors. */
export async function hostModule(options: HostModuleOptions): Promise<HostModule> {
  const { specifier, description, functions } = options;
  const resolutionRoot = resolveResolutionRoot(options.resolutionRoot);
  assertPackageSpecifier(specifier);
  if (description !== undefined && typeof description !== "string") {
    throw new TypeError("Host module description must be a string");
  }
  if (typeof functions !== "object" || functions === null || Array.isArray(functions)) {
    throw new TypeError("Host module functions must be an object of hostFunction handles");
  }
  const captured = new Map<string, CapturedHostFunction>();
  for (const name of Reflect.ownKeys(functions)) {
    if (typeof name !== "string") throw new TypeError("Host function names must be strings");
    // An exported then makes dynamic import treat the module namespace as a thenable.
    if (name === "then") throw new TypeError('Host function name "then" is reserved for ESM interoperability');
    const descriptor = Object.getOwnPropertyDescriptor(functions, name);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Host module functions must be enumerable data properties");
    }
    captured.set(name, captureHostFunction(descriptor.value as HostFunction));
  }
  // All metadata, schemas and functions are captured before the first await.
  const declarations = await Promise.all([...captured].map(([name, fn]) => fn.declaration(name)));
  const id = randomUUID();
  const directory = await storageDirectory(resolutionRoot, "modules");
  const packageRoot = await mkdtemp(join(directory, "module-"));
  try {
    await chmod(packageRoot, 0o700);
    const proxies = [...captured.keys()].map((name, index) =>
      `function fn${index}(input) { return call(${JSON.stringify(id)}, ${JSON.stringify(name)}, input); }\nexport { fn${index} as ${name} };`,
    );
    // Sequential writes prevent a failed write racing directory cleanup.
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: specifier,
      private: true,
      type: "module",
      types: "./index.d.ts",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(packageRoot, "index.d.ts"), `${declarations.join("\n")}\nexport {};\n`, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(packageRoot, "index.js"), `import { callHost as call } from ${JSON.stringify(clientUrl)};\n${proxies.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    try {
      await rm(packageRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      try {
        if ((typeof error === "object" || typeof error === "function") && error !== null) {
          Object.defineProperty(error, "cleanupError", { value: cleanupError, enumerable: true });
        }
      } catch {
        // Preserve the primary failure even when it cannot accept metadata.
      }
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
      const fn = captured.get(method);
      if (fn === undefined) throw new Error(`Unknown host function ${JSON.stringify(specifier)}.${method}`);
      return fn.invoke(input, Object.freeze({ signal }));
    },
  }));
  return module;
}
