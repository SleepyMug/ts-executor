import { pathToFileURL } from "node:url";
import { serializeError, stringifyJsonValue } from "../json-value.js";
import { absoluteArguments, complete, restoreEnvironment } from "./bootstrap-common.js";

async function execute(): Promise<void> {
  const [entrypoint, statusPath, statusTemporaryPath] = absoluteArguments(3) as [
    string,
    string,
    string,
  ];

  let envelopeText: string;
  let status: 0 | 1;
  try {
    restoreEnvironment();
    const program = (await import(pathToFileURL(entrypoint).href)) as {
      readonly main?: unknown;
    };
    if (typeof program.main !== "function") {
      throw new TypeError('Program must export a function named "main"');
    }
    const value: unknown = await program.main();
    if (value !== undefined) {
      throw new TypeError("Proc main() must resolve to exactly undefined; returned values are not supported");
    }
    envelopeText = '{"ok":true}';
    status = 0;
  } catch (error) {
    envelopeText = stringifyJsonValue(
      { ok: false, error: serializeError(error) },
      "Proc execution status envelope",
    );
    status = 1;
  }

  return complete(statusPath, statusTemporaryPath, envelopeText, status);
}

void execute();
