import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  parseInputEnvelope,
  serializeError,
  stringifyJsonValue,
} from "../json-value.js";
import { absoluteArguments, complete, restoreEnvironment } from "./bootstrap-common.js";

async function execute(): Promise<void> {
  const [entrypoint, inputPath, resultPath, resultTemporaryPath] = absoluteArguments(4) as [
    string,
    string,
    string,
    string,
  ];

  let envelopeText: string;
  let status: 0 | 1;
  try {
    restoreEnvironment();
    const input = parseInputEnvelope(await readFile(inputPath, "utf8"));
    const program = (await import(pathToFileURL(entrypoint).href)) as {
      readonly main?: unknown;
    };
    if (typeof program.main !== "function") {
      throw new TypeError('Program must export a function named "main"');
    }
    const value: unknown = await program.main(input.hasInput ? input.value : undefined);
    envelopeText = `{"ok":true,"value":${stringifyJsonValue(value, "Execution result")}}`;
    status = 0;
  } catch (error) {
    envelopeText = stringifyJsonValue(
      { ok: false, error: serializeError(error) },
      "Execution error envelope",
    );
    status = 1;
  }

  return complete(resultPath, resultTemporaryPath, envelopeText, status);
}

void execute();
