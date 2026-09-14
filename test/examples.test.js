import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

for (const forceColor of ["0", "1"]) {
  test(`the TS function and stdout process examples run end to end (FORCE_COLOR=${forceColor})`, async () => {
    const env = { ...process.env, FORCE_COLOR: forceColor };
    // Isolate the color mode without Node's conflicting-color-variable warnings.
    delete env.NO_COLOR;
    delete env.NODE_DISABLE_COLORS;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../examples/run-all.mjs", import.meta.url))],
      { cwd: repositoryRoot, env },
    );

    assert.equal(stderr, "");
    // These are human-readable example logs, not the executor's exact output API.
    const text = stripVTControlCharacters(stdout);
    if (forceColor === "1") assert.notEqual(stdout, text, "forced-color coverage must include ANSI output");
    else assert.equal(stdout, text);
    assert.match(text, /1\) Basic checked execution/u);
    assert.match(text, /total: 16/u);
    assert.match(text, /2\) Physical package module/u);
    assert.match(text, /distance: 5/u);
    assert.match(text, /3\) Network client as a plain package/u);
    assert.match(text, /value: 2, clientInstance: 1/u);
    assert.match(text, /value: 5, clientInstance: 1/u);
    assert.match(text, /4\) Stdout process execution/u);
    assert.match(text, /exact stdout from ProcExecutor/u);
    assert.match(text, /5\) Agent harness adapter/u);
    assert.match(text, /Model tools: listModules, execute/u);
    assert.match(text, /Corrected tool result: 5/u);
    assert.match(text, /6\) Reusable host module/u);
    assert.match(text, /Persistent host counter: 4/u);
    assert.match(text, /Declarations reused across checks and both executor flavors/u);
  });
}
