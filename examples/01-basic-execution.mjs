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
});

console.log("Result:", result.value);
console.log("Captured subprocess stdout:", result.stdout.trim());
