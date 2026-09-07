import { criticalPath } from "./graph.mjs";
import { calculateDelivery } from "./delivery.mjs";
import { EVIDENCE_TIER_RANK } from "./schema.mjs";
import { resolveClock } from "./time.mjs";
import { validateManifest } from "./validator.mjs";

function credit(task) {
  if (task.status === "complete") return task.weight;
  if (task.status === "in_progress") return task.earnedWeight;
  return 0;
}

function evidenceIsCurrent(evidence, now) {
  return evidence.state === "current" && (evidence.expiresAt === null || Date.parse(evidence.expiresAt) > now);
}

/** Derive score, freshness, evidence, time, gate, and path summaries without mutation. */
export function calculateStatus(manifest, options = {}) {
  const allowedOptions = new Set(["now", "clock"]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new TypeError(`Unknown calculateStatus option: ${key}`);
  }
  // Validate the timeless contract before consulting an injected clock, then
  // sample that clock exactly once for all time-relative checks and output.
  validateManifest(manifest, { throwOnError: true });
  const now = resolveClock(options);
  if (options.now !== undefined || options.clock !== undefined) {
    validateManifest(manifest, { now, throwOnError: true });
  }
  const nowMs = now.getTime();
  const tasks = manifest.phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phaseId: phase.id })));
  const evidenceById = new Map(manifest.evidence.map((evidence) => [evidence.id, evidence]));

  const phases = manifest.phases.map((phase) => {
    const earnedWeight = phase.tasks.reduce((sum, task) => sum + credit(task), 0);
    return Object.freeze({
      id: phase.id,
      weight: phase.weight,
      earnedWeight,
      exactPercent: (earnedWeight / phase.weight) * 100,
      displayPercent: Math.round((earnedWeight / phase.weight) * 100),
      taskCount: phase.tasks.length,
      completedTaskCount: phase.tasks.filter((task) => task.status === "complete").length,
    });
  });
  const earnedWeight = phases.reduce((sum, phase) => sum + phase.earnedWeight, 0);

  const evidenceSupportingCredit = new Set(
    tasks.filter((task) => credit(task) > 0).flatMap((task) => task.evidenceRefs),
  );
  const invalidEvidenceIds = [...evidenceSupportingCredit]
    .filter((id) => !evidenceIsCurrent(evidenceById.get(id), nowMs))
    .sort();
  const expiredEvidenceIds = [...evidenceSupportingCredit]
    .filter((id) => {
      const evidence = evidenceById.get(id);
      return evidence.expiresAt !== null && Date.parse(evidence.expiresAt) <= nowMs;
    })
    .sort();

  const baseline = manifest.audit.verifiedAt ?? manifest.audit.evidenceAsOf;
  const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(baseline)) / 1000));
  const auditIsStale = manifest.audit.nextDueAt !== null
    ? nowMs > Date.parse(manifest.audit.nextDueAt)
    : ageSeconds > manifest.audit.staleAfterSeconds;

  let verificationState = "current";
  if (manifest.audit.state === "proposal") verificationState = "proposal";
  else if (invalidEvidenceIds.length > 0) verificationState = "stale_evidence";
  else if (auditIsStale || manifest.audit.state === "stale") verificationState = "stale_audit";
  else if (manifest.audit.state === "superseded") verificationState = "superseded";

  const timeSummary = tasks.reduce((summary, task) => {
    if (task.remainingHours === null) {
      if (task.status !== "complete") summary.unknownEstimateTaskIds.push(task.id);
      return summary;
    }
    const bucket = task.deferred ? summary.deferred : summary.active;
    bucket.min += task.remainingHours.min;
    bucket.max += task.remainingHours.max;
    return summary;
  }, {
    active: { min: 0, max: 0 },
    deferred: { min: 0, max: 0 },
    unknownEstimateTaskIds: [],
  });

  const gateSummary = {
    satisfied: manifest.gates.filter((gate) => gate.status === "satisfied").length,
    unsatisfied: manifest.gates.filter((gate) => gate.status === "unsatisfied").length,
    waiting: manifest.gates.filter((gate) => gate.status === "waiting").length,
    waived: manifest.gates.filter((gate) => gate.status === "waived").length,
  };

  return Object.freeze({
    asOf: now.toISOString(),
    delivery: calculateDelivery(manifest, now),
    score: Object.freeze({
      earnedWeight,
      totalWeight: manifest.totalWeight,
      exactPercent: (earnedWeight / manifest.totalWeight) * 100,
      displayPercent: Math.round((earnedWeight / manifest.totalWeight) * 100),
    }),
    phases: Object.freeze(phases),
    tasks: Object.freeze({
      total: tasks.length,
      complete: tasks.filter((task) => task.status === "complete").length,
      inProgress: tasks.filter((task) => task.status === "in_progress").length,
      blocked: tasks.filter((task) => task.status === "blocked").length,
      notStarted: tasks.filter((task) => task.status === "not_started").length,
    }),
    evidence: Object.freeze({
      total: manifest.evidence.length,
      supportingCredit: evidenceSupportingCredit.size,
      invalidEvidenceIds: Object.freeze(invalidEvidenceIds),
      expiredEvidenceIds: Object.freeze(expiredEvidenceIds),
      highestTier: manifest.evidence.reduce((best, item) => (
        EVIDENCE_TIER_RANK[item.tier] > EVIDENCE_TIER_RANK[best] ? item.tier : best
      ), "assertion"),
    }),
    audit: Object.freeze({
      state: manifest.audit.state,
      verificationState,
      ageSeconds,
      staleAfterSeconds: manifest.audit.staleAfterSeconds,
      isStale: auditIsStale,
      nextDueAt: manifest.audit.nextDueAt,
    }),
    time: Object.freeze({
      active: Object.freeze(timeSummary.active),
      deferred: Object.freeze(timeSummary.deferred),
      unknownEstimateTaskIds: Object.freeze(timeSummary.unknownEstimateTaskIds.sort()),
    }),
    gates: Object.freeze(gateSummary),
    criticalPath: criticalPath(manifest),
  });
}
