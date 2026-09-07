import assert from "node:assert/strict";
import test from "node:test";
import { mapHostActivity } from "../skill/runglance/scripts/runglance-adapter.mjs";
import { createActivitySnapshot, reduceActivityEvents, renderActivity } from "../skill/runglance/scripts/runglance-core.mjs";

const now = "2026-09-07T20:00:00.000Z";
const payload = (item) => ({ method: "item/completed", params: { threadId: "run", item } });

test("ordinary assistant messages do not create work entities", () => {
  assert.deepEqual(mapHostActivity("codex-app-server", payload({ id: "message", type: "agentMessage" })), []);
});

test("a collaboration tool call is not evidence of a spawned agent", () => {
  const [event] = mapHostActivity("codex-app-server", payload({ id: "call", type: "collabAgentToolCall" }));
  assert.equal(event.entity.kind, "tool");
});

test("a completed command with a nonzero exit code reports failure", () => {
  const [event] = mapHostActivity("codex-app-server", payload({ id: "check", type: "commandExecution", status: "completed", exitCode: 1 }));
  assert.equal(event.state, "failed");
  assert.equal(event.type, "entity.failed");
});

function snapshot(progress) {
  return createActivitySnapshot(reduceActivityEvents([{
    schemaVersion: 1, eventId: "start", sequence: 1, sessionId: "run", observedAt: now,
    source: "test", type: "entity.started", state: "running",
    entity: { kind: "agent", id: "lane", name: "Independent review" }, progress,
  }]), { clock: () => new Date(now) });
}

test("an explicit swarm request preserves its lanes without a TTY", () => {
  const output = renderActivity(snapshot({ completed: 1, total: 2 }), { preset: "swarm", isTTY: false, ascii: true });
  assert.match(output, /Independent review/);
  assert.match(output, /50%/);
  assert.doesNotMatch(output, /\u001b/);
});

test("a zero task denominator never renders an invented zero percent", () => {
  const output = renderActivity(snapshot({ completed: 0, total: 0 }), { preset: "swarm", ascii: true });
  assert.doesNotMatch(output, /\b0%/);
  assert.match(output, /unknown/i);
});
