import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TSFuncExecutor, packageModule } from "../dist/index.js";

console.log("\n2) Physical package module");

const resolutionRoot = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = fileURLToPath(
  new URL("./fixtures/geometry-package/", import.meta.url),
);
const executor = new TSFuncExecutor({ resolutionRoot });

executor.modules.register(packageModule({
  specifier: "@example/geometry",
  root: packageRoot,
  description: "Geometry and statistics fixture package.",
}));

const modules = await executor.listModules();
console.log("Modules:", modules);
const listedRoot = modules[0].packageRoot;
const manifest = JSON.parse(await readFile(join(listedRoot, "package.json"), "utf8"));
const declarationPath = join(listedRoot, manifest.exports["."].types);
console.log("Declaration file:", declarationPath);
console.log(await readFile(declarationPath, "utf8"));

const result = await executor.execute({
  source: `
    import { distance, type Point } from "@example/geometry";
    import { mean } from "@example/geometry/statistics";

    interface Input {
      readonly from: Point;
      readonly to: Point;
      readonly samples: readonly number[];
    }

    export function main(input: Input) {
      return {
        distance: distance(input.from, input.to),
        average: mean(input.samples),
      };
    }
  `,
  cwd: resolutionRoot,
  input: {
    from: { x: 0, y: 0 },
    to: { x: 3, y: 4 },
    samples: [2, 4, 9],
  },
});

console.log("Package result:", result.value);
