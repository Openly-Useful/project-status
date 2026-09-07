import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as core from "../packages/core/index.mjs";
import * as portable from "../skill/project-status/scripts/core.mjs";

const base = JSON.parse(readFileSync(new URL("../.project-status/manifest.json", import.meta.url), "utf8"));
const now = base.audit.evidenceAsOf;
function fixture() {
  const m = structuredClone(base);
  const tasks = m.phases.flatMap(p => p.tasks);
  const done = tasks.find(t => t.status === "complete");
  const open = tasks.find(t => t.status === "not_started");
  const third = tasks.find(t => t.status === "in_progress");
  m.delivery = { schemaVersion: 1, activeStage: "alpha", nextMilestoneId: "integrated", milestones: [
    { id: "integrated", name: "Integrated result", taskRefs: [done.id, open.id] },
  ], stages: [
    { id: "alpha", name: "Alpha", taskRefs: [done.id], milestoneRefs: [] },
    { id: "beta", name: "Beta", taskRefs: [open.id, done.id], milestoneRefs: ["integrated"] },
    { id: "live", name: "Live launch", taskRefs: [third.id], milestoneRefs: [] },
  ] };
  return { m, done, open, third };
}

test("cumulative stages reuse accepted work once and expose remaining tasks and milestones", () => {
  const {m, done, open, third} = fixture();
  const result = core.calculateStatus(m, {now}).delivery;
  assert.equal(result.stages[0].percent, 100);
  assert.equal(result.stages[1].percent, done.weight / (done.weight + open.weight) * 100);
  assert.equal(result.stages[2].percent, done.weight / (done.weight + open.weight + third.weight) * 100);
  assert.equal(result.stages[1].remainingTasks, 1);
  assert.equal(result.stages[2].remainingMilestones, 1);
  assert.equal(result.nextMilestone.remainingTasks, 1);
  assert.equal(result.gaps.find(g => g.id === open.id).nextAction, open.nextAction);
  assert.deepEqual(portable.calculateStatus(m, {now}).delivery, result);
  assert.deepEqual(core.createPublicProjection(m, {now}).delivery, result);
  assert.deepEqual(portable.createPublicProjection(m, {now}).delivery, result);
});

test("old manifests remain valid and do not invent stage scope", () => {
  assert.equal(core.validateManifest(base).valid, true);
  assert.equal(core.calculateStatus(base, {now}).delivery, null);
});

test("rounding cannot display 100 while an acceptance gap remains", () => {
  const {m, done, open} = fixture();
  done.weight = done.weight + open.weight - 0.001;
  done.earnedWeight = done.weight;
  open.weight = 0.001;
  const stage = core.calculateStatus(m, {now}).delivery.stages[1];
  assert.ok(stage.percent > 99.9);
  assert.equal(stage.displayPercent, 99);
  assert.equal(stage.remainingTasks, 1);
});

test("empty configured stage scope stays unknown", () => {
  const {m} = fixture();
  m.delivery.stages = [{id:"alpha", name:"Alpha", taskRefs:[], milestoneRefs:[]}];
  m.delivery.milestones = [];
  m.delivery.nextMilestoneId = null;
  const result = core.calculateStatus(m, {now}).delivery.stages[0];
  assert.equal(result.percent, null);
  assert.equal(result.remainingTasks, null);
});

test("invalid references, duplicate IDs, and unknown delivery fields fail closed", () => {
  for (const mutate of [
    m => m.delivery.stages[0].taskRefs.push("missing"),
    m => m.delivery.stages.push(m.delivery.stages[0]),
    m => m.delivery.activeStage = "missing",
    m => m.delivery.stages[0].milestoneRefs.push("missing"),
    m => m.delivery.milestones[0].taskRefs.push("missing"),
    m => m.delivery.extra = true,
  ]) {
    const {m} = fixture(); mutate(m);
    assert.equal(core.validateManifest(m).valid, false);
    assert.equal(portable.validateManifest(m).valid, false);
  }
});

test("expired acceptance evidence reduces current stage readiness without rewriting history", () => {
  const {m, done} = fixture();
  for (const id of done.evidenceRefs) m.evidence.find(e => e.id === id).expiresAt = "2026-09-01T00:00:00.000Z";
  // The injected date tests original acceptance; the real clock now tests expiry.
  assert.equal(core.calculateStatus(m, {now}).delivery.stages[0].percent, 100);
  assert.equal(core.calculateStatus(m).delivery.stages[0].percent, 0);
  assert.equal(done.status, "complete");
  assert.deepEqual(portable.calculateStatus(m).delivery.stages, core.calculateStatus(m).delivery.stages);
});
