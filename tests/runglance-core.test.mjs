import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTIVITY_TRUTH_CLASSES,
  createActivitySnapshot,
  createRunReceipt,
  normalizeActivityEvent,
  redactActivityEvent,
  reduceActivityEvents,
  renderActivity,
  renderRunReceipt,
  validateActivityEvent,
} from "../skill/runglance/scripts/runglance-core.mjs";

const startedAt = "2026-08-15T20:00:00.000Z";
const afterTwoSeconds = "2026-08-15T20:00:02.000Z";
const afterTenSeconds = "2026-08-15T20:00:10.000Z";
const clock = (value) => () => new Date(value);

function event(sequence, type, extra = {}) {
  return {
    schemaVersion: 1,
    eventId: `event-${sequence}`,
    sequence,
    sessionId: "run-1",
    observedAt: sequence === 1 ? startedAt : afterTwoSeconds,
    source: "test-adapter",
    type,
    ...extra,
  };
}

test("strict activity events reject unknown fields, invalid truth classes, and dishonest PASS results", () => {
  assert.deepEqual(ACTIVITY_TRUTH_CLASSES, ["exact", "derived", "estimated", "unknown"]);
  assert.equal(validateActivityEvent({ ...event(1, "entity.started", {
    entity: { kind: "thread", id: "primary" },
  }), readinessScore: 100 }).valid, false);

  assert.throws(() => normalizeActivityEvent(event(1, "entity.started", {
    entity: { kind: "thread", id: "primary" },
    metrics: { contextUsedPercent: { value: 12, truthClass: "reported", source: "host", observedAt: startedAt } },
  })), /truthClass/);

  assert.throws(() => normalizeActivityEvent(event(1, "verification.completed", {
    verification: {
      id: "test",
      name: "Tests",
      command: ["node", "--test"],
      status: "passed",
      exitCode: 1,
      durationMs: 5,
    },
  })), /requires exitCode 0/);
});

test("reducer creates exact determinate progress and keeps live activity separate from readiness", () => {
  const source = readFileSync(fileURLToPath(new URL("../skill/runglance/scripts/runglance-core.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /from ["'].+\/(?:core|status)\.mjs["']/);
  assert.doesNotMatch(source, /earnedWeight|totalWeight/);

  const state = reduceActivityEvents([
    event(1, "entity.started", {
      entity: { kind: "thread", id: "primary", name: "Task" },
      state: "running",
      progress: { completed: 2, total: 5 },
      metrics: {
        contextUsedPercent: { value: 41, truthClass: "exact", source: "host", observedAt: startedAt, unit: "percent" },
      },
    }),
    event(2, "entity.started", {
      entity: { kind: "agent", id: "reviewer", name: "Independent review", parentId: "primary" },
      state: "running",
    }),
  ]);
  const snapshot = createActivitySnapshot(state, { clock: clock(afterTwoSeconds) });
  assert.deepEqual(snapshot.progress, { mode: "determinate", completed: 2, total: 5, percent: 40 });
  assert.deepEqual(snapshot.usage.contextRemainingPercent, {
    value: 59,
    truthClass: "derived",
    source: "host:contextUsedPercent",
    observedAt: startedAt,
    unit: "percent",
  });
  assert.equal(snapshot.counts.agents, 1);
  assert.equal(snapshot.activeWork.length, 2);
  assert.equal(snapshot.finishedWork.length, 0);
  assert.equal(snapshot.lastReceipt, null);
  assert.equal("readiness" in snapshot, false);
});

test("finished work remains bounded and distinct from active work", () => {
  const events = [event(1, "entity.started", { entity: { kind: "thread", id: "primary" }, state: "running" })];
  let sequence = 2;
  for (let index = 0; index < 205; index += 1) {
    events.push(event(sequence++, "entity.started", { entity: { kind: "agent", id: `agent-${index}` }, state: "running" }));
    events.push(event(sequence++, "entity.completed", { entity: { kind: "agent", id: `agent-${index}` }, state: "completed" }));
  }
  const snapshot = createActivitySnapshot(reduceActivityEvents(events), { clock: clock(afterTwoSeconds) });
  assert.equal(snapshot.activeWork.length, 1);
  assert.equal(snapshot.finishedWork.length, 200);
  assert.ok(snapshot.finishedWork.every((item) => item.state === "completed"));
  assert.equal(snapshot.counts.agents, 0);
  assert.equal(createRunReceipt(snapshot).counts.agents, 205);
});

test("heartbeat staleness never invents a lock and only explicit lock events produce locked", () => {
  const running = reduceActivityEvents([
    event(1, "entity.started", { entity: { kind: "thread", id: "primary" }, state: "running", heartbeatAt: startedAt }),
  ]);
  const stale = createActivitySnapshot(running, { clock: clock(afterTenSeconds), staleAfterMs: 5_000 });
  assert.equal(stale.thread.state, "stale");
  assert.equal(stale.lock.state, "unknown");

  const lockedState = reduceActivityEvents([
    event(1, "entity.started", { entity: { kind: "thread", id: "primary" }, state: "running" }),
    event(2, "lock.acquired", { lock: { owner: "primary-agent" } }),
  ]);
  const locked = createActivitySnapshot(lockedState, { clock: clock(afterTwoSeconds) });
  assert.equal(locked.thread.state, "locked");
  assert.deepEqual(locked.lock, { state: "locked", owner: "primary-agent", observedAt: afterTwoSeconds });
});

test("renderer adapts by width, uses ASCII fallbacks, and marks estimated values", () => {
  const state = reduceActivityEvents([
    event(1, "entity.started", {
      entity: { kind: "thread", id: "primary" },
      state: "running",
      progress: { completed: 3, total: 10 },
      metrics: {
        contextRemainingPercent: { value: 55, truthClass: "estimated", source: "adapter", observedAt: startedAt },
      },
    }),
  ]);
  const snapshot = createActivitySnapshot(state, { clock: clock(afterTwoSeconds) });
  const narrow = renderActivity(snapshot, { width: 40, ascii: true, isTTY: true });
  assert.ok(narrow.length <= 40);
  assert.match(narrow, /C~55%/);
  const asciiLine = renderActivity(snapshot, { width: 60, ascii: true, isTTY: true });
  assert.match(asciiLine, /\[###-------\]/);
  const nonTty = renderActivity(snapshot, { preset: "diagnostic", width: 100, ascii: true, isTTY: false });
  assert.equal(nonTty.split("\n").length, 1);
  assert.doesNotMatch(nonTty, /\u001b/);
});

test("verified receipts are deterministic and unknown when no check completed", () => {
  const complete = reduceActivityEvents([
    event(1, "entity.started", { entity: { kind: "thread", id: "primary" }, state: "running" }),
    event(2, "verification.started", {
      verification: { id: "unit", name: "Unit tests", command: ["node", "--test"], status: "running" },
    }),
    { ...event(3, "verification.completed", {
      verification: { id: "unit", name: "Unit tests", command: ["node", "--test"], status: "passed", exitCode: 0, durationMs: 1_250, rerun: "node --test" },
    }), observedAt: afterTwoSeconds },
    { ...event(4, "run.outcome", {
      outcome: { status: "complete", summary: "Boundary fixed", fixes: ["Fixed the boundary"], remaining: ["External review"] },
    }), observedAt: afterTwoSeconds },
  ]);
  const snapshot = createActivitySnapshot(complete, { clock: clock(afterTwoSeconds) });
  const first = renderRunReceipt(snapshot, { format: "markdown" });
  const second = renderRunReceipt(snapshot, { format: "markdown" });
  assert.equal(first, second);
  assert.match(first, /PASS\s+Unit tests · exit 0 · 1\.3s/);
  assert.match(first, /Boundary fixed/);
  assert.match(first, /External review/);
  assert.match(first, /Task result: complete/);
  assert.match(first, /Project readiness: not assessed/);
  assert.deepEqual(snapshot.lastReceipt.projectReadiness, { status: "not_assessed", value: null, source: null });

  const noChecks = createActivitySnapshot(reduceActivityEvents([
    event(1, "entity.started", { entity: { kind: "thread", id: "primary" }, state: "running" }),
  ]), { clock: clock(afterTwoSeconds) });
  assert.match(renderRunReceipt(noChecks), /UNKNOWN  No verification was recorded/);
});

test("redaction removes credentials and private paths while bounding output", () => {
  const redacted = redactActivityEvent(event(1, "verification.completed", {
    verification: {
      id: "secrets",
      name: "Secret check",
      command: ["tool", "--token", "sk_test_12345678901234567890", "/Users/example/private/repo"],
      status: "passed",
      exitCode: 0,
      durationMs: 2,
      output: `Authorization: Bearer abcdefghijklmnop\nAPI_TOKEN=secret-value\n/Users/example/private/repo/file.txt\n${"x".repeat(20_000)}`,
    },
  }), { homeDirectory: "/Users/example", workingDirectory: "/Users/example/private/repo" });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /sk_test_|secret-value|\/Users\/example/);
  assert.match(serialized, /<redacted>|<home>|<cwd>/);
  assert.ok(redacted.verification.output.length <= 8_000);
});
