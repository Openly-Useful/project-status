import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpRequire = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { Client } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href);
const { StdioClientTransport } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client/stdio")).href);
const serverEntry = join(projectRoot, "packages", "mcp", "dist", "index.js");

function textFrom(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

async function connectClient() {
  const unrelatedCwd = await mkdtemp(join(tmpdir(), "project-status-mcp-cwd-"));
  const client = new Client(
    { name: "project-status-integration-test", version: "1.0.0" },
    {
      capabilities: { roots: {} },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  client.setRequestHandler("roots/list", async () => ({
    roots: [{ uri: pathToFileURL(projectRoot).href, name: "Project workspace" }],
  }));
  const environment = { ...process.env };
  delete environment.PROJECT_STATUS_MANIFEST;
  delete environment.PROJECT_STATUS_ROOT;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd: unrelatedCwd,
    env: environment,
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

test("MCP v2 stdio negotiates 2026-07-28, discovers roots, and serves only read-only tools", async (t) => {
  const { client } = await connectClient();
  t.after(() => client.close());

  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getServerVersion().name, "project-status-mcp-server");
  assert.equal(client.getServerVersion().version, "1.0.0");

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "project_status_get_dependencies",
    "project_status_get_summary",
    "project_status_list_tasks",
    "project_status_validate_manifest",
  ]);
  for (const tool of tools) {
    assert.deepEqual(tool.annotations, {
      title: tool.annotations.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal(typeof tool.outputSchema, "object");
  }

  const validation = await client.callTool({
    name: "project_status_validate_manifest",
    arguments: {},
  });
  assert.equal(validation.isError, undefined);
  assert.equal(validation.structuredContent.ok, true);
  assert.equal(validation.structuredContent.valid, true);
  assert.match(textFrom(validation), /Manifest is valid/);

  const summary = await client.callTool({
    name: "project_status_get_summary",
    arguments: {},
  });
  assert.equal(summary.structuredContent.ok, true);
  assert.equal(summary.structuredContent.initiative.name, "Project Status");
  assert.equal(summary.structuredContent.score.totalWeight, 100);
  assert.match(textFrom(summary), /Readiness:/);

  const tasks = await client.callTool({
    name: "project_status_list_tasks",
    arguments: { status: "complete", limit: 2, offset: 0 },
  });
  assert.equal(tasks.structuredContent.ok, true);
  assert.equal(tasks.structuredContent.count, 2);
  assert.equal(tasks.structuredContent.tasks.every((task) => task.status === "complete"), true);
  assert.equal(tasks.structuredContent.hasMore, true);

  const dependencies = await client.callTool({
    name: "project_status_get_dependencies",
    arguments: { type: "blocks", limit: 5, offset: 0 },
  });
  assert.equal(dependencies.structuredContent.ok, true);
  assert.equal(dependencies.structuredContent.dependencies.every((item) => item.type === "blocks"), true);
});

test("MCP preserves actionable task and phase errors instead of replacing them with generic failures", async (t) => {
  const { client } = await connectClient();
  t.after(() => client.close());

  const missingPhase = await client.callTool({
    name: "project_status_list_tasks",
    arguments: { phase_id: "missing-phase", limit: 25, offset: 0 },
  });
  assert.equal(missingPhase.isError, true);
  assert.equal(missingPhase.structuredContent.ok, false);
  assert.equal(missingPhase.structuredContent.error.code, "phase_not_found");
  assert.match(missingPhase.structuredContent.error.nextAction, /without phase_id/);

  const missingTask = await client.callTool({
    name: "project_status_get_dependencies",
    arguments: { task_id: "missing-task", direction: "upstream", limit: 50, offset: 0 },
  });
  assert.equal(missingTask.isError, true);
  assert.equal(missingTask.structuredContent.error.code, "task_not_found");

  const missingTaskArgument = await client.callTool({
    name: "project_status_get_dependencies",
    arguments: { direction: "upstream", limit: 50, offset: 0 },
  });
  assert.equal(missingTaskArgument.isError, true);
  assert.equal(missingTaskArgument.structuredContent.error.code, "task_id_required");
});

test("MCP manifest resource is the core public projection and leaks no local paths or internal identities", async (t) => {
  const { client } = await connectClient();
  t.after(() => client.close());

  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((resource) => resource.uri), ["project-status://manifest"]);
  const result = await client.readResource({ uri: "project-status://manifest" });
  assert.equal(result.contents.length, 1);
  const text = result.contents[0].text;
  assert.equal(typeof text, "string");
  const manifest = JSON.parse(text);
  assert.equal(manifest.project, "Project Status");
  assert.equal(manifest.liveHealth.state, "unknown");
  assert.doesNotMatch(text, /\/Users\//);
  assert.doesNotMatch(text, /project-status-initiative:requirements-checklist/);
  assert.doesNotMatch(text, /dashboard-audit-agent/);
});
