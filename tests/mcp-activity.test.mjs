import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mcpRequire = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { Client, InMemoryTransport } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href);
const { createProjectStatusServer } = await import(pathToFileURL(join(projectRoot, "packages", "mcp", "dist", "server.js")).href);
const { createActivityService, createConfiguredActivitySource } = await import(
  pathToFileURL(join(projectRoot, "packages", "mcp", "dist", "activity-adapter.js")).href
);
const manifest = JSON.parse(await readFile(join(projectRoot, ".project-status", "manifest.json"), "utf8"));

const timestamp = "2026-08-15T20:00:00.000Z";
const laterTimestamp = "2026-08-15T20:00:03.000Z";

function metric(value, truthClass = "exact", source = "host") {
  return { value, truthClass, source, observedAt: timestamp, unit: "percent" };
}

function entity(id, state, overrides = {}) {
  return {
    id,
    kind: "agent",
    name: `Agent ${id}`,
    parentId: "workflow-main",
    state,
    progress: state === "running" ? { completed: 1, total: 3 } : { completed: 3, total: 3 },
    metrics: {},
    startedAt: timestamp,
    completedAt: state === "completed" || state === "failed" || state === "stopped" ? laterTimestamp : null,
    heartbeatAt: laterTimestamp,
    updatedAt: laterTimestamp,
    ...overrides,
  };
}

function activityFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    generatedAt: laterTimestamp,
    thread: { state: "running", startedAt: timestamp },
    progress: { mode: "determinate", completed: 2, total: 5, percent: 40 },
    counts: { workflows: 1, skills: 1, agents: 2, tools: 1 },
    usage: {
      contextRemainingPercent: metric(61),
      quotaRemainingPercent: metric(82, "derived", "provider"),
      taskBudgetRemainingPercent: metric(null, "unknown", "orchestrator"),
    },
    lock: { state: "locked", owner: "session-1", observedAt: laterTimestamp },
    freshness: { heartbeatAt: laterTimestamp, ageSeconds: 0 },
    entities: [
      entity("agent-1", "running"),
      entity("agent-2", "waiting"),
      entity("agent-3", "completed"),
    ],
    verifications: [{
      id: "verify-1",
      name: "Project tests",
      command: ["npm", "test", "--token=sk-abcdefghijklmnopqrst"],
      status: "passed",
      exitCode: 0,
      durationMs: 820,
      output: "Bearer extremely-private-token /Users/alice/project",
      rerun: "cd /Users/alice/project && npm test",
      startedAt: timestamp,
      completedAt: laterTimestamp,
    }],
    outcome: {
      status: "complete",
      summary: "Fixed /Users/alice/project with sk-abcdefghijklmnopqrst",
      fixes: ["Corrected /Users/alice/project boundary"],
      remaining: [],
      observedAt: laterTimestamp,
    },
    lastReceipt: {
      schemaVersion: 1,
      sessionId: "session-1",
      completedAt: laterTimestamp,
      status: "complete",
      taskResult: "complete",
      projectReadiness: { status: "not_assessed", value: null, source: null },
      summary: "Fixed /Users/alice/project with sk-abcdefghijklmnopqrst",
      fixes: ["Corrected /Users/alice/project boundary"],
      verifications: [{
        id: "verify-1",
        name: "Project tests",
        status: "PASS",
        exitCode: 0,
        durationMs: 820,
        command: ["npm", "test", "--token=sk-abcdefghijklmnopqrst"],
        rerun: "cd /Users/alice/project && npm test",
      }],
      remaining: [],
      duration: "00:03",
      counts: { workflows: 0, skills: 0, agents: 3 },
    },
    capabilities: { context: true, locks: true, progress: true, verifications: true },
    prompt: "private prompt",
    transcript: "private transcript",
    toolArgs: { token: "TOPSECRET" },
    env: { API_KEY: "TOPSECRET" },
    ...overrides,
  };
}

async function connect(options) {
  const server = createProjectStatusServer({
    source: { load: async () => manifest },
    ...options,
  });
  const client = new Client(
    { name: "project-status-activity-test", version: "1.0.0" },
    {},
  );
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

test("MCP handshake lists additive read-only activity tools while existing readiness tools still work", async (t) => {
  const connection = await connect({ activitySource: { load: async () => activityFixture() } });
  t.after(() => connection.close());

  const { tools } = await connection.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "project_status_get_activity",
    "project_status_get_dependencies",
    "project_status_get_locks",
    "project_status_get_summary",
    "project_status_get_usage",
    "project_status_list_active_work",
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

  const summary = await connection.client.callTool({ name: "project_status_get_summary", arguments: {} });
  assert.equal(summary.structuredContent.ok, true);
  assert.equal(summary.structuredContent.score.totalWeight, 100);
  const tasks = await connection.client.callTool({
    name: "project_status_list_tasks",
    arguments: { status: "complete", limit: 1, offset: 0 },
  });
  assert.equal(tasks.structuredContent.ok, true);
  assert.equal(tasks.structuredContent.count, 1);
});

test("injected activity source serves truth-preserving summaries, paginated active and finished work, usage, and locks", async (t) => {
  const connection = await connect({ activitySource: { load: async () => activityFixture() } });
  t.after(() => connection.close());

  const activity = await connection.client.callTool({ name: "project_status_get_activity", arguments: {} });
  assert.equal(activity.isError, undefined);
  assert.equal(activity.structuredContent.ok, true);
  assert.equal(activity.structuredContent.thread.state, "running");
  assert.equal(activity.structuredContent.usage.contextRemainingPercent.truthClass, "exact");
  assert.equal(activity.structuredContent.usage.taskBudgetRemainingPercent.value, null);
  assert.equal(activity.structuredContent.lastReceipt.status, "complete");
  assert.equal(activity.structuredContent.lastReceipt.taskResult, "complete");
  assert.deepEqual(activity.structuredContent.lastReceipt.projectReadiness, {
    status: "not_assessed",
    value: null,
    source: null,
  });
  assert.deepEqual(activity.structuredContent.lastReceipt.verifications[0], {
    id: "verify-1",
    name: "Project tests",
    status: "PASS",
    exitCode: 0,
    durationMs: 820,
  });

  const firstPage = await connection.client.callTool({
    name: "project_status_list_active_work",
    arguments: { scope: "active", kind: "agent", limit: 1, offset: 0 },
  });
  assert.equal(firstPage.structuredContent.total, 2);
  assert.equal(firstPage.structuredContent.count, 1);
  assert.equal(firstPage.structuredContent.hasMore, true);
  assert.equal(firstPage.structuredContent.nextOffset, 1);

  const secondPage = await connection.client.callTool({
    name: "project_status_list_active_work",
    arguments: { scope: "active", kind: "agent", limit: 1, offset: 1 },
  });
  assert.equal(secondPage.structuredContent.count, 1);
  assert.equal(secondPage.structuredContent.hasMore, false);

  const finished = await connection.client.callTool({
    name: "project_status_list_active_work",
    arguments: { scope: "finished", state: "completed", limit: 25, offset: 0 },
  });
  assert.equal(finished.structuredContent.total, 1);
  assert.equal(finished.structuredContent.work[0].id, "agent-3");

  const usage = await connection.client.callTool({ name: "project_status_get_usage", arguments: {} });
  assert.equal(usage.structuredContent.usage.quotaRemainingPercent.truthClass, "derived");
  const locks = await connection.client.callTool({ name: "project_status_get_locks", arguments: {} });
  assert.equal(locks.structuredContent.count, 1);
  assert.equal(locks.structuredContent.locks[0].state, "locked");
});

test("missing activity state returns stable activity_unavailable without synthesizing zeros", async (t) => {
  const activitySource = {
    async load() {
      throw {
        code: "activity_unavailable",
        message: "No activity snapshot is available.",
        nextAction: "Start an activity adapter.",
      };
    },
  };
  const connection = await connect({ activitySource });
  t.after(() => connection.close());

  for (const name of [
    "project_status_get_activity",
    "project_status_list_active_work",
    "project_status_get_usage",
    "project_status_get_locks",
  ]) {
    const result = await connection.client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.structuredContent.error.code, "activity_unavailable");
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /"(?:workflows|skills|agents)":0/);
  }
  await assert.rejects(
    connection.client.readResource({ uri: "project-status://activity" }),
    /activity_unavailable/,
  );
});

test("configured file and runtime-directory sources resolve the canonical active snapshot", async () => {
  const runtime = await mkdtemp(join(tmpdir(), "project-status-mcp-activity-"));
  const snapshotPath = join(runtime, "activity-snapshot.json");
  await mkdir(runtime, { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(activityFixture({
    activeWork: [entity("canonical-active", "running")],
    finishedWork: [entity("canonical-finished", "completed")],
  })), "utf8");

  const runtimeService = createActivityService(createConfiguredActivitySource({
    environment: { PROJECT_STATUS_RUNTIME_DIR: runtime },
    cwd: projectRoot,
  }));
  const runtimeSnapshot = await runtimeService.load();
  assert.equal(runtimeSnapshot.thread.state, "running");
  assert.equal(runtimeSnapshot.activeWork[0].id, "canonical-active");
  assert.equal(runtimeSnapshot.finishedWork[0].id, "canonical-finished");

  const fileService = createActivityService(createConfiguredActivitySource({
    environment: { PROJECT_STATUS_ACTIVITY_FILE: snapshotPath },
    cwd: projectRoot,
  }));
  assert.equal((await fileService.load()).counts.agents, 2);
});

test("activity resource is bounded, separates active and finished work, and omits private source fields", async (t) => {
  const entities = [
    ...Array.from({ length: 120 }, (_, index) => entity(`active-${index}`, "running", {
      name: `Agent /Users/alice/project/${index} Bearer private-${index}`,
    })),
    ...Array.from({ length: 110 }, (_, index) => entity(`finished-${index}`, "completed")),
  ];
  const connection = await connect({ activitySource: { load: async () => activityFixture({ entities }) } });
  t.after(() => connection.close());

  const { resources } = await connection.client.listResources();
  assert.deepEqual(resources.map((resource) => resource.uri).sort(), [
    "project-status://activity",
    "project-status://manifest",
  ]);
  const result = await connection.client.readResource({ uri: "project-status://activity" });
  assert.equal(result.contents.length, 1);
  const text = result.contents[0].text;
  assert.equal(typeof text, "string");
  assert.equal(text.length < 128_000, true);
  const resource = JSON.parse(text);
  assert.equal(resource.activeWork.length, 50);
  assert.equal(resource.finishedWork.length, 50);
  assert.deepEqual(resource.bounds, {
    activeWorkTotal: 120,
    activeWorkTruncated: true,
    finishedWorkTotal: 110,
    finishedWorkTruncated: true,
  });
  assert.doesNotMatch(text, /\/Users\/alice|TOPSECRET|sk-abcdefghijklmnopqrst|private prompt|private transcript/);
  assert.doesNotMatch(text, /"(?:prompt|transcript|toolArgs|command|output|rerun|env)"/);
});
