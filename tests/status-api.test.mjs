import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createPublicActivityProjection,
  createPublicMonitorProjection,
  handleStatusRequest,
} from "../worker/status-api.js";

const manifest = JSON.parse(await readFile(new URL("../.project-status/manifest.json", import.meta.url), "utf8"));

const monitorRecord = {
  schemaVersion: 1,
  recordType: "project_status_monitor_run",
  environment: "production",
  startedAt: "2026-08-12T18:00:00.000Z",
  completedAt: "2026-08-12T18:00:01.000Z",
  nextDueAt: "2026-08-12T18:01:01.000Z",
  cadenceSeconds: 60,
  status: "failing",
  transition: "degraded",
  lastSuccessAt: "2026-08-12T17:59:01.000Z",
  lastFailureAt: "2026-08-12T18:00:01.000Z",
  recoveredAt: null,
  summary: { total: 1, healthy: 0, failing: 1, recovered: 0, maxConsecutiveFailures: 2 },
  checks: [{
    id: "internal-probe-id",
    name: "Public API",
    url: "https://secret-token.example.com/health?token=do-not-leak",
    attemptedAt: "2026-08-12T18:00:00.000Z",
    completedAt: "2026-08-12T18:00:01.000Z",
    durationMs: 1000,
    redirectCount: 0,
    ok: false,
    outcome: "network_error",
    failure: { code: "network_error", message: "connect /Users/private/socket EACCES" },
    statusCode: null,
    bytesRead: 0,
    state: "failing",
    consecutiveFailures: 2,
    transition: null,
    lastSuccessAt: "2026-08-12T17:59:01.000Z",
    lastFailureAt: "2026-08-12T18:00:01.000Z",
    recoveredAt: null,
  }],
};

const activityRecord = {
  schemaVersion: 1,
  generatedAt: "2026-08-12T18:00:05.000Z",
  thread: { state: "running", startedAt: "2026-08-12T18:00:00.000Z" },
  progress: { mode: "determinate", completed: 2, total: 4, percent: 1 },
  counts: { workflows: 1, skills: 1, agents: 2 },
  usage: {
    contextRemainingPercent: { value: 72, truthClass: "exact", source: "codex", observedAt: "2026-08-12T18:00:05.000Z", unit: "%" },
    quotaRemainingPercent: { value: null, truthClass: "unknown", source: "unknown", observedAt: null, unit: "%" },
    taskBudgetRemainingPercent: { value: 50, truthClass: "derived", source: "task-budget", observedAt: "2026-08-12T18:00:05.000Z", unit: "%" },
  },
  lock: { state: "locked", owner: null, heartbeatAt: "2026-08-12T18:00:04.000Z" },
  freshness: { heartbeatAt: "2026-08-12T18:00:04.000Z", ageSeconds: 900 },
  capabilities: { "adapter.codex": true, "bad key": true },
  work: [
    { id: "agent-1", kind: "agent", label: "Implement /Users/alice/private with sk-testsecret123", state: "running", elapsedSeconds: 4 },
    { id: "agent-2", kind: "agent", label: "Run tests", state: "completed", elapsedSeconds: 3 },
  ],
  lastReceipt: {
    status: "partial",
    title: "Task result",
    summary: "Fixed /Users/alice/private",
    fixes: ["Removed Bearer abcdefghijklmnop"],
    verification: [{ name: "node --test", state: "passed", exitCode: 0, durationSeconds: 1.2 }],
    remaining: ["Owner decision"],
  },
};

test("manifest endpoint serves the deterministic core public projection with cache validators", async () => {
  const request = new Request("https://status.example.com/status/manifest");
  const first = await handleStatusRequest(request, { manifest });
  const second = await handleStatusRequest(request, { manifest });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=300");
  assert.equal(first.headers.get("etag"), second.headers.get("etag"));
  assert.deepEqual(await first.json(), await second.json());

  const conditional = await handleStatusRequest(new Request(request, {
    headers: { "if-none-match": second.headers.get("etag") },
  }), { manifest });
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
});

test("manifest projection omits local and conversation locators plus owner/verifier internal IDs", async () => {
  const response = await handleStatusRequest(new Request("https://status.example.com/status/manifest"), { manifest });
  const body = await response.text();
  assert.doesNotMatch(body, /\/Users\//);
  assert.doesNotMatch(body, /project-status-initiative:requirements-checklist/);
  assert.doesNotMatch(body, /dashboard-audit-agent/);
  assert.doesNotMatch(body, /initiative-architect\"/);
});

test("live status is an allowlisted view of persisted state and never exposes IDs, URLs, or raw errors", async () => {
  let reads = 0;
  const response = await handleStatusRequest(new Request("https://status.example.com/api/status"), {
    readLatestMonitorState: async () => {
      reads += 1;
      return monitorRecord;
    },
    now: "2026-08-12T18:00:31.000Z",
  });
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.equal(response.headers.get("cache-control"), "public, max-age=15, stale-while-revalidate=45");
  const body = await response.text();
  const parsed = JSON.parse(body);
  assert.equal(parsed.status, "failing");
  assert.equal(parsed.cacheAgeSeconds, 30);
  assert.equal(parsed.checks[0].failureCode, "network_error");
  assert.doesNotMatch(body, /internal-probe-id/);
  assert.doesNotMatch(body, /secret-token/);
  assert.doesNotMatch(body, /do-not-leak/);
  assert.doesNotMatch(body, /\/Users\//);
  assert.doesNotMatch(body, /EACCES/);
});

test("staleness is derived from injected time while the recorded health remains explicit", () => {
  const projection = createPublicMonitorProjection(monitorRecord, {
    now: "2026-08-12T18:01:02.000Z",
  });
  assert.equal(projection.stale, true);
  assert.equal(projection.status, "stale");
  assert.equal(projection.recordedStatus, "failing");
  assert.equal(projection.nextDueAt, monitorRecord.nextDueAt);
});

test("HEAD and method handling do not accidentally read monitor state", async () => {
  let reads = 0;
  const readLatestMonitorState = async () => {
    reads += 1;
    return monitorRecord;
  };
  const head = await handleStatusRequest(new Request("https://status.example.com/api/status", { method: "HEAD" }), {
    readLatestMonitorState,
    now: "2026-08-12T18:00:31.000Z",
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(reads, 1);

  const post = await handleStatusRequest(new Request("https://status.example.com/api/status", { method: "POST" }), {
    readLatestMonitorState,
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.equal(reads, 1);
});

test("missing state is a cache-disabled 503 and unrelated routes delegate without reads", async () => {
  let reads = 0;
  const readLatestMonitorState = async () => {
    reads += 1;
    return null;
  };
  const missing = await handleStatusRequest(new Request("https://status.example.com/api/status"), {
    readLatestMonitorState,
  });
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missing.json(), { schemaVersion: 1, error: "monitor_state_unavailable" });

  const unrelated = await handleStatusRequest(new Request("https://status.example.com/"), {
    readLatestMonitorState,
  });
  assert.equal(unrelated, null);
  assert.equal(reads, 1);
});

test("activity endpoint projects fresh Running, Finished, usage, locks, and receipt state without private content", async () => {
  const response = await handleStatusRequest(new Request("https://status.example.com/api/activity"), {
    latestActivityState: activityRecord,
    now: "2026-08-12T18:00:06.000Z",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  const projection = JSON.parse(body);
  assert.equal(projection.progress.percent, 50, "determinate progress is derived from exact counts");
  assert.equal(projection.freshness.ageSeconds, 2, "freshness is derived from the injected clock");
  assert.equal(projection.lock.state, "unknown", "a lock without an explicit owner is never affirmative");
  assert.equal(projection.activeWork.length, 1);
  assert.equal(projection.finishedWork.length, 1);
  assert.equal(projection.lastReceipt.taskResult, "partial");
  assert.equal(projection.lastReceipt.projectReadiness.status, "not_assessed");
  assert.equal(projection.lastReceipt.verifications[0].status, "PASS");
  assert.deepEqual(projection.capabilities, { "adapter.codex": true });
  assert.doesNotMatch(body, /\/Users\/alice/);
  assert.doesNotMatch(body, /testsecret/);
  assert.doesNotMatch(body, /abcdefghijklmnop/);
});

test("activity endpoint accepts the canonical runtime entity and receipt shapes", async () => {
  const canonical = {
    ...activityRecord,
    counts: { workflows: 1, skills: 0, agents: 1, tools: 2 },
    activeWork: [{
      id: "workflow-1",
      kind: "workflow",
      name: "Build package",
      parentId: "primary",
      state: "running",
      progress: { completed: 3, total: 4 },
      startedAt: "2026-08-12T18:00:00.000Z",
      updatedAt: "2026-08-12T18:00:05.000Z",
      completedAt: null,
    }],
    finishedWork: [],
    lock: { state: "unlocked", owner: null, observedAt: "2026-08-12T18:00:05.000Z" },
    lastReceipt: {
      status: "complete",
      taskResult: "complete",
      projectReadiness: { status: "not_assessed", value: null, source: null },
      summary: "Boundary fixed",
      fixes: ["Applied fix"],
      verifications: [{ name: "Unit tests", status: "PASS", exitCode: 0, durationMs: 25, rerun: "private command" }],
      remaining: [],
      duration: "00:05",
      completedAt: "2026-08-12T18:00:05.000Z",
    },
  };
  const projection = createPublicActivityProjection(canonical, { now: "2026-08-12T18:00:06.000Z" });
  assert.equal(projection.activeWork[0].label, "Build package");
  assert.equal(projection.activeWork[0].progress.percent, 75);
  assert.equal(projection.counts.tools, 2);
  assert.equal(projection.lock.observedAt, "2026-08-12T18:00:05.000Z");
  assert.equal(projection.lastReceipt.verifications[0].durationMs, 25);
  assert.equal(JSON.stringify(projection).includes("private command"), false);
});

test("activity projection keeps estimates explicit and missing state is an actionable no-store 503", async () => {
  const projected = createPublicActivityProjection({
    ...activityRecord,
    usage: {
      ...activityRecord.usage,
      quotaRemainingPercent: {
        value: 31,
        truthClass: "estimated",
        source: "operator-opt-in",
        observedAt: "2026-08-12T18:00:05.000Z",
      },
    },
  }, { now: "2026-08-12T18:00:06.000Z" });
  assert.equal(projected.usage.quotaRemainingPercent.truthClass, "estimated");
  assert.equal(projected.usage.contextRemainingPercent.truthClass, "exact");

  const missing = await handleStatusRequest(new Request("https://status.example.com/api/activity"), {});
  assert.equal(missing.status, 503);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.deepEqual(await missing.json(), { schemaVersion: 1, error: "activity_state_unavailable" });
});
