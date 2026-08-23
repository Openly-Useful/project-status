#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRelease } from "./release-check.mjs";

export function assertPublishReady() {
  const result = checkRelease();
  if (result.valid && result.publishReady) return result;

  const pending = result.releaseGates
    .filter((gate) => gate.status !== "satisfied")
    .map((gate) => `${gate.id}: ${gate.status}`);
  const reasons = [...result.errors, ...pending];
  throw new Error([
    "PUBLICATION BLOCKED: the canonical Openly Useful release gate is not satisfied.",
    ...reasons.map((reason) => `- ${reason}`),
    "Complete formation, publisher authorization, namespace verification, live public-policy URL verification, and clear blockingRequirements before publishing.",
  ].join("\n"));
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) throw new Error("Usage: assert-publish-ready.mjs");
  const result = assertPublishReady();
  process.stdout.write(`PUBLICATION READY ${result.version}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
