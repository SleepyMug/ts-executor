import assert from "node:assert/strict";
import test from "node:test";
import { ProcExecutor, TSFuncExecutor } from "../dist/index.js";

test("executors return deterministic shared and flavor-specific agent instructions", () => {
  const tsFunc = new TSFuncExecutor({ resolutionRoot: process.cwd() });
  const proc = new ProcExecutor({ resolutionRoot: process.cwd() });

  const tsFuncInstructions = tsFunc.getInstructions();
  const procInstructions = proc.getInstructions();

  assert.equal(typeof tsFuncInstructions, "string");
  assert.equal(tsFunc.getInstructions(), tsFuncInstructions);
  assert.equal(proc.getInstructions(), procInstructions);
  assert.notEqual(tsFuncInstructions, procInstructions);

  for (const instructions of [tsFuncInstructions, procInstructions]) {
    assert.match(instructions, /^# TypeScript executor$/mu);
    assert.match(instructions, /`listModules\(\{ query\? \}\)`/u);
    assert.match(instructions, /absolute `packageRoot`/u);
    assert.match(instructions, /`package\.json`/u);
    assert.match(instructions, /declaration files defining the interfaces/u);
    assert.match(instructions, /type-checks the source before running by default/u);
    assert.match(instructions, /absolute existing `cwd`/u);
    assert.doesNotMatch(instructions, /getTypes|\bcheck\b|getInstructions|resolutionRoot|materializ|\bregister\b|sandbox|timeout|cancellation/u);
  }

  assert.match(tsFuncInstructions, /^## JSON function execution$/mu);
  assert.match(tsFuncInstructions, /`main\(input\)`/u);
  assert.match(tsFuncInstructions, /`\{ value, stdout, stderr, durationMs \}`/u);
  assert.match(tsFuncInstructions, /must be strict JSON data/u);
  assert.doesNotMatch(tsFuncInstructions, /^## Stdout process execution$/mu);

  assert.match(procInstructions, /^## Stdout process execution$/mu);
  assert.match(procInstructions, /must resolve to exactly `undefined`/u);
  assert.match(procInstructions, /returns the exact captured stdout string/u);
  assert.match(procInstructions, /Successful stderr is discarded/u);
  assert.doesNotMatch(procInstructions, /^## JSON function execution$/mu);
});

test("instructions stay independent of module registration and filesystem operations", () => {
  for (const Executor of [TSFuncExecutor, ProcExecutor]) {
    const executor = new Executor({ resolutionRoot: process.cwd() });
    const instructions = executor.getInstructions();
    executor.modules.register({
      specifier: "@fixture/private-catalog-entry",
      packageRoot: process.cwd(),
      description: "Private catalog description.",
      async materialize() { throw new Error("instructions must not materialize"); },
    });
    assert.equal(executor.getInstructions(), instructions);
    assert.doesNotMatch(instructions, /private-catalog-entry|Private catalog description/u);
  }
});
