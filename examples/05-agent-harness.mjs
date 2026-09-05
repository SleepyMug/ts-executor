import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TSFuncExecutor, packageModule } from "../dist/index.js";
import { createHarnessAdapter } from "./harness-adapter.mjs";

console.log("\n5) Agent harness adapter");

const cwd = fileURLToPath(new URL("../", import.meta.url));
const executor = new TSFuncExecutor({ resolutionRoot: cwd });
executor.modules.register(packageModule({
  specifier: "@example/geometry",
  root: fileURLToPath(new URL("./fixtures/geometry-package/", import.meta.url)),
  description: "Geometry and statistics fixture package.",
}));
const harness = createHarnessAdapter(executor);
// Supply harness.instructions and harness.tools to the model. Dispatch its tool
// calls through callTool, delivering content and the error flag back to the model.
console.log("Model tools:", harness.tools.map(({ name }) => name).join(", "));

const catalog = await harness.callTool("listModules", JSON.stringify({ query: "geometry" }));
if (catalog.isError) throw new Error(catalog.content);
const [module] = JSON.parse(catalog.content);
// File reads represent the harness's existing filesystem capability.
const manifest = JSON.parse(await readFile(join(module.packageRoot, "package.json"), "utf8"));
console.log("Interface:", await readFile(join(module.packageRoot, manifest.exports["."].types), "utf8"));

const failed = await harness.callTool("execute", JSON.stringify({
  cwd,
  source: 'export function main(): number { return "wrong type"; }',
}));
console.log("Model-visible diagnostics:", failed.content);

const corrected = await harness.callTool("execute", JSON.stringify({
  cwd,
  source: `
    import { distance } from "@example/geometry";
    export function main(): number {
      return distance({ x: 0, y: 0 }, { x: 3, y: 4 });
    }
  `,
}));
if (corrected.isError) throw new Error(corrected.content);
console.log("Corrected tool result:", JSON.parse(corrected.content).value);
