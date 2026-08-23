import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectRoot = resolve(packageRoot, "../..");

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("RunGlance npm and MCP Registry identities agree", () => {
  const packageJson = json(join(packageRoot, "package.json"));
  const serverJson = json(join(projectRoot, "mcp-registry", "runglance", "server.json"));
  assert.equal(packageJson.name, "@openly-useful/runglance-mcp");
  assert.equal(packageJson.version, "1.2.0");
  assert.equal(packageJson.mcpName, "org.openlyuseful/runglance");
  assert.equal(serverJson.name, packageJson.mcpName);
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.packages[0].identifier, packageJson.name);
  assert.equal(serverJson.packages[0].version, packageJson.version);
  assert.equal(serverJson.packages[0].transport.type, "stdio");
  assert.equal(serverJson.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
});

test("standalone package and combined source package have distinct identities", () => {
  const packageJson = json(join(packageRoot, "package.json"));
  const projectStatusPackage = json(join(packageRoot, "..", "mcp", "package.json"));
  assert.notEqual(packageJson.name, projectStatusPackage.name);
  assert.notEqual(packageJson.mcpName, projectStatusPackage.mcpName);
  assert.equal(packageJson.version, projectStatusPackage.version);
});

test("published package carries the owner-approved root license", () => {
  assert.deepEqual(
    readFileSync(join(packageRoot, "LICENSE")),
    readFileSync(join(projectRoot, "LICENSE")),
  );
});
