import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { Type, hostFunction, hostModule, TSFuncExecutor, ProcExecutor, ProcExecutionError, TypeCheckError } from "../dist/index.js";
import { project, workspaceNames } from "./helpers.js";

const timeout = 60_000;
const flavors = [TSFuncExecutor, ProcExecutor];
const clientUrl = new URL("../dist/runtime/host-client.js", import.meta.url).href;
const require = createRequire(import.meta.url);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Gates may be rejected during cleanup, including before they are consumed.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function bounded(promise, label = "operation", milliseconds = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function execute(executor, root, source, options = {}) {
  // A broken channel must not leave a child retaining the test runner forever.
  // This is only a failure watchdog; successful assertions use explicit gates.
  const guardedSource = `
    const __hostTestWatchdog = setTimeout(() => process.exit(124), 25_000);
    __hostTestWatchdog.unref();
    ${source}
  `;
  const promise = executor.execute({ cwd: root, check: false, ...options, source: guardedSource });
  promise.catch(() => {});
  return promise;
}

function resultSource(Flavor, imports, body, expression) {
  return `${imports}\nexport async function main() {\n${body}\n${Flavor === TSFuncExecutor
    ? `return ${expression};`
    : `process.stdout.write(JSON.stringify(${expression}));`}\n}`;
}

function resultValue(Flavor, result) {
  return Flavor === TSFuncExecutor ? result.value : JSON.parse(result);
}

function fn(input = Type.Null(), output = input, handler = value => value) {
  return hostFunction({ input, output, handler });
}

async function makeModule(t, root, functions, options = {}) {
  const module = await hostModule({ resolutionRoot: root, specifier: "@fixture/host", functions, ...options });
  t.after(() => bounded(module.dispose(), "module cleanup"));
  return module;
}

async function absent(path) {
  await assert.rejects(stat(path), error => error?.code === "ENOENT");
}

async function artifacts(module) {
  return Promise.all(["package.json", "index.d.ts", "index.js"].map(async name => {
    const file = join(module.packageRoot, name);
    const info = await stat(file, { bigint: true });
    return { name, ino: info.ino, mtimeNs: info.mtimeNs, size: info.size, text: await readFile(file, "utf8") };
  }));
}

async function moduleId(module) {
  const proxy = await readFile(join(module.packageRoot, "index.js"), "utf8");
  const match = /return call\(("[^"\n]+")/u.exec(proxy);
  assert.ok(match, "generated proxy contains its stable module identity");
  return JSON.parse(match[1]);
}

test("host module captures factory metadata, functions, schemas and handlers before awaiting", { timeout }, async t => {
  const root = await project(t);
  const input = Type.Object({ count: Type.Number() }, { additionalProperties: false });
  const output = Type.Object({ count: Type.Number() }, { additionalProperties: false });
  let calls = 0;
  const definition = {
    input, output, description: "original function docs",
    handler: value => { calls += 1; return { count: value.count + 1 }; },
  };
  const original = hostFunction(definition);
  const options = {
    resolutionRoot: root,
    specifier: "@fixture/captured",
    description: "original module docs",
    functions: { increment: original },
  };
  const pending = hostModule(options);
  definition.handler = () => { throw new Error("replacement handler ran"); };
  definition.description = "replacement function docs";
  input.properties.count.type = "string";
  input.required.length = 0;
  output.properties.count.type = "string";
  options.specifier = "@fixture/replacement";
  options.description = "replacement module docs";
  options.resolutionRoot = join(root, "not-created");
  options.functions.increment = fn();
  options.functions.added = fn();
  const module = await pending;
  t.after(() => bounded(module.dispose(), "captured module cleanup"));
  assert.ok(Object.isFrozen(module));
  assert.throws(() => { module.specifier = "changed"; }, TypeError);
  assert.equal(module.specifier, "@fixture/captured");
  assert.equal(module.description, "original module docs");
  assert.equal(dirname(module.packageRoot), join(root, ".ts-executor", "modules"));
  const declaration = await readFile(join(module.packageRoot, "index.d.ts"), "utf8");
  assert.match(declaration, /count: number/u);
  assert.match(declaration, /original function docs/u);
  assert.doesNotMatch(declaration, /replacement|added/u);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  assert.deepEqual(await executor.listModules({ query: "ORIGINAL MODULE" }), [{
    specifier: module.specifier, description: module.description, packageRoot: module.packageRoot,
  }]);
  const source = `import { increment } from "@fixture/captured";
    export async function main() { return increment({ count: 4 }); }`;
  assert.equal((await executor.check({ source })).ok, true);
  assert.deepEqual((await execute(executor, root, source)).value, { count: 5 });
  assert.equal(calls, 1);
  await absent(join(root, "not-created"));
  assert.deepEqual(await workspaceNames(root), []);
});

test("host artifacts are stable across discovery, repeated checks, runs and concurrent executors", { timeout }, async t => {
  const root = await project(t);
  let calls = 0;
  const module = await makeModule(t, root, { echo: fn(Type.String(), Type.String(), value => { calls += 1; return value; }) });
  const before = await artifacts(module);
  assert.deepEqual((await readdir(module.packageRoot)).sort(), ["index.d.ts", "index.js", "package.json"]);
  for (const artifact of before) {
    assert.doesNotMatch(artifact.text, /\.ts-executor[\\/]runs|run-[A-Za-z0-9]+|localhost|127\.0\.0\.1|NODE_CHANNEL_FD/u);
  }
  assert.doesNotMatch(before.find(file => file.name === "index.d.ts").text, /\bimport\s/u);
  const standalone = await import(pathToFileURL(join(module.packageRoot, "index.js")).href);
  await assert.rejects(standalone.echo("outside a child"), /IPC is unavailable/u);
  assert.equal(calls, 0);

  const executors = [new TSFuncExecutor({ resolutionRoot: root }), new TSFuncExecutor({ resolutionRoot: root }), new ProcExecutor({ resolutionRoot: root })];
  for (const executor of executors) executor.modules.register(module);
  for (let round = 0; round < 2; round += 1) {
    await Promise.all(executors.map(async executor => {
      const Flavor = executor.constructor;
      const source = resultSource(Flavor, 'import { echo } from "@fixture/host";', "", 'await echo("stable")');
      const lists = await Promise.all([executor.listModules(), executor.listModules({ query: "host" })]);
      for (const list of lists) {
        assert.ok(Object.isFrozen(list));
        assert.ok(Object.isFrozen(list[0]));
        assert.equal(list[0].packageRoot, module.packageRoot);
      }
      assert.equal((await executor.check({ source })).ok, true);
      assert.equal(resultValue(Flavor, await execute(executor, root, source, { check: true })), "stable");
    }));
    assert.deepEqual(await artifacts(module), before, "neither declarations nor proxies are rewritten");
    assert.deepEqual(await workspaceNames(root), []);
  }
  assert.equal(calls, 6);
  assert.deepEqual(await readdir(join(root, ".ts-executor", "modules")), [basename(module.packageRoot)]);
  await module.dispose();
  await absent(module.packageRoot);
  assert.deepEqual(await readdir(join(root, ".ts-executor", "modules")), []);
  assert.deepEqual(await readdir(join(root, ".ts-executor", "runs")), []);
  assert.equal(await readFile(join(root, "package.json"), "utf8"), '{"private":true,"type":"module"}\n');
});

test("named and dynamic imports tolerate generator and proxy alias-name collisions", { timeout }, async t => {
  const root = await project(t);
  const names = ["a_b", "aB", "A_B", "call", "fn0", "Promise", "HostFunction615F62Input", "constructor", "__proto__", "toString", "$value", "_value"];
  const module = await makeModule(t, root, Object.fromEntries(names.map(name => [name,
    fn(Type.Object({ value: Type.Number() }, { additionalProperties: false }), Type.String(), value => `${name}:${value.value}`),
  ])));
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const source = `
    import { ${names.map((name, index) => `${name} as imported${index}`).join(", ")} } from "@fixture/host";
    export async function main() {
      const dynamic = await import("@fixture/host");
      const named: string[] = await Promise.all([${names.map((_, index) => `imported${index}({ value: 1 })`).join(", ")}]);
      const loaded: string[] = await Promise.all([${names.map(name => `dynamic[${JSON.stringify(name)}]({ value: 2 })`).join(", ")}]);
      return { named, loaded };
    }
  `;
  const checked = await executor.check({ source });
  assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  assert.deepEqual((await execute(executor, root, source, { check: true })).value, {
    named: names.map(name => `${name}:1`), loaded: names.map(name => `${name}:2`),
  });
});

test("invalid/reserved exports and fabricated handles reject without writing package artifacts", { timeout }, async t => {
  const root = await project(t);
  const valid = fn();
  const options = { resolutionRoot: root, specifier: "@fixture/invalid" };
  for (const name of ["", "not-valid", "1leading", "a.b", "x); throw 1; //", "default", "class", "await", "eval", "arguments", "interface", "private", "static", "then"]) {
    await assert.rejects(hostModule({ ...options, functions: { [name]: valid } }), /identifier|reserved/u, name);
  }
  for (const handle of [{}, { ...valid }, new Proxy(valid, {}), { handler() {} }, () => null, null, undefined]) {
    await assert.rejects(hostModule({ ...options, functions: { fabricated: handle } }), /created by hostFunction/u);
  }
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "bad", { enumerable: true, get() { getterCalls += 1; return valid; } });
  const hidden = Object.defineProperty({}, "hidden", { value: valid });
  for (const functions of [accessor, hidden, { [Symbol("bad")]: valid }, [], null]) {
    await assert.rejects(hostModule({ ...options, functions }), /data properties|names must be strings|functions must be an object/u);
  }
  assert.equal(getterCalls, 0);
  await assert.rejects(hostModule({ ...options, functions: {}, description: 42 }), /description must be a string/u);
  await assert.rejects(hostModule({ ...options, specifier: "../escape", functions: {} }), /Invalid package module specifier/u);
  await absent(join(root, ".ts-executor"));
});

for (const Flavor of flavors) {
  test(`${Flavor.name}: check:false still enforces JSON and schemas in both host-call directions`, { timeout }, async t => {
    const root = await project(t);
    let echoCalls = 0;
    let schemaCalls = 0;
    let getterCalls = 0;
    const cycle = {}; cycle.self = cycle;
    const invalidOutputs = [
      undefined, NaN, Infinity, -Infinity, 1n, Symbol("bad"), () => null, new Date(), new Map(), new Set(), /bad/u,
      new Uint8Array([1]), new (class { value = 1; })(), cycle, Array(1), Object.assign([], { extra: 1 }),
      { value: undefined }, [undefined], { [Symbol("bad")]: 1 },
      Object.defineProperty({}, "value", { enumerable: true, get() { getterCalls += 1; return 1; } }),
      Object.defineProperty({}, "hidden", { value: 1 }),
      { toJSON() { getterCalls += 1; return null; } },
    ];
    const schema = Type.Object({ count: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
    const module = await makeModule(t, root, {
      echo: fn(Type.Any(), Type.Any(), value => { echoCalls += 1; return value; }),
      constrained: fn(schema, schema, value => { schemaCalls += 1; return value; }),
      badOutput: fn(Type.Integer(), Type.Unknown(), index => invalidOutputs[index]),
      badSchema: fn(Type.Null(), schema, () => ({ count: "1" })),
    });
    const executor = new Flavor({ resolutionRoot: root });
    executor.modules.register(module);
    const source = resultSource(Flavor, 'import { echo, constrained, badOutput, badSchema } from "@fixture/host";', `
      let hooks = 0;
      const cyclic: any = {}; cyclic.self = cyclic;
      const invalid = [undefined, NaN, Infinity, -Infinity, 1n, Symbol("bad"), () => null,
        new Date(), new Map(), new Set(), /bad/, new Uint8Array([1]), new (class { value = 1; })(),
        cyclic, Array(1), Object.assign([], { extra: 1 }), { value: undefined }, [undefined],
        { [Symbol("bad")]: 1 }, Object.defineProperty({}, "value", { enumerable: true, get() { hooks += 1; return 1; } }),
        Object.defineProperty({}, "hidden", { value: 1 }), { toJSON() { hooks += 1; return null; } }];
      async function rejection(operation: () => Promise<unknown>) {
        try { await operation(); return { name: "UNEXPECTED_SUCCESS", message: "" }; }
        catch (error: any) { return { name: error.name, message: error.message }; }
      }
      const inputs = [];
      for (const value of invalid) inputs.push(await rejection(() => echo(value)));
      const schemas = [];
      for (const value of [{}, { count: "1" }, { count: 0 }, { count: 1.5 }, { count: 1, extra: true }]) {
        schemas.push(await rejection(() => constrained(value as any)));
      }
      const outputs = [];
      for (let index = 0; index < ${invalidOutputs.length}; index += 1) outputs.push(await rejection(() => badOutput(index)));
      const outputSchema = await rejection(() => badSchema(null));
      const valid = await echo(JSON.parse('{"__proto__":"data","constructor":3,"list":[null,true,1,"☃"]}'));
      const validSchema = await constrained({ count: 2 });
    `, "({ inputs, schemas, outputs, outputSchema, valid, validSchema, hooks })");
    const result = resultValue(Flavor, await execute(executor, root, source));
    assert.equal(result.inputs.length, invalidOutputs.length);
    for (const error of result.inputs) {
      assert.equal(error.name, "TypeError");
      assert.match(error.message, /Host-call envelope/u);
    }
    for (const error of result.schemas) assert.match(error.message, /Host function input does not match its schema/u);
    for (const error of result.outputs) {
      assert.equal(error.name, "TypeError");
      assert.match(error.message, /Host function output/u);
    }
    assert.match(result.outputSchema.message, /Host function output does not match its schema/u);
    assert.deepEqual(result.valid, JSON.parse('{"__proto__":"data","constructor":3,"list":[null,true,1,"☃"]}'));
    assert.deepEqual(result.validSchema, { count: 2 });
    assert.equal(result.hooks, 0);
    assert.equal(getterCalls, 0);
    assert.equal(echoCalls, 1, "invalid guest values never reach the host handler");
    assert.equal(schemaCalls, 1, "schema mismatches never reach the host handler");
    assert.deepEqual(await workspaceNames(root), []);
  });

  test(`${Flavor.name}: host errors are catchable in guest and retain flavor output contracts when uncaught`, { timeout }, async t => {
    const root = await project(t);
    const module = await makeModule(t, root, {
      fail: fn(Type.Null(), Type.Null(), () => { throw new RangeError("host exploded"); }),
      arbitrary: fn(Type.Null(), Type.Null(), () => { throw Object.create(null); }),
      badResult: fn(Type.Null(), Type.String(), () => undefined),
      okay: fn(Type.Null(), Type.String(), () => "okay"),
    });
    const executor = new Flavor({ resolutionRoot: root });
    executor.modules.register(module);
    const caught = resultSource(Flavor, 'import { fail, arbitrary, okay } from "@fixture/host";', `
      const errors = [];
      for (const operation of [fail, arbitrary]) {
        try { await operation(null); }
        catch (error: any) { errors.push({ name: error.name, message: error.message, stack: typeof error.stack }); }
      }
    `, "({ errors, next: await okay(null) })");
    assert.deepEqual(resultValue(Flavor, await execute(executor, root, caught)), {
      errors: [
        { name: "RangeError", message: "host exploded", stack: "string" },
        { name: "Error", message: "Non-Error value thrown: [unprintable]", stack: "string" },
      ], next: "okay",
    });
    for (const [method, name, message] of [
      ["fail", "RangeError", /host exploded/u],
      ["badResult", "TypeError", /Host function output.*undefined/u],
    ]) {
      await assert.rejects(execute(executor, root, `
        import { ${method} as operation } from "@fixture/host";
        export async function main() {
          console.log("before host error"); console.error("host error detail");
          await operation(null);
          ${Flavor === TSFuncExecutor ? "return null;" : ""}
        }
      `), error => {
        assert.equal(error.name, name);
        assert.match(error.message, message);
        assert.match(error.stack, message);
        assert.equal(error.stdout, "before host error\n");
        assert.equal(error.stderr, "host error detail\n");
        if (Flavor === ProcExecutor) {
          assert.ok(error instanceof ProcExecutionError);
          assert.equal(error.exitCode, 1);
          assert.equal(error.signal, null);
        }
        return true;
      });
    }
    await assert.rejects(execute(executor, root, `
      import { okay } from "@fixture/host";
      export async function main() {
        await okay(null); console.log("invalid terminal value");
        return ${Flavor === TSFuncExecutor ? "undefined" : '"not void"'};
      }
    `), error => {
      assert.match(error.message, Flavor === TSFuncExecutor ? /Execution result.*undefined/u : /undefined/u);
      assert.equal(error.stdout, "invalid terminal value\n");
      if (Flavor === ProcExecutor) assert.ok(error instanceof ProcExecutionError);
      return true;
    });
    assert.deepEqual(await workspaceNames(root), []);
  });
}

test("same-child Promise.all correlates deliberately out-of-order replies without serializing host calls", { timeout }, async t => {
  const root = await project(t);
  const entered = deferred();
  const releases = Array.from({ length: 3 }, deferred);
  const acknowledged = Array.from({ length: 3 }, deferred);
  const contexts = [];
  const finished = [];
  t.after(() => { for (const gate of releases) gate.resolve(); });
  const module = await makeModule(t, root, {
    delayed: fn(Type.Integer(), Type.String(), async (index, context) => {
      contexts.push(context);
      if (contexts.length === 3) entered.resolve();
      await releases[index].promise;
      return `reply:${index}`;
    }),
    acknowledge: fn(Type.Integer(), Type.Null(), index => { finished.push(index); acknowledged[index].resolve(); return null; }),
  });
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const running = execute(executor, root, `
    import { delayed, acknowledge } from "@fixture/host";
    export async function main() {
      return Promise.all([0, 1, 2].map(async index => {
        const value = await delayed(index);
        await acknowledge(index);
        return value;
      }));
    }
  `);
  await bounded(entered.promise, "three simultaneous host callbacks");
  assert.ok(contexts.every(context => Object.isFrozen(context) && context.signal === contexts[0].signal));
  assert.equal(contexts[0].signal.aborted, false);
  for (const index of [2, 0, 1]) {
    releases[index].resolve();
    await bounded(acknowledged[index].promise, `guest acknowledgment ${index}`);
  }
  assert.deepEqual((await bounded(running)).value, ["reply:0", "reply:1", "reply:2"]);
  assert.deepEqual(finished, [2, 0, 1]);
  assert.equal(contexts[0].signal.aborted, true);
});

test("one module is shared concurrently across different executor roots while child state stays fresh", { timeout }, async t => {
  const storageRoot = await project(t);
  const roots = [await project(t), await project(t)];
  const allEntered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let count = 0;
  const signals = [];
  const module = await makeModule(t, storageRoot, {
    bump: fn(Type.Null(), Type.Integer(), async (_input, context) => {
      const value = ++count;
      signals.push(context.signal);
      if (count === 2) allEntered.resolve();
      await release.promise;
      return value;
    }),
  });
  const before = await artifacts(module);
  const executors = roots.map(root => new TSFuncExecutor({ resolutionRoot: root }));
  for (const executor of executors) executor.modules.register(module);
  const source = `import { bump } from "@fixture/host";
    let local = 0;
    export async function main() {
      return { local: ++local, host: await bump(null), cwd: process.cwd(), entry: import.meta.url, pid: process.pid };
    }`;
  const pending = executors.map((executor, index) => execute(executor, roots[index], source));
  await bounded(allEntered.promise, "two independent subprocesses");
  assert.notEqual(signals[0], signals[1]);
  for (const root of roots) {
    const names = await workspaceNames(root);
    assert.equal(names.length, 1);
    assert.match(names[0], /^run-/u);
    await absent(join(root, ".ts-executor", "modules"));
  }
  release.resolve();
  const results = await Promise.all(pending);
  assert.notEqual(results[0].value.pid, results[1].value.pid);
  assert.deepEqual(results.map(result => result.value.host).sort(), [1, 2]);
  for (const [index, result] of results.entries()) {
    assert.equal(result.value.local, 1);
    assert.equal(result.value.cwd, roots[index]);
    assert.equal(dirname(dirname(fileURLToPath(result.value.entry))), join(roots[index], ".ts-executor", "runs"));
    assert.deepEqual(await workspaceNames(roots[index]), []);
  }
  const again = await execute(executors[0], roots[0], source);
  assert.equal(again.value.local, 1);
  assert.equal(again.value.host, 3);
  assert.deepEqual(await artifacts(module), before);
  assert.deepEqual(await workspaceNames(storageRoot), []);
});

test("operations snapshot module membership before async materialization, including host dispatch", { timeout }, async t => {
  const root = await project(t);
  const first = await makeModule(t, root, { value: fn(Type.Null(), Type.String(), () => "first") });
  const later = await makeModule(t, root, { value: fn(Type.Null(), Type.String(), () => "later") }, { specifier: "@fixture/later" });
  const release = deferred();
  const entered = deferred();
  let materializations = 0;
  const contexts = [];
  t.after(() => release.resolve());
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register({
    specifier: "@fixture/gate", packageRoot: root,
    async materialize(context) {
      contexts.push(context);
      materializations += 1;
      if (materializations === 2) entered.resolve();
      await release.promise;
      return { packageRoot: root };
    },
  });
  executor.modules.register(first);
  const listed = executor.listModules();
  const oldCheck = executor.check({ source: 'import { value } from "@fixture/later"; export async function main() { return value(null); }' });
  const oldRun = execute(executor, root, `
    import { value } from "@fixture/host";
    export async function main() {
      const hidden = await import(${JSON.stringify(pathToFileURL(join(later.packageRoot, "index.js")).href)});
      let message = "unexpected success";
      try { await hidden.value(null); } catch (error: any) { message = error.message; }
      return { value: await value(null), message };
    }
  `);
  await bounded(entered.promise, "captured operation materializers");
  executor.modules.register(later);
  assert.deepEqual((await listed).map(module => module.specifier), ["@fixture/gate", "@fixture/host"]);
  assert.equal((await executor.listModules()).length, 3);
  release.resolve();
  const checked = await oldCheck;
  assert.equal(checked.ok, false);
  assert.ok(checked.diagnostics.some(diagnostic => /@fixture\/later/u.test(diagnostic.message)));
  assert.deepEqual((await oldRun).value, { value: "first", message: "Host module is not registered for this execution" });
  const source = 'import { value } from "@fixture/later"; export async function main() { return value(null); }';
  assert.equal((await executor.check({ source })).ok, true);
  assert.equal((await execute(executor, root, source)).value, "later");
  assert.equal(materializations, 4, "custom materializers remain operation-local, not cached");
  assert.equal(new Set(contexts.map(context => context.workspaceRoot)).size, 4);
  for (const context of contexts) {
    assert.ok(Object.isFrozen(context));
    assert.equal(dirname(context.workspaceRoot), join(root, ".ts-executor", "runs"));
    assert.equal(context.packageRoot, join(context.workspaceRoot, ".modules", "0"));
  }
  assert.deepEqual(await workspaceNames(root), []);
});

test("unknown module and method requests reject without invoking handlers or poisoning later valid calls", { timeout }, async t => {
  const root = await project(t);
  let calls = 0;
  const module = await makeModule(t, root, { okay: fn(Type.Null(), Type.Null(), () => { calls += 1; return null; }) });
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const id = await moduleId(module);
  const result = await execute(executor, root, `
    import { okay } from "@fixture/host";
    import { callHost } from ${JSON.stringify(clientUrl)};
    export async function main() {
      const errors = [];
      for (const [id, method] of [["not-registered", "okay"], [${JSON.stringify(id)}, "missing"], [${JSON.stringify(id)}, "toString"]]) {
        try { await callHost(id!, method!, null); } catch (error: any) { errors.push(error.message); }
      }
      await okay(null);
      return errors;
    }
  `);
  assert.match(result.value[0], /not registered for this execution/u);
  assert.match(result.value[1], /Unknown host function.*missing/u);
  assert.match(result.value[2], /Unknown host function.*toString/u);
  assert.equal(calls, 1);
});

test("dispose is idempotent, rejects new operations, and waits for all executor leases without aborting them", { timeout }, async t => {
  const root = await project(t);
  const releases = [deferred(), deferred()];
  const entered = deferred();
  const signals = [];
  t.after(() => { for (const gate of releases) gate.resolve(); });
  const module = await makeModule(t, root, {
    hold: fn(Type.Integer(), Type.Integer(), async (index, context) => {
      signals.push(context.signal);
      if (signals.length === 2) entered.resolve();
      await releases[index].promise;
      return index;
    }),
  });
  const executors = flavors.map(Flavor => new Flavor({ resolutionRoot: root }));
  for (const executor of executors) executor.modules.register(module);
  const pending = executors.map((executor, index) => execute(executor, root,
    resultSource(executor.constructor, 'import { hold } from "@fixture/host";', "", `await hold(${index})`)));
  await bounded(entered.promise, "both existing leases");
  let disposed = false;
  const disposal = module.dispose();
  disposal.then(() => { disposed = true; });
  assert.equal(module.dispose(), disposal);
  await nextTurn();
  assert.equal(disposed, false);
  await stat(join(module.packageRoot, "index.d.ts"));
  assert.ok(signals.every(signal => !signal.aborted));
  for (const executor of executors) {
    await assert.rejects(executor.listModules(), /disposed or disposing/u);
    await assert.rejects(executor.listModules({ query: "not-present" }), /disposed or disposing/u);
    await assert.rejects(executor.check({ source: "export {};" }), /disposed or disposing/u);
    await assert.rejects(execute(executor, root, "export function main() { return null; }"), /disposed or disposing/u);
    assert.throws(() => new executor.constructor({ resolutionRoot: root }).modules.register(module), /disposed or disposing/u);
  }
  releases[0].resolve();
  assert.equal((await pending[0]).value, 0);
  await nextTurn();
  assert.equal(disposed, false, "the second executor still owns a lease");
  await stat(module.packageRoot);
  releases[1].resolve();
  assert.equal(await pending[1], "1");
  await bounded(disposal, "disposal after final lease");
  assert.equal(module.dispose(), disposal);
  assert.ok(signals.every(signal => signal.aborted));
  await absent(module.packageRoot);
  assert.deepEqual(await workspaceNames(root), []);
});

for (const Flavor of flavors) {
  test(`${Flavor.name}: immediate dispose after execute/check calls preserves already-started operations`, { timeout }, async t => {
    const root = await project(t);
    const module = await makeModule(t, root, { echo: fn(Type.String()) });
    const executor = new Flavor({ resolutionRoot: root });
    executor.modules.register(module);
    const source = resultSource(Flavor, 'import { echo } from "@fixture/host";', "", 'await echo("leased")');
    const listed = executor.listModules();
    const checked = executor.check({ source });
    const running = execute(executor, root, source, { check: true });
    const disposed = module.dispose();
    assert.equal((await listed)[0].packageRoot, module.packageRoot);
    assert.equal((await checked).ok, true);
    assert.equal(resultValue(Flavor, await running), "leased");
    await bounded(disposed);
    await absent(module.packageRoot);
    assert.deepEqual(await workspaceNames(root), []);
  });

  test(`${Flavor.name}: every pre-start/runtime failure releases host leases and removes run directories`, { timeout }, async t => {
    const root = await project(t);
    const cases = [
      { name: "relative cwd", options: { cwd: "relative" }, error: /absolute filesystem path/u },
      { name: "missing cwd", options: { cwd: join(root, "missing") }, error: /cwd does not exist/u },
      { name: "invalid source", options: { source: null }, error: /source must be a string/u },
      { name: "typecheck", options: { check: true, source: 'export function main() { const wrong: number = "text"; return null; }' }, error: error => error instanceof TypeCheckError },
      { name: "materialize", materialize() { throw new Error("injected materialize failure"); }, error: /injected materialize failure/u },
      { name: "stdout creation", async materialize(context) { await mkdir(join(context.workspaceRoot, "stdout.log")); }, error: /EISDIR|illegal operation on a directory/u },
      { name: "spawn after cwd disappears", removeCwd: true, error: /ENOENT|spawn/u },
      { name: "early exit", options: { source: "export function main() { process.exit(7); }" }, error: /code 7 without a valid error/u },
      { name: "guest throw", options: { source: 'export function main() { throw new Error("guest failed"); }' }, error: /guest failed/u },
      { name: "output read", options: { source: 'import { unlinkSync } from "node:fs"; export function main() { unlinkSync(new URL("./stdout.log", import.meta.url)); return null; }' }, error: /ENOENT/u },
    ];
    if (Flavor === TSFuncExecutor) {
      cases.unshift({ name: "invalid input", options: { input: { bad: undefined } }, error: /Execution input.*undefined/u });
      cases.push({ name: "input file creation", async materialize(context) { await mkdir(join(context.workspaceRoot, "input.json")); }, error: /EISDIR|illegal operation on a directory/u });
    }
    for (const scenario of cases) {
      await t.test(scenario.name, { timeout: 30_000 }, async () => {
        const module = await makeModule(t, root, { okay: fn() });
        const executor = new Flavor({ resolutionRoot: root });
        executor.modules.register(module);
        let cwd = root;
        if (scenario.removeCwd) {
          cwd = join(root, "vanishing-cwd");
          await mkdir(cwd);
        }
        if (scenario.materialize || scenario.removeCwd) {
          executor.modules.register({
            specifier: "@fixture/fault", packageRoot: root,
            async materialize(context) {
              if (scenario.removeCwd) await rm(cwd, { recursive: true });
              await scenario.materialize?.(context);
              return { packageRoot: root };
            },
          });
        }
        // Use the public method directly to preserve deliberately invalid source.
        const operation = executor.execute({
          cwd, check: false,
          source: Flavor === TSFuncExecutor ? "export function main() { return null; }" : "export function main() {}",
          ...scenario.options,
        });
        const rejection = assert.rejects(operation, scenario.error);
        const disposal = module.dispose();
        await rejection;
        await bounded(disposal, `lease release after ${scenario.name}`);
        await absent(module.packageRoot);
        assert.deepEqual(await workspaceNames(root), []);
      });
    }
  });
}

test("failed check/materialization/storage and partial lease acquisition do not retain other modules", { timeout }, async t => {
  const root = await project(t);
  for (const failure of ["source", "materialize", "storage", "acquire"]) {
    const module = await makeModule(t, root, { okay: fn() });
    const executor = new TSFuncExecutor({ resolutionRoot: root });
    executor.modules.register(module);
    if (failure === "materialize") executor.modules.register({
      specifier: "@fixture/broken", packageRoot: root,
      async materialize() { throw new Error("check materializer failed"); },
    });
    if (failure === "storage") {
      await rm(join(root, ".ts-executor", "runs"), { recursive: true, force: true });
      await writeFile(join(root, ".ts-executor", "runs"), "not a directory");
    }
    if (failure === "acquire") {
      const closed = await makeModule(t, root, { okay: fn() }, { specifier: "@fixture/closed" });
      executor.modules.register(closed);
      await closed.dispose();
    }
    await assert.rejects(executor.check({ source: failure === "source" ? null : "export {};" }));
    if (failure === "acquire") await assert.rejects(execute(executor, root, "export function main() { return null; }"), /disposed/u);
    await bounded(module.dispose(), `${failure} check lease release`);
    await absent(module.packageRoot);
    if (failure === "storage") await rm(join(root, ".ts-executor", "runs"));
    assert.deepEqual(await workspaceNames(root), []);
  }
});

test("nested run workspaces resolve ambient Node types from the original resolutionRoot", { timeout }, async t => {
  const root = await project(t);
  const typesRoot = join(root, "node_modules", "@types", "node");
  await mkdir(typesRoot, { recursive: true });
  await writeFile(join(typesRoot, "package.json"), JSON.stringify({ name: "@types/node", version: "1.0.0", types: "index.d.ts" }));
  await writeFile(join(typesRoot, "index.d.ts"), `
    /// <reference path=${JSON.stringify(require.resolve("@types/node/index.d.ts"))} />
    declare namespace NodeJS { interface Process { hostTestRootMarker: "root-node-types"; } }
  `);
  const module = await makeModule(t, root, { echo: fn(Type.String()) });
  for (const Flavor of flavors) {
    const executor = new Flavor({ resolutionRoot: pathToFileURL(root) });
    executor.modules.register(module);
    const source = resultSource(Flavor, 'import { echo } from "@fixture/host";', `
      const marker: typeof process.hostTestRootMarker = "root-node-types";
      const buffer: Buffer = Buffer.from(marker);
    `, 'await echo(buffer.toString("utf8"))');
    const checked = await executor.check({ source });
    assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
    assert.equal(resultValue(Flavor, await execute(executor, root, source, { check: true })), "root-node-types");
  }
  assert.deepEqual(await workspaceNames(root), []);
});

for (const Flavor of flavors) {
  test(`${Flavor.name}: no host modules means no default IPC channel`, { timeout }, async t => {
    const root = await project(t);
    const executor = new Flavor({ resolutionRoot: root });
    const source = resultSource(Flavor, "", "", '({ send: typeof process.send, connected: process.connected === undefined, channel: process.channel === undefined })');
    assert.deepEqual(resultValue(Flavor, await execute(executor, root, source)), {
      send: "undefined", connected: true, channel: true,
    });
    assert.deepEqual(await workspaceNames(root), []);
  });

  for (const terminal of ["settled", "disconnect", "early-exit"]) {
    test(`${Flavor.name}: ${terminal} aborts context and does not wait for uncooperative host work or late rejection`, { timeout }, async t => {
      const root = await project(t);
      const entered = deferred();
      const blocked = deferred();
      const aborted = deferred();
      const unhandled = [];
      const onUnhandled = error => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      t.after(() => { process.off("unhandledRejection", onUnhandled); blocked.resolve(null); });
      let signal;
      const module = await makeModule(t, root, {
        hang: fn(Type.Null(), Type.Null(), async (_input, context) => {
          assert.ok(Object.isFrozen(context));
          signal = context.signal;
          signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          entered.resolve();
          return blocked.promise;
        }),
        ready: fn(Type.Null(), Type.Null(), async () => { await entered.promise; return null; }),
      });
      const executor = new Flavor({ resolutionRoot: root });
      executor.modules.register(module);
      const source = resultSource(Flavor, 'import { hang, ready } from "@fixture/host";', `
        const abandoned = hang(null);
        await ready(null);
        console.error("terminal detail");
        ${terminal === "disconnect" ? 'process.disconnect!(); try { await abandoned; } catch {}' : ""}
        ${terminal === "early-exit" ? 'console.log("early output"); process.exit(7);' : ""}
      `, '"finished without host"');
      const operation = execute(executor, root, source);
      if (terminal === "early-exit") {
        await bounded(assert.rejects(operation, error => {
          assert.match(error.message, /code 7 without a valid error/u);
          assert.equal(error.stdout, "early output\n");
          assert.equal(error.stderr, "terminal detail\n");
          return true;
        }), "early-exit completion");
      } else {
        assert.equal(resultValue(Flavor, await bounded(operation, `${terminal} completion`)), "finished without host");
      }
      await bounded(aborted.promise, "disconnect AbortSignal");
      assert.equal(signal.aborted, true);
      // The module lease belongs to the run, not to a handler ignoring its signal.
      await bounded(module.dispose(), "disposal while host callback is still blocked");
      await absent(module.packageRoot);
      assert.deepEqual(await workspaceNames(root), []);
      blocked.reject(new Error("late uncooperative host failure"));
      await nextTurn();
      await nextTurn();
      assert.deepEqual(unhandled, []);
    });
  }
}

test("real IPC duplicate requests disconnect without replaying an in-flight host side effect", { timeout }, async t => {
  const root = await project(t);
  const blocked = deferred();
  const aborted = deferred();
  let calls = 0;
  t.after(() => blocked.resolve(null));
  const module = await makeModule(t, root, {
    effect: fn(Type.Null(), Type.Null(), async (_input, context) => {
      calls += 1;
      context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      return blocked.promise;
    }),
  });
  const id = await moduleId(module);
  const executor = new TSFuncExecutor({ resolutionRoot: root });
  executor.modules.register(module);
  const result = await bounded(execute(executor, root, `
    export async function main() {
      const disconnected = new Promise<void>(resolve => process.once("disconnect", resolve));
      const request = JSON.stringify({ type: "ts-executor:host-request:v1", id: 1000, moduleId: ${JSON.stringify(id)}, method: "effect", input: null });
      process.send!(request); process.send!(request);
      await disconnected;
      return "disconnected";
    }
  `), "duplicate request disconnect");
  assert.equal(result.value, "disconnected");
  assert.equal(calls, 1);
  await bounded(aborted.promise, "duplicate request abort");
  await bounded(module.dispose(), "duplicate request disposal");
  blocked.reject(new Error("late duplicate-request callback failure"));
  await nextTurn();
  assert.deepEqual(await workspaceNames(root), []);
});
