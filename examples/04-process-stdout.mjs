import { fileURLToPath } from "node:url";
import { ProcExecutor } from "../dist/index.js";

console.log("\n4) Stdout process execution");

const resolutionRoot = fileURLToPath(new URL("../", import.meta.url));
const executor = new ProcExecutor({ resolutionRoot });
const stdout = await executor.execute({
  cwd: resolutionRoot,
  source: `
    export async function main(): Promise<void> {
      await Promise.resolve();
      process.stdout.write("exact stdout from ProcExecutor\\n");
      process.stderr.write("captured and discarded on success\\n");
    }
  `,
});

console.log("Captured stdout:", JSON.stringify(stdout));
