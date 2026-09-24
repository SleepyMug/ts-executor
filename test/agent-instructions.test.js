import assert from "node:assert/strict";
import test from "node:test";
import { TSFuncExecutor } from "../dist/index.js";

test("the executor returns deterministic agent instructions for discovery and execution", () => {
  const executor = new TSFuncExecutor({ resolutionRoot: process.cwd() });
  const instructions = executor.getInstructions();

  assert.equal(typeof instructions, "string");
  assert.equal(executor.getInstructions(), instructions);
  assert.equal(new TSFuncExecutor({ resolutionRoot: process.cwd() }).getInstructions(), instructions);
  assert.equal(executor.getInstructions.length, 0, "instructions take no options");

  assert.match(instructions, /^# TypeScript executor$/mu);
  assert.match(instructions, /`listModules\(\{ query\? \}\)`/u);
  assert.match(instructions, /absolute `packageRoot`/u);
  assert.match(instructions, /`package\.json`/u);
  assert.match(instructions, /declaration files defining the interfaces/u);
  assert.match(instructions, /type-checks the source before running by default/u);
  assert.match(instructions, /absolute existing `cwd`/u);
  assert.match(instructions, /processes it starts are killed when it finishes/u);
  assert.match(instructions, /^## JSON function execution$/mu);
  assert.match(instructions, /`main\(input\)`/u);
  assert.match(instructions, /must be strict JSON data/u);
  assert.match(instructions, /the arguments of host-owned functions/u);
  assert.match(instructions, /treat stdout and stderr as logs/u);
});

test("instructions leave limits to the caller and mention no harness or removed APIs", () => {
  const instructions = new TSFuncExecutor({ resolutionRoot: process.cwd() }).getInstructions();
  assert.doesNotMatch(instructions, /^## Limits$/mu);
  assert.doesNotMatch(
    instructions,
    /getTypes|\bcheck\b|getInstructions|resolutionRoot|materializ|\bregister\b|sandbox|timeout|cancellation|truncat|MiB|Stdout process|ProcExecutor|must finish within/u,
  );
});

test("instructions stay independent of module registration and filesystem operations", () => {
  const executor = new TSFuncExecutor({ resolutionRoot: process.cwd() });
  const instructions = executor.getInstructions();
  executor.modules.register({
    specifier: "@fixture/private-catalog-entry",
    packageRoot: process.cwd(),
    description: "Private catalog description.",
    async materialize() { throw new Error("instructions must not materialize"); },
  });
  assert.equal(executor.getInstructions(), instructions);
  assert.doesNotMatch(instructions, /private-catalog-entry|Private catalog description/u);
});
