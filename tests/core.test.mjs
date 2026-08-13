import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ManifestValidationError,
  MANIFEST_SCHEMA,
  calculateStatus,
  canonicalize,
  createPublicProjection,
  criticalPath,
  sha256,
  validateManifest,
} from "../packages/core/index.mjs";

const manifest = JSON.parse(
  await readFile(new URL("../.project-status/manifest.json", import.meta.url), "utf8"),
);
const portableSchema = JSON.parse(
  await readFile(new URL("../skill/project-status/assets/manifest.schema.json", import.meta.url), "utf8"),
);

function clone() {
  return structuredClone(manifest);
}

function taskById(candidate, taskId) {
  return candidate.phases.flatMap((phase) => phase.tasks).find((task) => task.id === taskId);
}

function errorCodes(result) {
  return new Set(result.errors.map((error) => error.code));
}

test("current local-release manifest is strict, evidence-backed, and exactly 61/100", () => {
  const validation = validateManifest(manifest);
  assert.deepEqual(validation, { valid: true, errors: [] });

  const status = calculateStatus(manifest);
  assert.deepEqual(status.score, {
    earnedWeight: 61,
    totalWeight: 100,
    exactPercent: 61,
    displayPercent: 61,
  });
  assert.deepEqual(status.phases.map(({ id, weight, earnedWeight }) => ({ id, weight, earnedWeight })), [
    { id: "truth-provenance", weight: 35, earnedWeight: 25 },
    { id: "monitoring-api", weight: 35, earnedWeight: 21 },
    { id: "experience-release", weight: 30, earnedWeight: 15 },
  ]);
  assert.deepEqual(status.tasks, {
    total: 16,
    complete: 10,
    inProgress: 3,
    blocked: 0,
    notStarted: 3,
  });
  assert.equal(status.audit.verificationState, "current");
  assert.deepEqual(status.gates, { satisfied: 0, unsatisfied: 3, waiting: 0, waived: 0 });
});

test("portable JSON Schema is exactly the canonical core schema", () => {
  assert.deepEqual(portableSchema, MANIFEST_SCHEMA);
  assert.equal(MANIFEST_SCHEMA.properties.route.type, "string");
  assert.equal(MANIFEST_SCHEMA.additionalProperties, false);
});

test("schema rejects unknown properties and invalid enums", () => {
  const candidate = clone();
  candidate.surprise = true;
  taskById(candidate, "dashboard-implementation").status = "almost_done";
  candidate.evidence[0].tier = "trust_me";

  const validation = validateManifest(candidate);
  assert.equal(validation.valid, false);
  assert.ok(errorCodes(validation).has("unknown_property"));
  assert.ok(errorCodes(validation).has("invalid_enum"));
  assert.ok(validation.errors.some((error) => error.path === "$.surprise"));
  assert.throws(
    () => validateManifest(candidate, { throwOnError: true }),
    (error) => error instanceof ManifestValidationError && error.errors.length >= 3,
  );
});

test("schema rejects unsafe routes, invalid ranges, and nested unknown properties", () => {
  const candidate = clone();
  candidate.route = "/status/%2e%2e/private";
  const task = taskById(candidate, "schema-runtime-validator");
  task.remainingHours = { min: 4, max: 2 };
  task.owner.secret = "not-public";

  const validation = validateManifest(candidate);
  assert.equal(validation.valid, false);
  assert.ok(errorCodes(validation).has("invalid_route"));
  assert.ok(errorCodes(validation).has("invalid_range"));
  assert.ok(validation.errors.some((error) => error.code === "unknown_property" && error.path.endsWith(".owner.secret")));
});

test("malformed reference collections are reported instead of throwing", () => {
  const candidate = clone();
  taskById(candidate, "legacy-dashboard-audit").evidenceRefs = "audit-divergence";
  candidate.gates[0].taskRefs = { task: "source-deployment-binding" };
  const validation = validateManifest(candidate, { now: "2026-08-12T18:00:00.000Z" });
  assert.equal(validation.valid, false);
  assert.ok(errorCodes(validation).has("expected_array"));
});

test("semantic validation rejects invalid phase weights and credit rules", () => {
  const candidate = clone();
  taskById(candidate, "schema-runtime-validator").weight = 8;
  taskById(candidate, "schema-runtime-validator").earnedWeight = 1;

  const validation = validateManifest(candidate);
  assert.equal(validation.valid, false);
  assert.ok(errorCodes(validation).has("phase_weight_mismatch"));
  assert.ok(errorCodes(validation).has("invalid_credit"));
});

test("earned credit requires current, qualifying, non-dangling evidence", () => {
  const dangling = clone();
  taskById(dangling, "legacy-dashboard-audit").evidenceRefs = ["missing-evidence"];
  let validation = validateManifest(dangling);
  assert.ok(errorCodes(validation).has("dangling_evidence_ref"));
  assert.ok(errorCodes(validation).has("insufficient_evidence"));

  const revoked = clone();
  revoked.evidence.find((item) => item.id === "audit-divergence").state = "revoked";
  validation = validateManifest(revoked);
  assert.ok(errorCodes(validation).has("insufficient_evidence"));

  const insufficientTier = clone();
  insufficientTier.evidence.find((item) => item.id === "audit-divergence").tier = "prepared";
  validation = validateManifest(insufficientTier);
  assert.ok(errorCodes(validation).has("insufficient_evidence"));
});

test("typed gates require valid reciprocal task references", () => {
  const dangling = clone();
  dangling.gates[0].taskRefs.push("not-a-task");
  let validation = validateManifest(dangling);
  assert.ok(errorCodes(validation).has("dangling_task_ref"));

  const mismatched = clone();
  taskById(mismatched, "source-deployment-binding").gateRefs = [];
  validation = validateManifest(mismatched);
  assert.ok(errorCodes(validation).has("gate_reference_mismatch"));

  const creditBehindGate = clone();
  const gated = taskById(creditBehindGate, "source-deployment-binding");
  gated.status = "in_progress";
  gated.earnedWeight = 1;
  gated.evidenceRefs = ["audit-divergence"];
  gated.evidenceRequirement.minimumTier = "validated_local";
  validation = validateManifest(creditBehindGate);
  assert.ok(errorCodes(validation).has("credit_behind_gate"));
});

test("dependency validation rejects dangling references, duplicate edges, and cycles", () => {
  const dangling = clone();
  dangling.dependencies[0].prerequisiteTaskId = "missing-task";
  let validation = validateManifest(dangling);
  assert.ok(errorCodes(validation).has("dangling_dependency_ref"));

  const duplicate = clone();
  duplicate.dependencies.push({ ...duplicate.dependencies[0], id: "duplicate-edge" });
  validation = validateManifest(duplicate);
  assert.ok(errorCodes(validation).has("duplicate_dependency"));

  const cyclic = clone();
  cyclic.dependencies.push({
    id: "deploy-before-validator",
    type: "blocks",
    prerequisiteTaskId: "production-deploy-smoke",
    dependentTaskId: "schema-runtime-validator"
  });
  validation = validateManifest(cyclic);
  assert.ok(errorCodes(validation).has("dependency_cycle"));
});

test("critical path refuses to invent missing estimates", () => {
  const result = criticalPath(manifest);
  assert.equal(result.determinate, false);
  assert.equal(result.reason, "missing_estimates");
  assert.equal(result.durationHours, null);
  assert.ok(result.missingEstimateTaskIds.includes("scheduled-probe-runner"));
});

test("critical path is deterministic once every active duration is known", () => {
  const candidate = clone();
  for (const task of candidate.phases.flatMap((phase) => phase.tasks)) {
    if (task.status !== "complete") task.remainingHours = { min: 1, max: 2 };
  }
  const result = criticalPath(candidate);
  assert.equal(result.determinate, true);
  assert.deepEqual(result.path, [
    "scheduled-probe-runner",
    "durable-history-alerting",
    "production-deploy-smoke",
  ]);
  assert.deepEqual(result.durationHours, { min: 3, max: 6 });
});

test("public projection redacts local and conversation locators and internal IDs", () => {
  const projection = createPublicProjection(manifest);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /\/Users\//);
  assert.doesNotMatch(serialized, /project-ambient-dashboard-audit:/);
  assert.doesNotMatch(serialized, /dashboard-audit-agent/);
  assert.doesNotMatch(serialized, /audit-reviewer/);
  assert.doesNotMatch(serialized, /e4f23473d84a798eb9aab30d6db5461f66a866442dd37b2261567758cf86ebe3/);
  assert.equal(projection.score.earnedWeight, 61);
  assert.equal(projection.route, "/status");
  assert.equal(projection.manifestFreshness.basis, "manifest_snapshot");
  assert.match(projection.provenance.canonicalManifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(projection.evidence.every((item) => !("locator" in item)));
  assert.ok(projection.evidence.some((item) => item.id === "legacy-desktop-screenshot"));
});

test("public evidence exposes only safe public locator types", () => {
  const candidate = clone();
  candidate.evidence[0].visibility = "public";
  candidate.evidence[0].locator = { type: "url", url: "https://example.com/evidence/audit-divergence" };
  const projection = createPublicProjection(candidate);
  const evidence = projection.evidence.find((item) => item.id === "audit-divergence");
  assert.deepEqual(evidence.locator, { type: "url", url: "https://example.com/evidence/audit-divergence" });
  assert.equal(evidence.summary, candidate.evidence[0].assertion);
  assert.equal(evidence.verifier.id, undefined);
});

test("canonical JSON and SHA-256 are stable across key insertion order", () => {
  const first = { z: 1, a: { beta: true, alpha: [3, null, "x"] } };
  const second = { a: { alpha: [3, null, "x"], beta: true }, z: 1 };
  const canonical = '{"a":{"alpha":[3,null,"x"],"beta":true},"z":1}';
  assert.equal(canonicalize(first), canonical);
  assert.equal(canonicalize(second), canonical);
  assert.equal(sha256(first), sha256(second));
  assert.equal(sha256(first), createHash("sha256").update(canonical).digest("hex"));
  assert.throws(() => canonicalize({ invalid: undefined }), /non-JSON/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalize(cyclic), /circular reference/);
});

test("injected clock controls audit freshness without reading wall time", () => {
  const candidate = clone();
  candidate.audit.state = "current";
  candidate.evidence.find((item) => item.id === "local-release-verification").expiresAt = null;
  const now = new Date("2026-08-13T03:58:27.000Z");
  const status = calculateStatus(candidate, { clock: () => now });
  assert.equal(status.asOf, now.toISOString());
  assert.equal(status.audit.ageSeconds, Math.floor((now.getTime() - Date.parse(candidate.audit.verifiedAt)) / 1000));
  assert.equal(status.audit.isStale, true);
  assert.equal(status.audit.verificationState, "stale_audit");
  assert.equal(status.score.earnedWeight, 61);
});

test("top-level derivations sample an injected clock exactly once", () => {
  let calls = 0;
  const clock = () => {
    calls += 1;
    return new Date(manifest.audit.evidenceAsOf);
  };
  assert.equal(calculateStatus(manifest, { clock }).asOf, manifest.audit.evidenceAsOf);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(createPublicProjection(manifest, { clock }).manifestFreshness.asOf, manifest.audit.evidenceAsOf);
  assert.equal(calls, 1);
});

test("expired evidence marks verification stale without silently erasing historical credit", () => {
  const candidate = clone();
  candidate.audit.state = "current";
  candidate.evidence.find((item) => item.id === "local-release-verification").expiresAt = null;
  const evidence = candidate.evidence.find((item) => item.id === "audit-divergence");
  evidence.expiresAt = "2026-08-13T04:00:00.000Z";
  const status = calculateStatus(candidate, { now: "2026-08-13T04:01:00.000Z" });
  assert.equal(status.score.earnedWeight, 61);
  assert.equal(status.audit.verificationState, "stale_evidence");
  assert.deepEqual(status.evidence.expiredEvidenceIds, ["audit-divergence"]);
});

test("validator uses the injected clock to reject future-dated evidence", () => {
  const result = validateManifest(manifest, { now: "2026-08-12T17:43:03.000Z" });
  assert.equal(result.valid, false);
  assert.ok(errorCodes(result).has("timestamp_in_future"));
});
