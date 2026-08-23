import assert from "node:assert/strict";
import test from "node:test";
import {
  countLabel,
  formatDuration,
  metricLabel,
  normalizeActivity,
} from "../src/activity-model.js";

test("missing activity remains explicitly unavailable without fabricated counts or usage", () => {
  const activity = normalizeActivity(null);

  assert.equal(activity.available, false);
  assert.deepEqual(activity.counts, { workflows: null, skills: null, agents: null });
  assert.equal(activity.usage.contextRemainingPercent.value, null);
  assert.equal(activity.lock.state, "unknown");
  assert.deepEqual(activity.activeWork, []);
  assert.equal(activity.lastReceipt, null);
  assert.equal(countLabel(activity.counts.agents), "—");
  assert.equal(metricLabel(activity.usage.contextRemainingPercent), "—");
});

test("activity normalization keeps exact, estimated, agent, freshness, and receipt truth separate", () => {
  const activity = normalizeActivity({
    generatedAt: "2026-08-15T20:00:00.000Z",
    thread: { state: "running", startedAt: "2026-08-15T19:58:00.000Z" },
    progress: { completed: 3, total: 4 },
    counts: { workflows: 1, skills: 2, agents: 3 },
    usage: {
      contextRemainingPercent: { value: 41, truthClass: "exact", source: "host" },
      quotaRemainingPercent: { value: 82.2, truthClass: "estimated", source: "client" },
    },
    lock: { state: "locked", owner: "verification" },
    activeWork: [{
      id: "agent-1",
      kind: "agent",
      name: "Run accessibility tests",
      state: "in_progress",
      progress: { percent: 60 },
      duration: 92,
      toolUses: 4,
    }],
    finishedWork: [{ id: "check-1", kind: "tool", name: "Build", status: "complete", durationSeconds: 18 }],
    lastReceipt: {
      id: "receipt-1",
      mode: "verified",
      title: "Boundary fixed; status check working",
      summary: "Replaced the placeholder with an evidence-backed manifest.",
      taskResult: "Complete",
      projectReadiness: "17/100",
      verifications: [{ name: "Manifest validation", exitCode: 0, duration: 0.8 }],
      rerunCommand: "project-status summary . --markdown",
      remaining: ["Identity decision remains blocked."],
      duration: 258,
    },
  }, { now: new Date("2026-08-15T20:00:03.000Z") });

  assert.equal(activity.available, true);
  assert.equal(activity.progress.percent, 75);
  assert.equal(activity.freshness.ageSeconds, 3);
  assert.equal(activity.activeWork[0].state, "running");
  assert.equal(activity.activeWork[0].durationSeconds, 92);
  assert.equal(activity.finishedWork[0].state, "completed");
  assert.equal(activity.usage.contextRemainingPercent.truthClass, "exact");
  assert.equal(metricLabel(activity.usage.quotaRemainingPercent), "~82% left");
  assert.equal(activity.lastReceipt.mode, "verified");
  assert.equal(activity.lastReceipt.readiness, "17/100");
  assert.equal(activity.lastReceipt.verifications[0].status, "passed");
  assert.deepEqual(activity.lastReceipt.rerunCommands, ["project-status summary . --markdown"]);
  assert.equal(formatDuration(activity.lastReceipt.durationSeconds), "4:18");
  assert.equal(formatDuration(0.8), "800ms");
});

test("legacy reported metrics are accepted but normalized to the canonical exact truth class", () => {
  const activity = normalizeActivity({
    thread: { state: "ready" },
    counts: {},
    usage: { contextRemainingPercent: { value: 73, truthClass: "reported" } },
  });

  assert.equal(activity.thread.state, "ready");
  assert.equal(activity.usage.contextRemainingPercent.truthClass, "exact");
  assert.equal(metricLabel(activity.usage.contextRemainingPercent), "73% left");
});

test("public activity projection receipt fields retain verification and non-assessed readiness", () => {
  const activity = normalizeActivity({
    thread: { state: "ready" },
    progress: { mode: "unavailable", completed: null, total: null, percent: null },
    counts: { workflows: 0, skills: 0, agents: 0 },
    lastReceipt: {
      status: "complete",
      title: "Status check working",
      projectReadiness: { status: "not_assessed", value: null, source: null },
      verification: [{ name: "Unit tests", state: "passed", exitCode: 0, durationSeconds: 1.2 }],
      remaining: [],
      duration: "4m 18s",
    },
  });

  assert.equal(activity.lastReceipt.taskResult, "complete");
  assert.equal(activity.lastReceipt.readiness, "Not assessed");
  assert.equal(activity.lastReceipt.verifications[0].status, "passed");
  assert.equal(activity.lastReceipt.durationLabel, "4m 18s");
});
