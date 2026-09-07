import { sha256 } from "./canonical.mjs";
import { calculateStatus } from "./calculator.mjs";

function publicOwner(owner) {
  return { type: owner.type, label: owner.label };
}

function publicLocator(evidence) {
  if (evidence.visibility !== "public") return undefined;
  if (["url", "commit", "artifact"].includes(evidence.locator.type)) return { ...evidence.locator };
  return undefined;
}

function publicEvidence(evidence) {
  const projected = {
    id: evidence.id,
    kind: evidence.kind,
    tier: evidence.tier,
    state: evidence.state,
    visibility: evidence.visibility,
    summary: evidence.visibility === "public" ? evidence.assertion : evidence.publicSummary,
    capturedAt: evidence.capturedAt,
    verifiedAt: evidence.verifiedAt,
    expiresAt: evidence.expiresAt,
    verifier: { type: evidence.verifier.type, label: evidence.verifier.label },
  };
  if (evidence.visibility === "public") projected.integrity = evidence.integrity;
  const locator = publicLocator(evidence);
  if (locator !== undefined) projected.locator = locator;
  return projected;
}

function manifestStaleAt(manifest) {
  if (manifest.audit.nextDueAt !== null) return manifest.audit.nextDueAt;
  const baseline = manifest.audit.verifiedAt ?? manifest.audit.evidenceAsOf;
  return new Date(Date.parse(baseline) + manifest.audit.staleAfterSeconds * 1000).toISOString();
}

/** Return an allowlist-built projection with local/internal locators and IDs removed. */
export function createPublicProjection(manifest, options = {}) {
  const status = calculateStatus(manifest, options);
  const canonicalManifestSha256 = sha256(manifest);
  const tasks = manifest.phases.flatMap((phase) => phase.tasks);
  const blockers = tasks
    .filter((task) => task.status === "blocked")
    .map((task) => ({ id: task.id, name: task.name, summary: task.summary, nextAction: task.nextAction }));
  const externalGates = manifest.gates
    .filter((gate) => gate.type === "external_approval" && ["unsatisfied", "waiting"].includes(gate.status))
    .map((gate) => ({ id: gate.id, name: gate.name, status: gate.status, reason: gate.reason, wait: gate.wait, nextAction: gate.nextAction }));
  const staleAt = manifestStaleAt(manifest);
  return {
    schemaVersion: manifest.schemaVersion,
    route: manifest.route,
    initiative: { ...manifest.initiative },
    project: manifest.initiative.name,
    readinessQuestion: `Delivery readiness for ${manifest.initiative.release}`,
    statusState: manifest.initiative.state,
    source: { ...manifest.source },
    provenance: {
      canonicalManifestSha256,
      auditId: manifest.audit.auditId,
    },
    manifestDigest: canonicalManifestSha256,
    audit: { ...manifest.audit, asOf: status.asOf, verificationState: status.audit.verificationState, staleAt },
    manifestFreshness: {
      basis: "manifest_snapshot",
      state: status.audit.verificationState,
      asOf: status.asOf,
      evidenceAsOf: manifest.audit.evidenceAsOf,
      verifiedAt: manifest.audit.verifiedAt,
      staleAt,
      ageSeconds: status.audit.ageSeconds,
      isStale: status.audit.isStale,
    },
    score: { ...status.score },
    delivery: status.delivery,
    readiness: { exact: status.score.exactPercent, displayed: status.score.displayPercent, denominator: status.score.totalWeight },
    phases: manifest.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      summary: phase.summary,
      weight: phase.weight,
      score: status.phases.find((item) => item.id === phase.id),
      earnedWeight: status.phases.find((item) => item.id === phase.id).earnedWeight,
      completion: status.phases.find((item) => item.id === phase.id).exactPercent,
      tasks: phase.tasks.map((task) => ({
        id: task.id,
        name: task.name,
        summary: task.summary,
        status: task.status,
        weight: task.weight,
        earnedWeight: task.earnedWeight,
        remainingHours: task.remainingHours,
        recurring: task.recurring,
        deferred: task.deferred,
        owner: publicOwner(task.owner),
        nextAction: task.nextAction,
        evidenceRequirement: { ...task.evidenceRequirement },
        evidenceRefs: [...task.evidenceRefs],
        gateRefs: [...task.gateRefs],
      })),
    })),
    evidence: manifest.evidence.map(publicEvidence),
    gates: manifest.gates.map((gate) => ({
      id: gate.id,
      name: gate.name,
      type: gate.type,
      status: gate.status,
      reason: gate.reason,
      owner: publicOwner(gate.owner),
      nextAction: gate.nextAction,
      wait: gate.wait === null ? null : { ...gate.wait },
      taskRefs: [...gate.taskRefs],
    })),
    dependencies: manifest.dependencies.map((dependency) => ({ ...dependency })),
    effort: { active: { ...status.time.active }, soak: null, deferred: { ...status.time.deferred } },
    blockers,
    externalGates,
    recurringTaskCount: tasks.filter((task) => task.recurring && task.status !== "complete").length,
    liveHealth: { state: "unknown", observedAt: null },
    summaries: {
      tasks: { ...status.tasks },
      evidence: { ...status.evidence },
      gates: { ...status.gates },
      time: {
        active: { ...status.time.active },
        deferred: { ...status.time.deferred },
        unknownEstimateTaskIds: [...status.time.unknownEstimateTaskIds],
      },
      criticalPath: {
        ...status.criticalPath,
        path: [...status.criticalPath.path],
        missingEstimateTaskIds: [...status.criticalPath.missingEstimateTaskIds],
        topologicalOrder: [...status.criticalPath.topologicalOrder],
      },
    },
  };
}
