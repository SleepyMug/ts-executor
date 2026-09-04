import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { TSFuncExecutor, packageModule } from "../dist/index.js";

console.log("\n3) Network client as a plain package");

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/increment") {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const { amount } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  server.value = (server.value ?? 0) + amount;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ value: server.value }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const resolutionRoot = fileURLToPath(new URL("../", import.meta.url));
  const packageRoot = fileURLToPath(
    new URL("./fixtures/counter-client-package/", import.meta.url),
  );
  const executor = new TSFuncExecutor({ resolutionRoot });

  executor.modules.register(packageModule({
    specifier: "@example/counter-client",
    root: packageRoot,
    description: "A declaration-bearing network client fixture.",
  }));

  const declarations = await executor.getTypes("@example/counter-client");
  console.log("Client declaration entrypoint:", declarations.entrypoint);

  const source = `
    import { createCounterClient } from "@example/counter-client";

    export async function main(input: { baseUrl: string; amount: number }) {
      const client = createCounterClient(input.baseUrl);
      return client.increment(input.amount);
    }
  `;
  for (const amount of [2, 3]) {
    const result = await executor.execute({
      source,
      cwd: resolutionRoot,
      input: { baseUrl, amount },
    });
    console.log("Subprocess-created client result:", result.value);
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error)),
  );
}
