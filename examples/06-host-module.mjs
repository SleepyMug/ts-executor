import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostFunction, hostModule, Type, TSFuncExecutor, ProcExecutor } from "../dist/index.js";

console.log("\n6) Reusable host module");
const resolutionRoot = fileURLToPath(new URL("../", import.meta.url));
let total = 0;
const counter = await hostModule({
  resolutionRoot,
  specifier: "@host/counter",
  description: "A counter owned by the current host session.",
  functions: {
    increment: hostFunction({
      description: "Add an amount to the host counter and return its new total.",
      input: Type.Object({ amount: Type.Integer() }, { additionalProperties: false }),
      output: Type.Integer(),
      handler: ({ amount }) => (total += amount),
    }),
  },
});

try {
  const functions = new TSFuncExecutor({ resolutionRoot });
  const processes = new ProcExecutor({ resolutionRoot });
  functions.modules.register(counter);
  processes.modules.register(counter);
  const [{ packageRoot }] = await functions.listModules();
  const declarationPath = join(packageRoot, "index.d.ts");
  console.log("Discoverable declarations:", declarationPath);
  assert.match(await readFile(declarationPath, "utf8"), /function increment/u);
  const before = await stat(declarationPath, { bigint: true });

  const source = `
    import { increment } from "@host/counter";
    export async function main() { return await increment({ amount: 2 }); }
  `;
  assert.equal((await functions.check({ source })).ok, true);
  for (const expected of [2, 4]) {
    const result = await functions.execute({ source, cwd: resolutionRoot });
    assert.equal(result.value, expected);
    console.log("Persistent host counter:", result.value);
  }
  const stdout = await processes.execute({
    cwd: resolutionRoot,
    source: `
      import { increment } from "@host/counter";
      export async function main() {
        // Write explicit text: console inspection may color numbers under FORCE_COLOR.
        process.stdout.write(String(await increment({ amount: 1 })) + "\\n");
      }
    `,
  });
  assert.equal(stdout, "5\n");
  const after = await stat(declarationPath, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  console.log("Declarations reused across checks and both executor flavors.");
} finally {
  await counter.dispose();
}
