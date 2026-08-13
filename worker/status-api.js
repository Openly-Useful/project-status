import { createPublicProjection, sha256 } from "../packages/core/index.mjs";

const ROUTES = new Set(["/status/manifest", "/api/status"]);
const SAFE_RUN_STATUSES = new Set(["healthy", "degraded", "failing"]);
const SAFE_CHECK_STATUSES = new Set(["healthy", "failing"]);
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
 * Handle only the two status routes. Returns null for unrelated paths so a
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
      const projectionOptions = options.now === undefined && options.clock === undefined
        ? {}
        : { now: resolveInstant(options, options.manifest?.audit?.evidenceAsOf) };
      const projection = createPublicProjection(options.manifest, projectionOptions);
      return jsonResponse(request, projection, {
        cacheControl: "public, max-age=60, stale-while-revalidate=300",
      });
    } catch {
      return errorResponse(request, 500, "status_manifest_unavailable");
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
