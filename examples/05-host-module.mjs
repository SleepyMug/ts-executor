import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostModule, TSFuncExecutor } from "../dist/index.js";

console.log("\n5) Reusable host module");
const resolutionRoot = fileURLToPath(new URL("../", import.meta.url));

// The declarations are what guests are checked against; the caller writes them
// (by hand here, or generated from its own schemas) and keeps them true.
const declarations = `/** Add an amount to the host counter and return its new total. */
export declare function increment(amount: number): Promise<number>;
/** The host counter's current total. */
export declare function current(): Promise<number>;
`;

let total = 0;
const counter = await hostModule({
  resolutionRoot,
  specifier: "@host/counter",
  description: "A counter owned by the current host session.",
  declarations,
  functions: ["increment", "current"],
  // Every call arrives here with its JSON arguments. The executor checks only that
  // they are JSON, so validating them is the caller's job.
  call(fn, args) {
    if (fn === "current") return total;
    const [amount] = args;
    if (args.length !== 1 || !Number.isInteger(amount)) {
      throw new TypeError("increment(amount) takes one integer");
    }
    return (total += amount);
  },
});

try {
  const executor = new TSFuncExecutor({ resolutionRoot });
  executor.modules.register(counter);
  const [{ packageRoot }] = await executor.listModules();
  const declarationPath = join(packageRoot, "index.d.ts");
  console.log("Discoverable declarations:", declarationPath);
  assert.equal(await readFile(declarationPath, "utf8"), declarations);
  const before = await stat(declarationPath, { bigint: true });

  const source = `
    import { increment } from "@host/counter";
    export async function main() { return await increment(2); }
  `;
  assert.equal((await executor.check({ source })).ok, true);
  for (const expected of [2, 4]) {
    const result = await executor.execute({ source, cwd: resolutionRoot });
    assert.equal(result.value, expected);
    console.log("Persistent host counter:", result.value);
  }

  // A host error is an ordinary rejection the guest can catch.
  const rejected = await executor.execute({
    cwd: resolutionRoot,
    source: `
      import { increment, current } from "@host/counter";
      export async function main() {
        try {
          await increment(0.5);
          return "unexpected";
        } catch (error) {
          return \`\${(error as Error).message}; total still \${await current()}\`;
        }
      }
    `,
  });
  console.log("Caught host error:", rejected.value);

  let stdout = "";
  await executor.execute({
    cwd: resolutionRoot,
    source: `
      import { increment } from "@host/counter";
      export async function main(): Promise<null> {
        // Write explicit text: console inspection may color numbers under FORCE_COLOR.
        process.stdout.write(String(await increment(1)) + "\\n");
        return null;
      }
    `,
    onStdout: (text) => {
      stdout += text;
    },
  });
  assert.equal(stdout, "5\n");
  const after = await stat(declarationPath, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  console.log("Declarations reused across checks and executions.");
} finally {
  await counter.dispose();
}
