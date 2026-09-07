import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPublicProjection } from "../packages/core/index.mjs";
import { mergeStatus, evidenceLabel } from "../src/status-adapter.js";

const manifest = JSON.parse(await readFile(new URL("../.project-status/manifest.json", import.meta.url), "utf8"));

test("bundled, empty, expired and stale snapshots never claim fresh evidence", () => {
  const current = { audit: { verificationState: "current", staleAt: "2026-09-08T00:00:00.000Z" }, evidenceSummary: { total: 1, stale: 0 } };
  const now = Date.parse("2026-09-07T00:00:00.000Z");
  assert.equal(evidenceLabel(current, "fallback", now), "Bundled snapshot");
  assert.equal(evidenceLabel(current, "loaded", now), "Snapshot current");
  assert.equal(evidenceLabel(current, "loaded", now + 172800000), "Review needed");
  assert.equal(evidenceLabel({ ...current, evidenceSummary: { total: 0, stale: 0 } }, "loaded", now), "No evidence");
  assert.equal(evidenceLabel({ ...current, audit: { verificationState: "stale_audit" } }, "loaded", now), "Review needed");
});

test("dashboard keeps optional delivery scope and does not invent it", () => {
  const projection = createPublicProjection(manifest, { now: manifest.audit.evidenceAsOf });
  projection.delivery = { schemaVersion: 1, stages: [{ id: "alpha", percent: 25 }] };
  assert.deepEqual(mergeStatus(projection, null).delivery, projection.delivery);
  delete projection.delivery;
  assert.equal(mergeStatus(projection, null).delivery, null);
});

test("dashboard adapter consumes the canonical public projection without losing score or phase credit", () => {
  const projection = createPublicProjection(manifest, { now: new Date(manifest.audit.evidenceAsOf) });
  const status = mergeStatus(projection, null);

  assert.equal(status.score.earnedWeight, 61);
  assert.equal(status.score.totalWeight, 100);
  assert.equal(status.score.displayPercent, 61);
  assert.deepEqual(status.phases.map((phase) => phase.earnedWeight), [25, 21, 15]);
  assert.equal(status.phases.flatMap((phase) => phase.tasks).length, 16);
  assert.equal(status.source.manifestSha256, projection.provenance.canonicalManifestSha256);
  assert.ok(status.nextActions[0].name.length > 0);
  assert.notEqual(status.criticalPath.earliestReady, "2026-09-03");
});

test("monitor state stays separate from weighted readiness", () => {
  const projection = createPublicProjection(manifest, { now: new Date(manifest.audit.evidenceAsOf) });
  const status = mergeStatus(projection, {
    state: "degraded",
    consecutiveFailures: 2,
    checks: [{ id: "dashboard", name: "Dashboard", state: "unhealthy", detail: "HTTP 500" }],
  });

  assert.equal(status.monitoring.state, "degraded");
  assert.equal(status.monitoring.checks[0].state, "unhealthy");
  assert.equal(status.score.earnedWeight, 61);
});

test("dashboard adapter consumes the public persisted-monitor API shape", () => {
  const projection = createPublicProjection(manifest, { now: new Date(manifest.audit.evidenceAsOf) });
  const status = mergeStatus(projection, {
    status: "failing",
    lastAttemptAt: "2026-08-12T18:00:01.000Z",
    lastSuccessAt: "2026-08-12T17:59:01.000Z",
    nextDueAt: "2026-08-12T18:01:01.000Z",
    summary: { maxConsecutiveFailures: 2 },
    checks: [{ name: "Public API", status: "failing", ok: false, failureCode: "network_error" }],
  });

  assert.equal(status.monitoring.state, "unhealthy");
  assert.equal(status.monitoring.lastScheduledAt, "2026-08-12T18:00:01.000Z");
  assert.equal(status.monitoring.consecutiveFailures, 2);
  assert.equal(status.monitoring.checks[0].id, "monitor-check-1");
  assert.equal(status.monitoring.checks[0].state, "unhealthy");
  assert.equal(status.monitoring.checks[0].detail, "Failure: network error");
  assert.equal(status.score.earnedWeight, 61);
});

test("the current dashboard distinguishes complete, partial, and withheld local-release work", () => {
  const projection = createPublicProjection(manifest, { now: new Date(manifest.audit.evidenceAsOf) });
  const status = mergeStatus(projection, null);
  const tasks = status.phases.flatMap((phase) => phase.tasks);

  assert.equal(tasks.filter((task) => task.status === "complete").length, 10);
  assert.equal(tasks.filter((task) => task.status === "in_progress").length, 3);
  assert.equal(tasks.filter((task) => task.status === "blocked").length, 0);
  assert.equal(tasks.filter((task) => task.status === "not_started").length, 3);
  assert.equal(status.blockers.length, 3);
  assert.equal(status.initiativeState, "active");
});
