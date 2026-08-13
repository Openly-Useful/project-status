import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  executeMonitorRun,
  JsonlRunStore,
  MemoryRunStore,
  readLatestRun,
  recordRun,
  runAndRecord,
} from "../packages/monitor/index.mjs";

const config = {
  environment: "production",
  cadenceSeconds: 60,
  targets: [{
    id: "api-health",
    name: "Public API",
    url: "https://status.example.com/health",
  }],
};

function probeResult(target, ok, at) {
  return {
    id: target.id,
    name: target.name,
    url: target.url,
    attemptedAt: at,
    completedAt: at,
    durationMs: 10,
    redirectCount: 0,
    ok,
    outcome: ok ? "success" : "network_error",
    failure: ok ? null : { code: "network_error", message: "Probe failed before receiving a complete HTTP response." },
    statusCode: ok ? 200 : null,
    bytesRead: ok ? 2 : 0,
  };
}

test("runAndRecord tracks consecutive failures and a recovery across durable snapshots", async () => {
  const store = new MemoryRunStore();
  let now = new Date("2026-08-12T18:00:00.000Z");
  const outcomes = [false, false, true];
  let probeCalls = 0;
  const probe = async (target) => probeResult(target, outcomes[probeCalls++], now.toISOString());

  const first = await runAndRecord(config, { store, probe, clock: () => now });
  assert.equal(first.status, "failing");
  assert.equal(first.checks[0].consecutiveFailures, 1);
  assert.equal(first.checks[0].transition, "failed");
  assert.equal(first.checks[0].lastSuccessAt, null);
  assert.equal(first.lastSuccessAt, null);
  assert.equal(first.lastFailureAt, first.completedAt);

  now = new Date("2026-08-12T18:01:00.000Z");
  const second = await runAndRecord(config, { store, probe, clock: () => now });
  assert.equal(second.checks[0].consecutiveFailures, 2);
  assert.equal(second.checks[0].transition, null);

  now = new Date("2026-08-12T18:02:00.000Z");
  const recovered = await runAndRecord(config, { store, probe, clock: () => now });
  assert.equal(recovered.status, "healthy");
  assert.equal(recovered.summary.recovered, 1);
  assert.equal(recovered.checks[0].consecutiveFailures, 0);
  assert.equal(recovered.checks[0].transition, "recovered");
  assert.equal(recovered.checks[0].recoveredAt, now.toISOString());
  assert.equal(recovered.checks[0].lastFailureAt, second.completedAt);
  assert.equal(recovered.transition, "recovered");
  assert.equal(recovered.lastSuccessAt, recovered.completedAt);
  assert.equal(recovered.recoveredAt, recovered.completedAt);
  assert.equal(store.size, 3);
});

test("read operations never execute probes or append records", async () => {
  const store = new MemoryRunStore();
  let probeCalls = 0;
  const probe = async (target) => {
    probeCalls += 1;
    return probeResult(target, true, "2026-08-12T18:00:00.000Z");
  };
  const record = await executeMonitorRun(config, {
    probe,
    clock: () => new Date("2026-08-12T18:00:00.000Z"),
  });
  assert.equal(probeCalls, 1);
  assert.equal(store.size, 0);

  await recordRun(store, record);
  assert.equal(store.size, 1);
  const latest = await readLatestRun(store);
  assert.deepEqual(latest, record);
  assert.equal(probeCalls, 1);
  assert.equal(store.size, 1);
});

test("JsonlRunStore appends one fsynced JSON record per line and preserves prior history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-status-monitor-"));
  const historyPath = join(directory, "runs.jsonl");
  const store = new JsonlRunStore(historyPath);
  const first = await executeMonitorRun(config, {
    probe: async (target) => probeResult(target, false, "2026-08-12T18:00:00.000Z"),
    clock: () => new Date("2026-08-12T18:00:00.000Z"),
  });
  const second = await executeMonitorRun(config, {
    previousRun: first,
    probe: async (target) => probeResult(target, true, "2026-08-12T18:01:00.000Z"),
    clock: () => new Date("2026-08-12T18:01:00.000Z"),
  });

  await recordRun(store, first);
  const before = await readFile(historyPath, "utf8");
  await recordRun(store, second);
  const after = await readFile(historyPath, "utf8");

  assert.ok(after.startsWith(before));
  const lines = after.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), first);
  assert.deepEqual(JSON.parse(lines[1]), second);
  assert.deepEqual(await store.readLatest(), second);
  assert.deepEqual(await store.readHistory({ limit: 2 }), [second, first]);
});

test("runner bounds target count and concurrency before any probe executes", async () => {
  let calls = 0;
  await assert.rejects(
    executeMonitorRun({ ...config, maxConcurrency: 11 }, { probe: async () => { calls += 1; } }),
    /maxConcurrency/,
  );
  await assert.rejects(
    executeMonitorRun({ ...config, targets: Array(51).fill(config.targets[0]) }, { probe: async () => { calls += 1; } }),
    /between 1 and 50/,
  );
  assert.equal(calls, 0);
});
