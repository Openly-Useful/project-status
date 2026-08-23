import { createPublicProjection, sha256 } from "../packages/core/index.mjs";

const ROUTES = new Set(["/status/manifest", "/api/status", "/api/activity"]);
const SAFE_RUN_STATUSES = new Set(["healthy", "degraded", "failing"]);
const SAFE_CHECK_STATUSES = new Set(["healthy", "failing"]);
const SAFE_ACTIVITY_STATES = new Set(["queued", "running", "waiting", "completed", "failed", "stopped"]);
const SAFE_ACTIVITY_KINDS = new Set(["thread", "workflow", "skill", "agent", "tool"]);
const SAFE_THREAD_STATES = new Set(["ready", "running", "waiting", "locked", "stale", "unknown", "failed", "stopped"]);
const SAFE_LOCK_STATES = new Set(["unlocked", "locked", "stale", "unknown"]);
const SAFE_TRUTH_CLASSES = new Set(["exact", "derived", "estimated", "unknown", "reported"]);
const SAFE_FAILURE_CODES = new Set([
  "credentials_not_allowed",
  "dns_resolution_failed",
  "invalid_url",
  "network_error",
  "private_network_denied",
  "redirect_denied",
  "redirect_missing_location",
  "response_too_large",
  "timeout",
  "too_many_redirects",
  "unexpected_status",
  "unsupported_protocol",
  "url_too_long",
]);

function resolveInstant(options, fallback) {
  const value = options.now ?? options.clock?.() ?? fallback;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Status API clock returned an invalid instant.");
  return date;
}

function timestamp(value, name) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`Persisted monitor ${name} is invalid.`);
  }
  return new Date(value).toISOString();
}

function nullableTimestamp(value, name) {
  return value === null || value === undefined ? null : timestamp(value, name);
}

function nonnegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function safeStatusCode(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function publicText(value, fallback, limit = 160) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  return value
    .trim()
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential redacted]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{8,}\b/g, "[credential redacted]")
    .replace(/\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s]+/g, "[credential redacted]")
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s/]+/g, "[home]")
    .replace(/[A-Za-z]:\\Users\\[^\s\\]+/g, "[home]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[credentials]@")
    .slice(0, limit);
}

function publicIdentifier(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(text) ? text : fallback;
}

function publicActivityProgress(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { mode: "unavailable", completed: null, total: null, percent: null };
  }
  if (value.mode === "indeterminate" || (value.mode === undefined && value.total === 0)) {
    return { mode: "indeterminate", completed: null, total: null, percent: null };
  }
  if ((value.mode !== undefined && value.mode !== "determinate")
    || !Number.isFinite(value.completed)
    || !Number.isFinite(value.total)
    || value.completed < 0
    || value.total <= 0
    || value.completed > value.total) {
    return { mode: "unavailable", completed: null, total: null, percent: null };
  }
  return {
    mode: "determinate",
    completed: value.completed,
    total: value.total,
    percent: Math.round((value.completed / value.total) * 10_000) / 100,
  };
}

function publicActivityMetric(value) {
  const truthClass = SAFE_TRUTH_CLASSES.has(value?.truthClass)
    ? (value.truthClass === "reported" ? "exact" : value.truthClass)
    : "unknown";
  const metricValue = Number.isFinite(value?.value) && value.value >= 0 && value.value <= 100
    ? value.value
    : null;
  return {
    value: truthClass === "unknown" ? null : metricValue,
    truthClass: metricValue === null ? "unknown" : truthClass,
    source: publicIdentifier(value?.source, "unknown"),
    observedAt: value?.observedAt === null || value?.observedAt === undefined
      ? null
      : timestamp(value.observedAt, "activity metric observedAt"),
    unit: value?.unit === null || value?.unit === undefined
      ? null
      : publicText(value.unit, null, 32),
  };
}

function publicActivityWorkItem(item, index) {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    throw new TypeError("Persisted activity work item is invalid.");
  }
  return {
    id: publicIdentifier(item.id, `work-${index + 1}`),
    kind: SAFE_ACTIVITY_KINDS.has(item.kind) ? item.kind : "tool",
    label: publicText(item.label ?? item.name, `Work ${index + 1}`),
    state: SAFE_ACTIVITY_STATES.has(item.state) ? item.state : "waiting",
    parentId: item.parentId === null || item.parentId === undefined
      ? null
      : publicIdentifier(item.parentId, "redacted"),
    progress: publicActivityProgress(item.progress),
    startedAt: item.startedAt === null || item.startedAt === undefined
      ? null
      : timestamp(item.startedAt, "activity work startedAt"),
    updatedAt: item.updatedAt === null || item.updatedAt === undefined
      ? null
      : timestamp(item.updatedAt, "activity work updatedAt"),
    completedAt: item.completedAt === null || item.completedAt === undefined
      ? null
      : timestamp(item.completedAt, "activity work completedAt"),
    elapsedSeconds: Number.isFinite(item.elapsedSeconds) && item.elapsedSeconds >= 0
      ? item.elapsedSeconds
      : item.startedAt && (item.completedAt || item.updatedAt)
        ? Math.max(0, Math.floor((Date.parse(item.completedAt ?? item.updatedAt) - Date.parse(item.startedAt)) / 1_000))
        : null,
  };
}

function publicActivityLock(value, fallbackId = "thread") {
  const owner = value?.owner === null || value?.owner === undefined
    ? null
    : publicIdentifier(value.owner, null);
  let state = SAFE_LOCK_STATES.has(value?.state) ? value.state : "unknown";
  // A lock is only affirmative when the source identifies an explicit owner.
  if (state === "locked" && owner === null) state = "unknown";
  return {
    id: publicIdentifier(value?.id, fallbackId),
    state,
    owner,
    observedAt: value?.observedAt === null || value?.observedAt === undefined
      ? value?.heartbeatAt === null || value?.heartbeatAt === undefined
        ? value?.acquiredAt === null || value?.acquiredAt === undefined
          ? null
          : timestamp(value.acquiredAt, "activity lock acquiredAt")
        : timestamp(value.heartbeatAt, "activity lock heartbeatAt")
      : timestamp(value.observedAt, "activity lock observedAt"),
  };
}

function publicReceipt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Persisted activity receipt is invalid.");
  const safeReceiptStatuses = new Set(["complete", "partial", "failed", "stopped", "unknown"]);
  const publicVerificationState = (candidate) => {
    const normalized = typeof candidate === "string" ? candidate.toLowerCase() : "unknown";
    if (normalized === "pass") return "PASS";
    if (normalized === "fail") return "FAIL";
    if (normalized === "stopped") return "STOPPED";
    if (normalized === "passed") return "PASS";
    if (normalized === "failed") return "FAIL";
    return "UNKNOWN";
  };
  const projectReadiness = value.projectReadiness?.status === "assessed"
    && value.projectReadiness?.value
    && typeof value.projectReadiness.value === "object"
    ? {
        status: "assessed",
        value: {
          earned: Number.isFinite(value.projectReadiness.value.earned) ? value.projectReadiness.value.earned : null,
          total: Number.isFinite(value.projectReadiness.value.total) ? value.projectReadiness.value.total : null,
          percent: Number.isFinite(value.projectReadiness.value.percent) ? value.projectReadiness.value.percent : null,
        },
        source: publicIdentifier(value.projectReadiness.source, "manifest"),
      }
    : { status: "not_assessed", value: null, source: null };
  const verifications = Array.isArray(value.verifications)
    ? value.verifications
    : Array.isArray(value.verification) ? value.verification : [];
  return {
    status: safeReceiptStatuses.has(value.status) ? value.status : "unknown",
    title: value.title === null || value.title === undefined ? null : publicText(value.title, null),
    summary: value.summary === null || value.summary === undefined ? null : publicText(value.summary, null, 2_000),
    completedAt: value.completedAt === null || value.completedAt === undefined
      ? null
      : timestamp(value.completedAt, "activity receipt completedAt"),
    durationSeconds: Number.isFinite(value.durationSeconds) && value.durationSeconds >= 0
      ? value.durationSeconds
      : null,
    duration: value.duration === null || value.duration === undefined ? null : publicText(value.duration, null, 32),
    taskResult: ["complete", "partial", "failed", "stopped", "unknown"].includes(value.taskResult)
      ? value.taskResult
      : safeReceiptStatuses.has(value.status) ? value.status : "unknown",
    projectReadiness,
    fixes: Array.isArray(value.fixes)
      ? value.fixes.slice(0, 100).map((item) => publicText(item, "Redacted item"))
      : [],
    verifications: verifications
      .slice(0, 100).map((item, index) => ({
          name: publicText(item?.name, `Check ${index + 1}`),
          status: publicVerificationState(item?.status ?? item?.state),
          exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null,
          durationMs: Number.isFinite(item?.durationMs) && item.durationMs >= 0
            ? item.durationMs
            : Number.isFinite(item?.durationSeconds) && item.durationSeconds >= 0
              ? item.durationSeconds * 1_000
            : null,
        })),
    remaining: Array.isArray(value.remaining)
      ? value.remaining.slice(0, 100).map((item) => publicText(item, "Redacted item"))
      : [],
  };
}

/** Allowlist a local activity snapshot. Prompts, transcripts, tool arguments, raw paths, and secrets are never projected. */
export function createPublicActivityProjection(record, options = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Persisted activity state is unavailable.");
  }
  if (!Number.isInteger(record.schemaVersion) || record.schemaVersion < 1) {
    throw new TypeError("Persisted activity state uses an unsupported schema.");
  }
  const generatedAt = timestamp(record.generatedAt, "generatedAt");
  const now = resolveInstant(options, generatedAt);
  const work = Array.isArray(record.work) ? record.work : [];
  const activeSource = Array.isArray(record.activeWork)
    ? record.activeWork
    : work.filter((item) => ["queued", "running", "waiting"].includes(item?.state));
  const finishedSource = Array.isArray(record.finishedWork)
    ? record.finishedWork
    : work.filter((item) => ["completed", "failed", "stopped"].includes(item?.state));
  const primaryLock = publicActivityLock(record.lock, "thread");
  const heartbeatAt = record.freshness?.heartbeatAt === null || record.freshness?.heartbeatAt === undefined
    ? null
    : timestamp(record.freshness.heartbeatAt, "activity heartbeatAt");
  const metricFallback = { value: null, truthClass: "unknown", source: "unknown", observedAt: null, unit: null };

  return {
    schemaVersion: record.schemaVersion,
    generatedAt,
    thread: {
      state: SAFE_THREAD_STATES.has(record.thread?.state) ? record.thread.state : "unknown",
      startedAt: record.thread?.startedAt === null || record.thread?.startedAt === undefined
        ? null
        : timestamp(record.thread.startedAt, "activity thread startedAt"),
    },
    progress: publicActivityProgress(record.progress),
    counts: {
      workflows: Number.isInteger(record.counts?.workflows) && record.counts.workflows >= 0 ? record.counts.workflows : null,
      skills: Number.isInteger(record.counts?.skills) && record.counts.skills >= 0 ? record.counts.skills : null,
      agents: Number.isInteger(record.counts?.agents) && record.counts.agents >= 0 ? record.counts.agents : null,
      tools: Number.isInteger(record.counts?.tools) && record.counts.tools >= 0 ? record.counts.tools : null,
    },
    usage: {
      contextRemainingPercent: record.usage?.contextRemainingPercent
        ? publicActivityMetric(record.usage.contextRemainingPercent)
        : metricFallback,
      quotaRemainingPercent: record.usage?.quotaRemainingPercent
        ? publicActivityMetric(record.usage.quotaRemainingPercent)
        : metricFallback,
      taskBudgetRemainingPercent: record.usage?.taskBudgetRemainingPercent
        ? publicActivityMetric(record.usage.taskBudgetRemainingPercent)
        : metricFallback,
    },
    lock: primaryLock,
    locks: (Array.isArray(record.locks) ? record.locks : [record.lock])
      .filter(Boolean)
      .slice(0, 250)
      .map((lock, index) => publicActivityLock(lock, index === 0 ? "thread" : `lock-${index + 1}`)),
    freshness: {
      heartbeatAt,
      ageSeconds: heartbeatAt === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - Date.parse(heartbeatAt)) / 1_000)),
    },
    capabilities: Object.fromEntries(Object.entries(record.capabilities ?? {})
      .filter(([key, value]) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key) && typeof value === "boolean")
      .sort(([left], [right]) => left.localeCompare(right))),
    activeWork: activeSource.slice(0, 1_000).map(publicActivityWorkItem),
    finishedWork: finishedSource.slice(0, 1_000).map(publicActivityWorkItem),
    lastReceipt: publicReceipt(record.lastReceipt ?? (record.outcome || Array.isArray(record.verifications)
      ? {
          ...(record.outcome ?? {}),
          taskResult: record.outcome?.status,
          projectReadiness: { status: "not_assessed", value: null, source: null },
          verifications: record.verifications ?? [],
        }
      : null)),
  };
}

function publicCheck(check, index) {
  if (check === null || typeof check !== "object" || Array.isArray(check)) {
    throw new TypeError("Persisted monitor check is invalid.");
  }
  const name = typeof check.name === "string" && check.name.trim() !== ""
    ? check.name.trim().slice(0, 100)
    : `Endpoint ${index + 1}`;
  const state = SAFE_CHECK_STATUSES.has(check.state) ? check.state : (check.ok === true ? "healthy" : "failing");
  const failureCode = check.ok === true
    ? null
    : SAFE_FAILURE_CODES.has(check.failure?.code) ? check.failure.code : "unknown_failure";
  return {
    name,
    status: state,
    ok: check.ok === true,
    lastAttemptAt: timestamp(check.completedAt, "check completedAt"),
    lastSuccessAt: nullableTimestamp(check.lastSuccessAt, "check lastSuccessAt"),
    lastFailureAt: nullableTimestamp(check.lastFailureAt, "check lastFailureAt"),
    recoveredAt: nullableTimestamp(check.recoveredAt, "check recoveredAt"),
    consecutiveFailures: nonnegativeInteger(check.consecutiveFailures),
    statusCode: safeStatusCode(check.statusCode),
    durationMs: Number.isFinite(check.durationMs) && check.durationMs >= 0 ? check.durationMs : null,
    failureCode,
  };
}

/** Allowlist the latest persisted monitor run. IDs, URLs, and error text never leave this adapter. */
export function createPublicMonitorProjection(record, options = {}) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Persisted monitor state is unavailable.");
  }
  if (record.schemaVersion !== 1 || record.recordType !== "project_status_monitor_run") {
    throw new TypeError("Persisted monitor state uses an unsupported schema.");
  }
  if (!Array.isArray(record.checks) || record.checks.length === 0 || record.checks.length > 50) {
    throw new TypeError("Persisted monitor checks are invalid.");
  }
  const completedAt = timestamp(record.completedAt, "completedAt");
  const nextDueAt = timestamp(record.nextDueAt, "nextDueAt");
  const now = resolveInstant(options, completedAt);
  const checks = record.checks.map(publicCheck);
  const healthy = checks.filter((check) => check.ok).length;
  const failing = checks.length - healthy;
  const recordedStatus = SAFE_RUN_STATUSES.has(record.status)
    ? record.status
    : failing === 0 ? "healthy" : healthy === 0 ? "failing" : "degraded";
  const stale = now.getTime() > Date.parse(nextDueAt);

  return {
    schemaVersion: 1,
    environment: typeof record.environment === "string" && record.environment.trim() !== ""
      ? record.environment.trim().slice(0, 64)
      : "unknown",
    status: stale ? "stale" : recordedStatus,
    recordedStatus,
    stale,
    lastAttemptAt: completedAt,
    lastSuccessAt: nullableTimestamp(record.lastSuccessAt, "lastSuccessAt"),
    lastFailureAt: nullableTimestamp(record.lastFailureAt, "lastFailureAt"),
    recoveredAt: nullableTimestamp(record.recoveredAt, "recoveredAt"),
    nextDueAt,
    cacheAgeSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(completedAt)) / 1000)),
    summary: {
      total: checks.length,
      healthy,
      failing,
      recovered: checks.filter((check) => check.recoveredAt === check.lastAttemptAt).length,
      maxConsecutiveFailures: Math.max(...checks.map((check) => check.consecutiveFailures)),
    },
    checks,
  };
}

function responseHeaders({ cacheControl, etag }) {
  return {
    "cache-control": cacheControl,
    "content-type": "application/json; charset=utf-8",
    etag,
    vary: "accept-encoding",
    "x-content-type-options": "nosniff",
  };
}

function jsonResponse(request, payload, { status = 200, cacheControl }) {
  const text = `${JSON.stringify(payload)}\n`;
  const etag = `"${sha256(payload)}"`;
  const headers = responseHeaders({ cacheControl, etag });
  if (request.headers.get("if-none-match") === etag && status === 200) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : text, { status, headers });
}

function errorResponse(request, status, code, extraHeaders = {}) {
  const payload = { schemaVersion: 1, error: code };
  const text = `${JSON.stringify(payload)}\n`;
  return new Response(request.method === "HEAD" ? null : text, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

/**
 * Handle only the status routes. Returns null for unrelated paths so a
 * worker/router can delegate to static assets. This function never probes.
 */
export async function handleStatusRequest(request, options = {}) {
  const pathname = new URL(request.url).pathname;
  if (!ROUTES.has(pathname)) return null;
  if (!["GET", "HEAD"].includes(request.method)) {
    return errorResponse(request, 405, "method_not_allowed", { allow: "GET, HEAD" });
  }

  if (pathname === "/status/manifest") {
    try {
      const projectionNow = resolveInstant(options, Date.now());
      if (options.now === undefined && options.clock === undefined) {
        projectionNow.setUTCSeconds(0, 0);
      }
      const projectionOptions = { now: projectionNow };
      const projection = createPublicProjection(options.manifest, projectionOptions);
      return jsonResponse(request, projection, {
        cacheControl: "public, max-age=60, stale-while-revalidate=300",
      });
    } catch {
      return errorResponse(request, 500, "status_manifest_unavailable");
    }
  }

  if (pathname === "/api/activity") {
    try {
      const latest = typeof options.readLatestActivityState === "function"
        ? await options.readLatestActivityState()
        : options.latestActivityState ?? null;
      if (latest === null) return errorResponse(request, 503, "activity_state_unavailable");
      const projection = createPublicActivityProjection(latest, options);
      return jsonResponse(request, projection, { cacheControl: "no-store" });
    } catch {
      return errorResponse(request, 503, "activity_state_unavailable");
    }
  }

  try {
    const latest = typeof options.readLatestMonitorState === "function"
      ? await options.readLatestMonitorState()
      : options.latestMonitorState ?? null;
    if (latest === null) return errorResponse(request, 503, "monitor_state_unavailable");
    const projection = createPublicMonitorProjection(latest, options);
    return jsonResponse(request, projection, {
      cacheControl: "public, max-age=15, stale-while-revalidate=45",
    });
  } catch {
    return errorResponse(request, 503, "monitor_state_unavailable");
  }
}

export function createStatusRequestHandler(options) {
  return (request) => handleStatusRequest(request, options);
}
