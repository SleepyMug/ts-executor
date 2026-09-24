/**
 * Model-facing instructions for the `listModules` and `execute` tools. Limits the
 * caller enforces (deadlines, how much output it keeps) are the caller's to state.
 */
export const instructions = `# TypeScript executor

Use \`listModules\` to discover package APIs and \`execute\` to run one self-contained TypeScript ESM program. Submit the complete program as a \`source\` string and export a named synchronous or asynchronous \`main\` function. Do not rely on additional relative source files.

## Recommended workflow

1. Call \`listModules({ query? })\` to discover registered packages. It returns each package's \`specifier\`, absolute \`packageRoot\`, and optional \`description\`. The optional query filters specifiers and descriptions case-insensitively.
2. Inspect files at \`packageRoot\`: start with \`package.json\` and follow its \`types\` and \`exports\` entries to the declaration files defining the interfaces, including exported subpaths. Read the relevant declarations and referenced files before writing imports and calls. Descriptions are summaries, not complete API contracts.
3. Write strict ES2022 TypeScript using ESM imports. Import registered packages by package specifier and Node built-ins with \`node:\` specifiers.
4. Call \`execute\` with the source and an absolute existing \`cwd\` directory. It type-checks the source before running by default; repair reported errors and retry. The working directory controls relative filesystem and process behavior; import packages by specifier regardless of \`cwd\`.
5. Each execution starts a fresh Node subprocess with fresh module state, and processes it starts are killed when it finishes. Await asynchronous work and ensure \`main\` settles. Some packages expose host-owned functions: these calls are asynchronous, take JSON arguments and return JSON data, and may access state that persists between executions. Await them before returning from \`main\`; do not assume failed executions roll back their effects.

## JSON function execution

Export \`main(input)\` and call \`execute({ source, cwd, input? })\`. Omitted input is passed to \`main\` as \`undefined\`. Supplied input, the resolved return value, and the arguments of host-owned functions must be strict JSON data: null, booleans, finite numbers, strings, dense arrays, and plain objects composed only from those values. Do not use \`undefined\`, BigInt, functions, symbols, accessors, class instances, sparse arrays, or cycles in them; leave out an optional argument or property instead of passing \`undefined\`.

A \`main\` that returns nothing resolves to \`null\`. Put the machine-readable answer in the return value; treat stdout and stderr as logs.`;
