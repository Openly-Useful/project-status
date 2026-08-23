import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpRequire = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { Client, InMemoryTransport } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href);
const { createRunGlanceServer } = await import(
  pathToFileURL(join(projectRoot, "packages", "mcp", "dist", "runglance-server.js")).href
);
const { createActivityService, createConfiguredActivitySource } = await import(
  pathToFileURL(join(projectRoot, "packages", "mcp", "dist", "activity-adapter.js")).href
);

const startedAt = "2026-08-15T20:00:00.000Z";
const generatedAt = "2026-08-15T20:00:03.000Z";

function metric(value, truthClass, source) {
  return { value, truthClass, source, observedAt: generatedAt, unit: "percent" };
}

function entity(id, state) {
  const terminal = ["completed", "failed", "stopped"].includes(state);
  return {
    id,
    kind: "agent",
    name: `Agent ${id}`,
    parentId: "primary",
    state,
    progress: terminal ? { completed: 1, total: 1 } : { completed: 1, total: 3 },
    metrics: {},
    startedAt,
    completedAt: terminal ? generatedAt : null,
    heartbeatAt: generatedAt,
    updatedAt: generatedAt,
  };
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: "run-1",
    generatedAt,
    thread: { state: "locked", startedAt },
    progress: { mode: "determinate", completed: 2, total: 5, percent: 40 },
    counts: { workflows: 1, skills: 1, agents: 2, tools: 1 },
    usage: {
      contextRemainingPercent: metric(61, "exact", "host"),
      quotaRemainingPercent: metric(82, "derived", "provider"),
      taskBudgetRemainingPercent: metric(null, "unknown", "orchestrator"),
    },
    lock: { state: "locked", owner: "primary", observedAt: generatedAt },
    freshness: { heartbeatAt: generatedAt, ageSeconds: 0 },
    entities: [entity("active", "running"), entity("done", "completed")],
    activeWork: [entity("active", "running")],
    finishedWork: [entity("done", "completed")],
    verifications: [],
    outcome: null,
    lastReceipt: null,
    capabilities: { context: true, locks: true, progress: true, verifications: true },
    prompt: "private prompt",
    env: { API_TOKEN: "secret" },
    ...overrides,
  };
}

async function connect(activitySource = { load: async () => snapshot() }) {
  const server = createRunGlanceServer({ activitySource });
  const client = new Client({ name: "runglance-test", version: "1.0.0" }, {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("RunGlance MCP exposes only focused read-only status tools", async (t) => {
  const connection = await connect();
  t.after(() => connection.close());
  const { tools } = await connection.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "runglance_get_locks",
    "runglance_get_status",
    "runglance_get_usage",
    "runglance_list_work",
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
});

test("RunGlance MCP preserves truth classes, lock state, pagination, and private-field redaction", async (t) => {
  const connection = await connect();
  t.after(() => connection.close());

  const status = await connection.client.callTool({ name: "runglance_get_status", arguments: {} });
  assert.equal(status.structuredContent.thread.state, "locked");
  assert.equal(status.structuredContent.progress.percent, 40);
  assert.equal(status.structuredContent.usage.contextRemainingPercent.truthClass, "exact");
  assert.equal(status.structuredContent.usage.taskBudgetRemainingPercent.value, null);

  const work = await connection.client.callTool({
    name: "runglance_list_work",
    arguments: { scope: "all", kind: "agent", limit: 1, offset: 0 },
  });
  assert.equal(work.structuredContent.total, 2);
  assert.equal(work.structuredContent.count, 1);
  assert.equal(work.structuredContent.hasMore, true);
  assert.equal(work.structuredContent.nextOffset, 1);

  const locks = await connection.client.callTool({ name: "runglance_get_locks", arguments: {} });
  assert.equal(locks.structuredContent.locks[0].state, "locked");
  const usage = await connection.client.callTool({ name: "runglance_get_usage", arguments: {} });
  assert.equal(usage.structuredContent.usage.quotaRemainingPercent.truthClass, "derived");

  const { resources } = await connection.client.listResources();
  assert.deepEqual(resources.map((resource) => resource.uri), ["runglance://status"]);
  const resource = await connection.client.readResource({ uri: "runglance://status" });
  const text = resource.contents[0].text;
  assert.doesNotMatch(text, /private prompt|API_TOKEN|secret|"(?:prompt|env|command|output|rerun)"/);
});

test("RunGlance environment aliases locate the local snapshot and bundled CLI exposes help", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "runglance-mcp-"));
  await writeFile(join(runtime, "activity-snapshot.json"), JSON.stringify(snapshot()), "utf8");
  const service = createActivityService(createConfiguredActivitySource({
    environment: { RUNGLANCE_RUNTIME_DIR: runtime },
    cwd: projectRoot,
  }));
  assert.equal((await service.load()).sessionId, "run-1");

  const result = spawnSync(process.execPath, [
    join(projectRoot, "packages", "mcp", "dist", "runglance-index.js"),
    "--help",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Usage: runglance-mcp [--snapshot <path>]\n");
});
