import { fileURLToPath } from "node:url";
import { TSFuncExecutor } from "../dist/index.js";

console.log("\n1) Basic checked execution");

const resolutionRoot = fileURLToPath(new URL("../", import.meta.url));
const executor = new TSFuncExecutor({ resolutionRoot });
const source = `
  interface Input {
    readonly name: string;
    readonly values: readonly number[];
  }

  export function main(input: Input) {
    console.log(\`processing \${input.values.length} values for \${input.name}\`);
    return {
      greeting: \`Hello, \${input.name}!\`,
      total: input.values.reduce((sum, value) => sum + value, 0),
    };
  }
`;

const result = await executor.execute({
  source,
  cwd: resolutionRoot,
  input: { name: "Ada", values: [3, 5, 8] },
  // Output is handed over as it is written; the executor keeps none of it.
  onStdout: (text) => process.stdout.write(`Streamed guest stdout: ${text}`),
});

console.log("Result:", result.value);

// A stdout program is a function that prints and returns null; the caller keeps the text.
let stdout = "";
await executor.execute({
  cwd: resolutionRoot,
  source: `
    export async function main(): Promise<void> {
      await Promise.resolve();
      process.stdout.write("exact stdout, collected by the caller\\n");
    }
  `,
  onStdout: (text) => {
    stdout += text;
  },
});
console.log("Collected stdout:", JSON.stringify(stdout));
