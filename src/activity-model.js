const activityStates = new Set([
  "queued",
  "ready",
  "running",
  "waiting",
  "locked",
  "completed",
  "failed",
  "stopped",
  "blocked",
  "stale",
  "unknown",
]);

const truthClasses = new Set(["exact", "derived", "estimated", "unknown"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, Math.min(100, number));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function normalizeState(value, fallback = "unknown") {
  const state = String(value ?? "").toLowerCase().replaceAll(" ", "_");
  if (state === "in_progress" || state === "active") return "running";
  if (state === "complete" || state === "passed" || state === "success") return "completed";
  if (state === "error" || state === "failing") return "failed";
  return activityStates.has(state) ? state : fallback;
}

function metric(value) {
  const sourceValue = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  const normalizedValue = clampPercent(sourceValue.value);
  const requestedTruth = sourceValue.truthClass === "reported" ? "exact" : sourceValue.truthClass;
  const truthClass = truthClasses.has(requestedTruth)
    ? requestedTruth
    : normalizedValue === null ? "unknown" : "exact";
  return {
    value: normalizedValue,
    truthClass,
    source: typeof sourceValue.source === "string" ? sourceValue.source : null,
    observedAt: validTimestamp(sourceValue.observedAt),
  };
}

function normalizeProgress(value) {
  if (!value || typeof value !== "object") {
    return { mode: "unavailable", completed: null, total: null, percent: null };
  }
  const completed = finiteNumber(value.completed);
  const total = finiteNumber(value.total);
  const directPercent = clampPercent(value.percent);
  const calculatedPercent = completed !== null && total !== null && total > 0
    ? clampPercent((completed / total) * 100)
    : null;
  const percent = directPercent ?? calculatedPercent;
  const requestedMode = ["determinate", "indeterminate", "unavailable"].includes(value.mode)
    ? value.mode
    : null;
  return {
    mode: percent !== null ? "determinate" : requestedMode ?? "unavailable",
    completed,
    total,
    percent,
  };
}

function workLabel(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

function normalizeWorkItem(value, index, group) {
  const source = value && typeof value === "object" ? value : {};
  const startedAt = validTimestamp(source.startedAt);
  const finishedAt = validTimestamp(source.finishedAt ?? source.completedAt);
  const durationSeconds = finiteNumber(source.durationSeconds ?? source.elapsedSeconds ?? source.duration);
  const tokens = finiteNumber(source.tokens ?? source.tokenCount);
  const toolUses = finiteNumber(source.toolUses ?? source.toolCallCount);
  const kind = workLabel(source.kind ?? source.type, "workflow").toLowerCase();
  const fallbackState = group === "finished" ? "completed" : "running";
  return {
    id: workLabel(source.id, `${group}-${index + 1}`),
    name: workLabel(source.name ?? source.title ?? source.label, `Untitled ${kind}`),
    kind,
    state: normalizeState(source.state ?? source.status, fallbackState),
    summary: workLabel(source.summary ?? source.detail ?? source.currentStep, null),
    owner: workLabel(source.owner?.label ?? source.owner?.id ?? source.owner, null),
    startedAt,
    finishedAt,
    durationSeconds,
    tokens,
    toolUses,
    progress: normalizeProgress(source.progress),
  };
}

function verificationState(value) {
  const explicit = String(value.status ?? value.state ?? "").toLowerCase();
  if (["passed", "pass", "success", "completed"].includes(explicit)) return "passed";
  if (["failed", "fail", "error"].includes(explicit)) return "failed";
  if (["stopped", "cancelled", "canceled"].includes(explicit)) return "stopped";
  if (value.passed === true || value.ok === true || value.exitCode === 0) return "passed";
  if (value.passed === false || value.ok === false || finiteNumber(value.exitCode) > 0) return "failed";
  return "unknown";
}

function normalizeVerification(value, index) {
  const source = value && typeof value === "object" ? value : {};
  const durationMs = finiteNumber(source.durationMs);
  return {
    id: workLabel(source.id, `verification-${index + 1}`),
    name: workLabel(source.name ?? source.label, `Verification ${index + 1}`),
    status: verificationState(source),
    detail: workLabel(source.detail ?? source.summary ?? source.outputSummary, null),
    exitCode: finiteNumber(source.exitCode),
    durationSeconds: finiteNumber(source.durationSeconds ?? source.elapsedSeconds ?? source.duration)
      ?? (durationMs === null ? null : durationMs / 1000),
    rerun: workLabel(source.rerun ?? source.rerunCommand, null),
  };
}

function normalizeStringList(value, keys = []) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return source.map((item) => {
    if (typeof item === "string") return item.trim();
    if (!item || typeof item !== "object") return "";
    return workLabel(keys.map((key) => item[key]).find(Boolean) ?? item.name ?? item.summary, "");
  }).filter(Boolean);
}

export function normalizeReceipt(value) {
  if (!value || typeof value !== "object") return null;
  const verifications = asArray(value.verifications ?? value.verification ?? value.checks).map(normalizeVerification);
  const explicitRerunCommands = normalizeStringList(
    value.rerunCommands ?? value.commands ?? value.rerunCommand,
    ["command", "value"],
  );
  const rerunCommands = [...new Set([
    ...explicitRerunCommands,
    ...verifications.map((verification) => verification.rerun).filter(Boolean),
  ])];
  const fixes = normalizeStringList(value.fixes ?? value.changes, ["summary", "name"]);
  const remainingWork = normalizeStringList(
    value.remainingWork ?? value.remaining ?? value.openItems,
    ["summary", "name", "nextAction"],
  );
  const requestedMode = String(value.mode ?? value.summaryMode ?? "").toLowerCase();
  const mode = ["concise", "verified"].includes(requestedMode)
    ? requestedMode
    : verifications.length || rerunCommands.length ? "verified" : "concise";
  const readinessSource = value.projectReadiness ?? value.readiness;
  let readiness = "Not reported";
  if (typeof readinessSource === "string" && readinessSource.trim()) readiness = readinessSource.trim();
  else if (readinessSource && typeof readinessSource === "object") {
    if (typeof readinessSource.label === "string" && readinessSource.label.trim()) readiness = readinessSource.label.trim();
    else if (finiteNumber(readinessSource.value) !== null) readiness = `${clampPercent(readinessSource.value)}%`;
    else if (readinessSource.status === "not_assessed") readiness = "Not assessed";
  } else if (finiteNumber(value.readinessPercent) !== null) readiness = `${clampPercent(value.readinessPercent)}%`;

  const durationSeconds = finiteNumber(
    value.durationSeconds ?? value.elapsedSeconds ?? (typeof value.duration === "number" ? value.duration : null),
  );
  const durationLabel = typeof value.duration === "string" && value.duration.trim() ? value.duration.trim() : null;
  return {
    id: workLabel(value.id, "latest-receipt"),
    mode,
    title: workLabel(value.title, "Run complete"),
    summary: workLabel(value.fixSummary ?? value.summary ?? value.outcomeSummary, null),
    taskResult: workLabel(value.taskResult?.label ?? value.taskResult ?? value.result ?? value.status, "Unknown"),
    readiness,
    fixes,
    verifications,
    rerunCommands,
    remainingWork,
    durationSeconds,
    durationLabel,
    completedAt: validTimestamp(value.completedAt ?? value.finishedAt),
  };
}

export function normalizeActivity(value, options = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!source || source.available === false) {
    return {
      available: false,
      thread: { state: "unknown", startedAt: null },
      progress: { mode: "unavailable", completed: null, total: null, percent: null },
      counts: { workflows: null, skills: null, agents: null },
      usage: {
        contextRemainingPercent: metric(null),
        quotaRemainingPercent: metric(null),
        taskBudgetRemainingPercent: metric(null),
      },
      lock: { state: "unknown", owner: null },
      freshness: { heartbeatAt: null, ageSeconds: null },
      activeWork: [],
      finishedWork: [],
      lastReceipt: null,
    };
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const heartbeatAt = validTimestamp(source.freshness?.heartbeatAt ?? source.heartbeatAt ?? source.generatedAt);
  const reportedAge = finiteNumber(source.freshness?.ageSeconds);
  const calculatedAge = heartbeatAt && Number.isFinite(now.getTime())
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(heartbeatAt)) / 1000))
    : null;
  const activeWork = asArray(source.activeWork).map((item, index) => normalizeWorkItem(item, index, "active"));
  const finishedWork = asArray(source.finishedWork).map((item, index) => normalizeWorkItem(item, index, "finished"));
  const lockState = String(source.lock?.state ?? "unknown").toLowerCase();
  const threadState = normalizeState(source.thread?.state, activeWork.length ? "running" : "unknown");

  return {
    available: true,
    thread: {
      state: threadState,
      startedAt: validTimestamp(source.thread?.startedAt),
    },
    progress: normalizeProgress(source.progress),
    counts: {
      workflows: finiteNumber(source.counts?.workflows),
      skills: finiteNumber(source.counts?.skills),
      agents: finiteNumber(source.counts?.agents),
    },
    usage: {
      contextRemainingPercent: metric(source.usage?.contextRemainingPercent),
      quotaRemainingPercent: metric(source.usage?.quotaRemainingPercent),
      taskBudgetRemainingPercent: metric(source.usage?.taskBudgetRemainingPercent),
    },
    lock: {
      state: ["unlocked", "locked", "stale", "unknown"].includes(lockState) ? lockState : "unknown",
      owner: workLabel(source.lock?.owner, null),
    },
    freshness: {
      heartbeatAt,
      ageSeconds: reportedAge ?? calculatedAge,
    },
    activeWork,
    finishedWork,
    lastReceipt: normalizeReceipt(source.lastReceipt),
  };
}

export function formatDuration(value) {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds < 0) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 10 && !Number.isInteger(seconds)) return `${seconds.toFixed(1)}s`;
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function metricLabel(value, suffix = "% left") {
  if (!value || value.value === null) return "—";
  const prefix = value.truthClass === "estimated" ? "~" : "";
  return `${prefix}${Math.round(value.value)}${suffix}`;
}

export function countLabel(value) {
  const number = finiteNumber(value);
  return number === null ? "—" : String(Math.max(0, Math.floor(number)));
}
