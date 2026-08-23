import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(packageRoot, "../..");

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("Project Status npm and MCP Registry identities agree", () => {
  const packageJson = json(join(packageRoot, "package.json"));
  const serverJson = json(join(projectRoot, "mcp-registry", "project-status", "server.json"));
  assert.equal(packageJson.name, "@openly-useful/project-status-mcp");
  assert.equal(packageJson.version, "1.2.1");
  assert.equal(packageJson.mcpName, "org.openlyuseful/project-status");
  assert.equal(serverJson.name, packageJson.mcpName);
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.packages[0].identifier, packageJson.name);
  assert.equal(serverJson.packages[0].version, packageJson.version);
  assert.equal(serverJson.packages[0].transport.type, "stdio");
  assert.equal(serverJson.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
});

test("combined source package preserves both existing local bins", () => {
  const packageJson = json(join(packageRoot, "package.json"));
  assert.deepEqual(packageJson.bin, {
    "project-status-mcp": "dist/index.js",
    "runglance-mcp": "dist/runglance-index.js",
  });
  for (const path of Object.values(packageJson.bin)) {
    const output = join(packageRoot, path);
    assert.ok(readFileSync(output, "utf8").startsWith("#!/usr/bin/env node\n"));
    assert.notEqual(statSync(output).mode & 0o111, 0);
  }
});

test("published package carries the owner-approved root license", () => {
  assert.deepEqual(
    readFileSync(join(packageRoot, "LICENSE")),
    readFileSync(join(projectRoot, "LICENSE")),
  );
});
