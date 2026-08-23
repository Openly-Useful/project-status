import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createThirdPartyNoticePlan } from "../scripts/third-party-notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "third-party-notices.mjs");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

test("notice plan covers the exact declared site and MCP runtime roots", () => {
  const plan = createThirdPartyNoticePlan();
  assert.equal(plan.valid, true);
  assert.equal(plan.packageCount, 9);
  assert.ok(plan.licenseTextCount >= 4);
  const packages = new Set(plan.dependencies.map((entry) => `${entry.name}@${entry.version}`));
  for (const expected of [
    "@fontsource/ibm-plex-mono@5.3.0",
    "@fontsource/inter@5.3.0",
    "@modelcontextprotocol/core@2.0.0",
    "@modelcontextprotocol/server@2.0.0",
    "@phosphor-icons/react@2.1.10",
    "react@19.2.0",
    "react-dom@19.2.0",
    "scheduler@0.27.0",
    "zod@4.4.3",
  ]) assert.ok(packages.has(expected), expected);
  assert.doesNotMatch(plan.contents, /\/Users\/|\/home\//);
});

test("notice build is deterministic and verify detects drift", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-status-notices-"));
  const output = join(directory, "THIRD_PARTY_NOTICES.md");
  const built = run(["build", "--output", output, "--json"]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const first = readFileSync(output);
  const verified = run(["verify", "--output", output, "--json"]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).valid, true);
  const replaced = run(["build", "--output", output, "--replace", "--json"]);
  assert.equal(replaced.status, 0, replaced.stderr || replaced.stdout);
  assert.equal(readFileSync(output).equals(first), true);
});
