import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPackagePlan, readStoredZipEntries } from "../scripts/package-skill.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(projectRoot, ".project-status", "manifest.json");
const mcpRequire = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { Client } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href);
const { StdioClientTransport } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client/stdio")).href);

async function extractStoredArchive(bytes, destination) {
  for (const [entry, contents] of readStoredZipEntries(bytes)) {
    const output = resolve(destination, entry);
    assert.ok(output.startsWith(`${destination}${sep}`), `archive entry escaped extraction root: ${entry}`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
}

async function exerciseExtractedPlugin(kind, archive) {
  const extractionRoot = await mkdtemp(join(tmpdir(), `project-status-${kind}-archive-`));
  try {
    await extractStoredArchive(archive.bytes, extractionRoot);
    const entrypoint = join(extractionRoot, "mcp", "dist", "index.js");
    const environment = { ...process.env };
    delete environment.NODE_PATH;
    delete environment.PROJECT_STATUS_MANIFEST;
    delete environment.PROJECT_STATUS_ROOT;

    const client = new Client(
      { name: `project-status-${kind}-archive-smoke`, version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "--manifest", manifestPath],
      cwd: extractionRoot,
      env: environment,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().name, "project-status-mcp-server");
      assert.equal(client.getServerVersion().version, "1.0.0");

      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "project_status_get_dependencies",
        "project_status_get_summary",
        "project_status_list_tasks",
        "project_status_validate_manifest",
      ]);

      const validation = await client.callTool({
        name: "project_status_validate_manifest",
        arguments: {},
      });
      assert.equal(validation.isError, undefined);
      assert.equal(validation.structuredContent.ok, true);
      assert.equal(validation.structuredContent.valid, true);

      const summary = await client.callTool({
        name: "project_status_get_summary",
        arguments: {},
      });
      assert.equal(summary.isError, undefined);
      assert.equal(summary.structuredContent.ok, true);
      assert.equal(summary.structuredContent.initiative.name, "Project Status");
      assert.equal(summary.structuredContent.score.totalWeight, 100);
    } finally {
      await client.close();
    }
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

test("extracted OpenAI and Claude plugin archives run their bundled MCP server without installation", async (context) => {
  const plan = createPackagePlan();
  assert.equal(plan.valid, true, plan.errors.join("\n"));
  assert.equal(plan.mcpIncluded, true);

  for (const kind of ["openai", "claude"]) {
    await context.test(kind, async () => {
      await exerciseExtractedPlugin(kind, plan.archives[kind]);
    });
  }
});
