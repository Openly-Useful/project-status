import { fallbackStatus } from "./status-fallback.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function newestTimestamp(values) {
  return values
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function rangeLabel(range) {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "Estimate needed";
  if (range.min === range.max) return `${range.min}h`;
  return `${range.min}–${range.max}h`;
}

function taskOwner(task) {
  return task?.owner?.label ?? task?.owner?.id ?? "Unassigned";
}

function canonicalPhases(manifest) {
  return asArray(manifest.phases).map((phase) => ({
    id: phase.id,
    name: phase.name,
    shortName: phase.shortName ?? phase.name,
    weight: phase.weight,
    earnedWeight: phase.score?.earnedWeight ?? phase.earnedWeight ?? 0,
    description: phase.summary ?? phase.description ?? "",
    tasks: asArray(phase.tasks).map((task) => ({
      ...task,
      earnedWeight: task.earnedWeight ?? (task.status === "complete" ? task.weight : 0),
    })),
  }));
}

function incompleteActions(phases, criticalPath) {
  const tasks = phases.flatMap((phase) => phase.tasks);
  const pathOrder = new Map(asArray(criticalPath?.path).map((id, index) => [id, index]));
  return tasks
    .filter((task) => task.status !== "complete" && task.nextAction)
    .sort((left, right) => {
      const leftRank = pathOrder.has(left.id) ? pathOrder.get(left.id) : Number.MAX_SAFE_INTEGER;
      const rightRank = pathOrder.has(right.id) ? pathOrder.get(right.id) : Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    })
    .map((task) => ({
      id: task.id,
      name: task.nextAction,
      owner: taskOwner(task),
      effort: rangeLabel(task.remainingHours),
      eta: null,
      unlocks: "The next verified readiness outcome",
      kind: "internal",
    }));
}

function canonicalBlockers(manifest, phases) {
  const gateBlockers = asArray(manifest.gates)
    .filter((gate) => ["unsatisfied", "waiting"].includes(gate.status))
    .map((gate) => ({
      id: gate.id,
      name: gate.name,
      kind: gate.type ?? "gate",
      owner: gate.owner?.label ?? "Unassigned",
      age: gate.wait?.state ?? "Open",
      unlocks: asArray(gate.taskRefs).join(", ") || "Dependent work",
      nextAction: gate.nextAction ?? gate.reason ?? "Resolve the gate and record evidence.",
    }));
  const taskBlockers = phases
    .flatMap((phase) => phase.tasks)
    .filter((task) => task.status === "blocked" && !gateBlockers.some((gate) => asArray(task.gateRefs).includes(gate.id)))
    .map((task) => ({
      id: task.id,
      name: task.name,
      kind: "task",
      owner: taskOwner(task),
      age: "Open",
      unlocks: "Dependent work",
      nextAction: task.nextAction ?? "Resolve the blocker and attach evidence.",
    }));
  return [...gateBlockers, ...taskBlockers];
}

function canonicalChanges(manifest) {
  return asArray(manifest.evidence)
    .slice()
    .sort((left, right) => Date.parse(right.verifiedAt ?? right.capturedAt) - Date.parse(left.verifiedAt ?? left.capturedAt))
    .slice(0, 12)
    .map((evidence) => ({
      id: evidence.id,
      state: evidence.state === "current" ? "verified" : evidence.state,
      summary: evidence.summary ?? evidence.publicSummary ?? "Evidence record",
      at: evidence.verifiedAt ?? evidence.capturedAt,
    }));
}

function normalizeCanonical(manifest, base) {
  const phases = canonicalPhases(manifest);
  const summary = manifest.summaries ?? {};
  const evidence = asArray(manifest.evidence);
  const audit = manifest.audit ?? {};
  const currentEvidence = evidence.filter((item) => item.state === "current");
  const invalidEvidence = asArray(summary.evidence?.invalidEvidenceIds);
  const criticalPath = summary.criticalPath ?? {};
  const activeTime = summary.time?.active;
  const source = manifest.source ?? {};
  const digest = manifest.provenance?.canonicalManifestSha256 ?? source.manifestSha256 ?? null;
  const pathHours = criticalPath.totalHours;

  const normalized = {
    ...base,
    schemaVersion: manifest.schemaVersion,
    initiative: manifest.initiative?.name ?? base.initiative,
    initiativeState: manifest.initiative?.state ?? base.initiativeState,
    release: manifest.initiative?.release ?? base.release,
    source: {
      ...base.source,
      ...source,
      state: source.commit && digest ? "bound" : "unbound",
      manifestSha256: digest,
      auditId: manifest.provenance?.auditId ?? audit.auditId ?? base.source.auditId,
      evidenceAsOf: audit.evidenceAsOf ?? base.source.evidenceAsOf,
    },
    audit: {
      ...base.audit,
      ...audit,
      verifiedAt: audit.verifiedAt ?? null,
      nextDueAt: audit.nextDueAt ?? null,
      verificationState: audit.verificationState ?? audit.state ?? "unknown",
    },
    score: {
      ...base.score,
      ...(manifest.score ?? {}),
    },
    phases,
    evidenceSummary: {
      total: evidence.length,
      current: currentEvidence.length,
      stale: invalidEvidence.length + evidence.filter((item) => item.state !== "current").length,
      highestTier: summary.evidence?.highestTier ?? null,
      latestVerifiedAt: newestTimestamp(evidence.map((item) => item.verifiedAt ?? item.capturedAt)),
      verificationState: audit.verificationState ?? "unknown",
    },
    nextActions: incompleteActions(phases, criticalPath),
    changes: canonicalChanges(manifest),
    blockers: canonicalBlockers(manifest, phases),
    criticalPath: {
      earliestReady: Number.isFinite(pathHours) ? `${rangeLabel({ min: pathHours, max: pathHours })} critical path` : "Estimate incomplete",
      calendarDays: null,
      assumption: asArray(criticalPath.missingEstimateTaskIds).length
        ? `${criticalPath.missingEstimateTaskIds.length} active task estimate${criticalPath.missingEstimateTaskIds.length === 1 ? " is" : "s are"} still required.`
        : `Active hands-on range: ${rangeLabel(activeTime)}.`,
      ...criticalPath,
    },
  };

  if (normalized.nextActions.length === 0) {
    normalized.nextActions = [{
      id: "no-open-action",
      name: normalized.score.earnedWeight >= normalized.score.totalWeight ? "Maintain verified readiness" : "Add the next evidence-backed action",
      owner: "Project owner",
      effort: "Not estimated",
      eta: null,
      unlocks: "A current delivery plan",
      kind: "internal",
    }];
  }

  return normalized;
}

function normalizeMonitor(monitor, base) {
  if (!monitor || typeof monitor !== "object") return base;
  const value = monitor.monitoring && typeof monitor.monitoring === "object" ? monitor.monitoring : monitor;
  const state = value.state ?? value.status ?? base.state;
  const normalizedState = state === "failing" ? "unhealthy" : state === "stale" ? "degraded" : state;
  const checks = asArray(value.checks).map((check, index) => {
    const checkState = check.state ?? check.status ?? (check.ok === true ? "healthy" : "unhealthy");
    return {
      ...check,
      id: check.id ?? `monitor-check-${index + 1}`,
      state: checkState === "failing" ? "unhealthy" : checkState,
      detail: check.detail
        ?? (check.failureCode ? `Failure: ${check.failureCode.replaceAll("_", " ")}` : check.statusCode ? `HTTP ${check.statusCode}` : "No public detail"),
    };
  });
  return {
    ...base,
    ...value,
    state: normalizedState,
    lastScheduledAt: value.lastScheduledAt ?? value.lastAttemptAt ?? base.lastScheduledAt,
    consecutiveFailures: value.consecutiveFailures ?? value.summary?.maxConsecutiveFailures ?? base.consecutiveFailures,
    checks: checks.length ? checks : base.checks,
  };
}

/** Convert a strict public projection into the stable dashboard view model. */
export function mergeStatus(manifest, monitor, base = fallbackStatus) {
  const canonical = manifest?.initiative && typeof manifest.initiative === "object"
    ? normalizeCanonical(manifest, base)
    : {
      ...base,
      ...(manifest ?? {}),
      source: { ...base.source, ...(manifest?.source ?? {}) },
      audit: { ...base.audit, ...(manifest?.audit ?? {}) },
      score: { ...base.score, ...(manifest?.score ?? {}) },
      evidenceSummary: { ...base.evidenceSummary, ...(manifest?.evidenceSummary ?? {}) },
      criticalPath: { ...base.criticalPath, ...(manifest?.criticalPath ?? {}) },
    };

  return {
    ...canonical,
    monitoring: normalizeMonitor(monitor, {
      ...base.monitoring,
      ...(canonical.monitoring ?? {}),
    }),
  };
}
