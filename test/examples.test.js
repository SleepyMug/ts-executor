import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("the TS function and stdout process examples run end to end", async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [fileURLToPath(new URL("../examples/run-all.mjs", import.meta.url))],
    { cwd: repositoryRoot },
  );

  assert.equal(stderr, "");
  assert.match(stdout, /1\) Basic checked execution/u);
  assert.match(stdout, /total: 16/u);
  assert.match(stdout, /2\) Physical package module/u);
  assert.match(stdout, /distance: 5/u);
  assert.match(stdout, /3\) Network client as a plain package/u);
  assert.match(stdout, /value: 2, clientInstance: 1/u);
  assert.match(stdout, /value: 5, clientInstance: 1/u);
  assert.match(stdout, /4\) Stdout process execution/u);
  assert.match(stdout, /exact stdout from ProcExecutor/u);
});
