#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JsonlRunStore, readLatestRun, recordRun, runAndRecord } from "./index.mjs";

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write("Usage:\n");
  process.stderr.write("  project-status-monitor run --config <config.json> --history <runs.jsonl>\n");
  process.stderr.write("  project-status-monitor record --input <run.json> --history <runs.jsonl>\n");
  process.stderr.write("  project-status-monitor latest --history <runs.jsonl>\n");
  process.exitCode = 2;
}

function argumentsFor(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new TypeError("Options must be --name value pairs.");
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}

async function jsonFile(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function main() {
  const [command, ...values] = process.argv.slice(2);
  if (!["run", "record", "latest"].includes(command)) return usage("An explicit command is required.");
  let options;
  try {
    options = argumentsFor(values);
  } catch (error) {
    return usage(error.message);
  }
  if (!options.history) return usage("--history is required.");
  const store = new JsonlRunStore(resolve(options.history));

  let result;
  if (command === "run") {
    if (!options.config) return usage("run requires --config.");
    result = await runAndRecord(await jsonFile(options.config), { store });
  } else if (command === "record") {
    if (!options.input) return usage("record requires --input.");
    result = await recordRun(store, await jsonFile(options.input));
  } else {
    result = await readLatestRun(store);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Monitor command failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
