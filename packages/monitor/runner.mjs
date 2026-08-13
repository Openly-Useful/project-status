import { probeHttpTarget, normalizeProbeTarget } from "./probe.mjs";
import { assertMonitorRunRecord, MONITOR_RECORD_TYPE } from "./store.mjs";

function instant(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Injected monitor clock returned an invalid instant.");
  return date;
}

function normalizeConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("Monitor config must be an object.");
  }
  const allowed = new Set(["environment", "cadenceSeconds", "targets", "maxConcurrency"]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown monitor config property: ${key}`);
  }
  if (typeof config.environment !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(config.environment)) {
    throw new TypeError("Monitor environment must be a display label containing at most 64 safe characters.");
  }
  if (!Number.isInteger(config.cadenceSeconds) || config.cadenceSeconds < 1 || config.cadenceSeconds > 2_592_000) {
    throw new TypeError("Monitor cadenceSeconds must be an integer between 1 and 2,592,000.");
  }
  if (!Array.isArray(config.targets) || config.targets.length < 1 || config.targets.length > 50) {
    throw new TypeError("Monitor targets must contain between 1 and 50 entries.");
  }
  const targets = config.targets.map(normalizeProbeTarget);
  const ids = new Set();
  for (const target of targets) {
    if (ids.has(target.id)) throw new TypeError(`Duplicate monitor target id: ${target.id}`);
    ids.add(target.id);
  }
  const maxConcurrency = config.maxConcurrency ?? 4;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 10) {
    throw new TypeError("Monitor maxConcurrency must be an integer between 1 and 10.");
  }
  return { environment: config.environment, cadenceSeconds: config.cadenceSeconds, targets, maxConcurrency };
}

async function mapConcurrent(values, concurrency, operation) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function previousChecks(previousRun) {
  if (previousRun === null || previousRun === undefined) return new Map();
  assertMonitorRunRecord(previousRun);
  return new Map(previousRun.checks.map((check) => [check.id, check]));
}

function deriveCheck(probe, previous) {
  const priorFailures = Number.isInteger(previous?.consecutiveFailures) ? previous.consecutiveFailures : 0;
  if (probe.ok) {
    const recovered = priorFailures > 0 || previous?.state === "failing";
    return {
      ...probe,
      state: "healthy",
      consecutiveFailures: 0,
      transition: recovered ? "recovered" : null,
      lastSuccessAt: probe.completedAt,
      lastFailureAt: previous?.lastFailureAt ?? null,
      recoveredAt: recovered ? probe.completedAt : (previous?.recoveredAt ?? null),
    };
  }
  const newlyFailing = previous?.state !== "failing";
  return {
    ...probe,
    state: "failing",
    consecutiveFailures: priorFailures + 1,
    transition: newlyFailing ? "failed" : null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastFailureAt: probe.completedAt,
    recoveredAt: previous?.recoveredAt ?? null,
  };
}

/** Execute probes and derive a complete run record, without reading or writing a store. */
export async function executeMonitorRun(rawConfig, dependencies = {}) {
  const config = normalizeConfig(rawConfig);
  const {
    clock = () => new Date(),
    previousRun = null,
    probe = probeHttpTarget,
    probeDependencies = {},
  } = dependencies;
  if (typeof probe !== "function") throw new TypeError("Injected probe must be a function.");
  const applicablePrevious = previousRun?.environment === config.environment ? previousRun : null;
  const prior = previousChecks(applicablePrevious);
  const started = instant(clock);
  const probes = await mapConcurrent(config.targets, config.maxConcurrency, (target) => probe(target, {
    ...probeDependencies,
    clock: probeDependencies.clock ?? clock,
  }));
  const completed = instant(clock);
  const checks = probes.map((result) => {
    const previous = prior.get(result.id);
    return deriveCheck(result, previous?.url === result.url ? previous : undefined);
  });
  const healthy = checks.filter((check) => check.ok).length;
  const failing = checks.length - healthy;
  const status = failing === 0 ? "healthy" : healthy === 0 ? "failing" : "degraded";
  const nextDue = new Date(completed.getTime() + config.cadenceSeconds * 1000);
  const recovered = status === "healthy" && applicablePrevious !== null && applicablePrevious.status !== "healthy";
  const newlyUnhealthy = status !== "healthy" && applicablePrevious?.status === "healthy";

  return Object.freeze({
    schemaVersion: 1,
    recordType: MONITOR_RECORD_TYPE,
    environment: config.environment,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    nextDueAt: nextDue.toISOString(),
    cadenceSeconds: config.cadenceSeconds,
    status,
    transition: recovered ? "recovered" : newlyUnhealthy ? "degraded" : null,
    lastSuccessAt: status === "healthy" ? completed.toISOString() : (applicablePrevious?.lastSuccessAt ?? null),
    lastFailureAt: status !== "healthy" ? completed.toISOString() : (applicablePrevious?.lastFailureAt ?? null),
    recoveredAt: recovered ? completed.toISOString() : (applicablePrevious?.recoveredAt ?? null),
    summary: Object.freeze({
      total: checks.length,
      healthy,
      failing,
      recovered: checks.filter((check) => check.transition === "recovered").length,
      maxConsecutiveFailures: Math.max(...checks.map((check) => check.consecutiveFailures)),
    }),
    checks: Object.freeze(checks.map(Object.freeze)),
  });
}

/** The explicit persistence primitive. It never executes a probe. */
export async function recordRun(store, record) {
  if (store === null || typeof store?.append !== "function") throw new TypeError("A monitor run store is required.");
  assertMonitorRunRecord(record);
  await store.append(record);
  return record;
}

/** The explicit scheduled/CLI operation: read prior state, probe, then append one run. */
export async function runAndRecord(rawConfig, dependencies = {}) {
  const { store, ...runDependencies } = dependencies;
  if (store === null || typeof store?.readLatest !== "function" || typeof store?.append !== "function") {
    throw new TypeError("runAndRecord requires a store with readLatest and append methods.");
  }
  const previousRun = await store.readLatest();
  const record = await executeMonitorRun(rawConfig, { ...runDependencies, previousRun });
  await recordRun(store, record);
  return record;
}

/** Read-only by construction: this function has no probe dependency or callback. */
export async function readLatestRun(store) {
  if (store === null || typeof store?.readLatest !== "function") throw new TypeError("A monitor run store is required.");
  return store.readLatest();
}
