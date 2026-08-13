import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceBundle = join(projectRoot, "packages", "mcp", "dist", "index.js");
const sourceCore = join(projectRoot, "packages", "core");
const sourceManifest = join(projectRoot, ".project-status", "manifest.json");
const mcpRequire = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { Client } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href);
const { StdioClientTransport } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client/stdio")).href);

test("bundled MCP starts from an isolated plugin tree without node_modules", async (t) => {
  const bundle = await readFile(sourceBundle, "utf8");
  assert.match(bundle, /^#!\/usr\/bin\/env node\n/);
  assert.doesNotMatch(bundle, /(?:from\s+|import\()["'](?:@modelcontextprotocol\/|zod(?:\/|["']))/);

  const isolatedRoot = await mkdtemp(join(tmpdir(), "project-status-mcp-bundle-"));
  const pluginRoot = join(isolatedRoot, "plugin");
  const workspaceRoot = join(isolatedRoot, "workspace");
  const isolatedEntry = join(pluginRoot, "mcp", "dist", "index.js");
  const isolatedManifest = join(workspaceRoot, ".project-status", "manifest.json");
  await mkdir(dirname(isolatedEntry), { recursive: true });
  await mkdir(join(pluginRoot, "core"), { recursive: true });
  await mkdir(dirname(isolatedManifest), { recursive: true });
  await copyFile(sourceBundle, isolatedEntry);
  await copyFile(sourceManifest, isolatedManifest);
  for (const name of (await readdir(sourceCore)).filter((entry) => entry.endsWith(".mjs"))) {
    await copyFile(join(sourceCore, name), join(pluginRoot, "core", name));
  }
  assert.equal(existsSync(join(pluginRoot, "node_modules")), false);

  const client = new Client(
    { name: "project-status-bundle-smoke", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  delete environment.PROJECT_STATUS_MANIFEST;
  delete environment.PROJECT_STATUS_ROOT;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [isolatedEntry, "--manifest", isolatedManifest],
    cwd: isolatedRoot,
    env: environment,
    stderr: "pipe",
  });
  await client.connect(transport);
  t.after(() => client.close());

  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getServerVersion().version, "1.0.0");
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "project_status_get_dependencies",
    "project_status_get_summary",
    "project_status_list_tasks",
    "project_status_validate_manifest",
  ]);
  const summary = await client.callTool({ name: "project_status_get_summary", arguments: {} });
  assert.equal(summary.isError, undefined);
  assert.equal(summary.structuredContent.ok, true);
  assert.equal(summary.structuredContent.score.totalWeight, 100);
});
