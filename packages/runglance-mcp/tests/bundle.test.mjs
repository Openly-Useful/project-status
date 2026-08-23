import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const standalone = join(packageRoot, "dist", "index.js");
const canonicalBundle = join(packageRoot, "..", "mcp", "dist", "runglance-index.js");

test("standalone bundle is the canonical RunGlance build without source duplication", () => {
  assert.deepEqual(readFileSync(standalone), readFileSync(canonicalBundle));
  const source = readFileSync(standalone, "utf8");
  assert.ok(source.startsWith("#!/usr/bin/env node\n"));
  assert.doesNotMatch(source, /sourceMappingURL=/);
});

test("standalone bundled CLI preserves the existing help behavior", () => {
  const result = spawnSync(process.execPath, [standalone, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Usage: runglance-mcp [--snapshot <path>]\n");
  assert.equal(result.stderr, "");
});
