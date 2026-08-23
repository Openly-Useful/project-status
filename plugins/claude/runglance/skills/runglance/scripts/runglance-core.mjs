const SCHEMA_VERSION = 1;
const ENTITY_KINDS = new Set(["thread", "workflow", "skill", "agent", "tool"]);
const ENTITY_STATES = new Set(["queued", "running", "waiting", "completed", "failed", "stopped"]);
const EVENT_TYPES = new Set([
  "entity.started",
  "entity.updated",
  "entity.heartbeat",
  "entity.completed",
  "entity.failed",
  "entity.stopped",
  "lock.acquired",
  "lock.released",
  "verification.started",
  "verification.completed",
  "run.outcome",
]);
const TRUTH_CLASSES = new Set(["exact", "derived", "estimated", "unknown"]);
const ACTIVE_STATES = new Set(["queued", "running", "waiting"]);
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"]);
const OUTCOME_STATES = new Set(["complete", "partial", "failed", "stopped"]);
const VERIFICATION_STATES = new Set(["running", "passed", "failed", "stopped", "unknown"]);
const DEFAULT_STALE_AFTER_MS = 5_000;
const MAX_ID_LENGTH = 160;
const MAX_LABEL_LENGTH = 240;
const MAX_SUMMARY_LENGTH = 2_000;
const MAX_OUTPUT_LENGTH = 8_000;
const MAX_LIST_LENGTH = 50;
const MAX_ENTITIES = 1_000;
const MAX_VERIFICATIONS = 200;

export const ACTIVITY_SCHEMA_VERSION = SCHEMA_VERSION;
export const ACTIVITY_EVENT_TYPES = Object.freeze([...EVENT_TYPES]);
export const ACTIVITY_ENTITY_KINDS = Object.freeze([...ENTITY_KINDS]);
export const ACTIVITY_TRUTH_CLASSES = Object.freeze([...TRUTH_CLASSES]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function iso(value, field) {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an RFC 3339 timestamp`);
  return new Date(parsed).toISOString();
}

function boundedString(value, field, max = MAX_LABEL_LENGTH, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new Error(`${field} is required`);
  }
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim().slice(0, max);
}

function finiteNumber(value, field, { integer = false, min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  if (integer && !Number.isInteger(value)) throw new Error(`${field} must be an integer`);
  if (value < min || value > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return value;
}

function rejectUnknown(source, allowed, field) {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not allowed`);
  }
}

function normalizeStringList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > MAX_LIST_LENGTH) throw new Error(`${field} must contain at most ${MAX_LIST_LENGTH} entries`);
  return value.map((item, index) => boundedString(item, `${field}[${index}]`, MAX_SUMMARY_LENGTH));
}

function normalizeEntity(value, field = "entity") {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  rejectUnknown(value, new Set(["kind", "id", "name", "parentId"]), field);
  const kind = boundedString(value.kind, `${field}.kind`, 32);
  if (!ENTITY_KINDS.has(kind)) throw new Error(`${field}.kind must be one of: ${[...ENTITY_KINDS].join(", ")}`);
  return {
    kind,
    id: boundedString(value.id, `${field}.id`, MAX_ID_LENGTH),
    name: value.name === undefined || value.name === null ? null : boundedString(value.name, `${field}.name`, MAX_LABEL_LENGTH),
    parentId: value.parentId === undefined || value.parentId === null ? null : boundedString(value.parentId, `${field}.parentId`, MAX_ID_LENGTH),
  };
}

function normalizeProgress(value, field = "progress") {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  rejectUnknown(value, new Set(["completed", "total"]), field);
  const completed = finiteNumber(value.completed, `${field}.completed`, { min: 0 });
  const total = finiteNumber(value.total, `${field}.total`, { min: 0 });
  if (total === 0 && completed !== 0) throw new Error(`${field}.completed must be 0 when total is 0`);
  if (completed > total) throw new Error(`${field}.completed must not exceed total`);
  return { completed, total };
}

function normalizeMetric(value, field) {
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  rejectUnknown(value, new Set(["value", "truthClass", "source", "observedAt", "unit"]), field);
  const truthClass = boundedString(value.truthClass, `${field}.truthClass`, 32);
  if (!TRUTH_CLASSES.has(truthClass)) throw new Error(`${field}.truthClass must be one of: ${[...TRUTH_CLASSES].join(", ")}`);
  if (truthClass === "unknown" && value.value !== null) throw new Error(`${field}.value must be null when truthClass is unknown`);
  if (truthClass !== "unknown" && value.value === null) throw new Error(`${field}.value must not be null when truthClass is ${truthClass}`);
  if (!["string", "number", "boolean"].includes(typeof value.value) && value.value !== null) {
    throw new Error(`${field}.value must be a string, number, boolean, or null`);
  }
  if (typeof value.value === "number" && !Number.isFinite(value.value)) throw new Error(`${field}.value must be finite`);
  return {
    value: value.value,
    truthClass,
    source: boundedString(value.source, `${field}.source`, MAX_LABEL_LENGTH),
    observedAt: value.observedAt === null || value.observedAt === undefined ? null : iso(value.observedAt, `${field}.observedAt`),
    ...(value.unit === undefined ? {} : { unit: boundedString(value.unit, `${field}.unit`, 64) }),
  };
}

function normalizeMetrics(value, field = "metrics") {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  if (Object.keys(value).length > 50) throw new Error(`${field} must contain at most 50 metrics`);
  return Object.fromEntries(Object.entries(value).map(([key, metric]) => {
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key)) throw new Error(`${field}.${key} has an invalid key`);
    return [key, normalizeMetric(metric, `${field}.${key}`)];
  }));
}

function normalizeVerification(value, type) {
  if (!isObject(value)) throw new Error("verification must be an object");
  rejectUnknown(value, new Set(["id", "name", "command", "status", "exitCode", "durationMs", "output", "rerun"]), "verification");
  if (!Array.isArray(value.command) || value.command.length === 0 || value.command.length > 100) {
    throw new Error("verification.command must contain between 1 and 100 arguments");
  }
  const status = boundedString(value.status ?? (type === "verification.started" ? "running" : null), "verification.status", 32);
  if (!VERIFICATION_STATES.has(status)) throw new Error(`verification.status must be one of: ${[...VERIFICATION_STATES].join(", ")}`);
  if (type === "verification.started" && status !== "running") throw new Error("verification.started status must be running");
  const exitCode = value.exitCode === null || value.exitCode === undefined
    ? null
    : finiteNumber(value.exitCode, "verification.exitCode", { integer: true, min: 0, max: 255 });
  if (status === "passed" && exitCode !== 0) throw new Error("verification status passed requires exitCode 0");
  if (type === "verification.completed" && status === "running") throw new Error("verification.completed status must be terminal");
  return {
    id: boundedString(value.id, "verification.id", MAX_ID_LENGTH),
    name: boundedString(value.name, "verification.name", MAX_LABEL_LENGTH),
    command: value.command.map((arg, index) => boundedString(arg, `verification.command[${index}]`, MAX_SUMMARY_LENGTH)),
    status,
    exitCode,
    durationMs: value.durationMs === null || value.durationMs === undefined
      ? null
      : finiteNumber(value.durationMs, "verification.durationMs", { min: 0 }),
    output: value.output === null || value.output === undefined ? null : String(value.output).slice(-MAX_OUTPUT_LENGTH),
    rerun: value.rerun === null || value.rerun === undefined ? null : boundedString(value.rerun, "verification.rerun", MAX_SUMMARY_LENGTH),
  };
}

function normalizeOutcome(value) {
  if (!isObject(value)) throw new Error("outcome must be an object");
  rejectUnknown(value, new Set(["status", "summary", "fixes", "remaining"]), "outcome");
  const status = boundedString(value.status, "outcome.status", 32);
  if (!OUTCOME_STATES.has(status)) throw new Error(`outcome.status must be one of: ${[...OUTCOME_STATES].join(", ")}`);
  return {
    status,
    summary: value.summary === undefined || value.summary === null ? null : boundedString(value.summary, "outcome.summary", MAX_SUMMARY_LENGTH),
    fixes: normalizeStringList(value.fixes, "outcome.fixes"),
    remaining: normalizeStringList(value.remaining, "outcome.remaining"),
  };
}

function nowIso(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("clock returned an invalid date");
  return date.toISOString();
}

export function normalizeActivityEvent(input, { clock = () => new Date() } = {}) {
  if (!isObject(input)) throw new Error("event must be an object");
  rejectUnknown(input, new Set([
    "schemaVersion", "eventId", "sequence", "sessionId", "observedAt", "source", "type",
    "entity", "state", "progress", "metrics", "heartbeatAt", "lock", "verification", "outcome",
  ]), "event");
  if (input.schemaVersion !== undefined && input.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`event.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const type = boundedString(input.type, "event.type", 64);
  if (!EVENT_TYPES.has(type)) throw new Error(`event.type must be one of: ${[...EVENT_TYPES].join(", ")}`);
  const observedAt = input.observedAt === undefined ? nowIso(clock) : iso(input.observedAt, "event.observedAt");
  const sessionId = boundedString(input.sessionId, "event.sessionId", MAX_ID_LENGTH);
  const sequence = finiteNumber(input.sequence, "event.sequence", { integer: true, min: 1 });
  const event = {
    schemaVersion: SCHEMA_VERSION,
    eventId: boundedString(input.eventId ?? `${sessionId}:${sequence}`, "event.eventId", MAX_ID_LENGTH),
    sequence,
    sessionId,
    observedAt,
    source: boundedString(input.source ?? "manual", "event.source", MAX_LABEL_LENGTH),
    type,
  };

  if (type.startsWith("entity.")) {
    event.entity = normalizeEntity(input.entity);
    const impliedState = type === "entity.started" ? "running"
      : type === "entity.completed" ? "completed"
        : type === "entity.failed" ? "failed"
          : type === "entity.stopped" ? "stopped"
            : null;
    const state = input.state ?? impliedState;
    if (state !== undefined && state !== null) {
      if (!ENTITY_STATES.has(state)) throw new Error(`event.state must be one of: ${[...ENTITY_STATES].join(", ")}`);
      if (impliedState && state !== impliedState) throw new Error(`${type} requires state ${impliedState}`);
      event.state = state;
    }
    if (type === "entity.updated" && !event.state && input.progress === undefined && input.metrics === undefined) {
      throw new Error("entity.updated requires state, progress, or metrics");
    }
    event.progress = normalizeProgress(input.progress);
    event.metrics = normalizeMetrics(input.metrics);
    for (const metric of Object.values(event.metrics)) {
      if (metric.observedAt === null && metric.truthClass !== "unknown") metric.observedAt = observedAt;
    }
    event.heartbeatAt = input.heartbeatAt === undefined ? observedAt : iso(input.heartbeatAt, "event.heartbeatAt");
  } else if (type.startsWith("lock.")) {
    if (!isObject(input.lock)) throw new Error("event.lock must be an object");
    rejectUnknown(input.lock, new Set(["owner"]), "event.lock");
    event.lock = {
      owner: type === "lock.acquired" ? boundedString(input.lock.owner, "event.lock.owner", MAX_LABEL_LENGTH) : null,
    };
  } else if (type.startsWith("verification.")) {
    event.verification = normalizeVerification(input.verification, type);
  } else if (type === "run.outcome") {
    event.outcome = normalizeOutcome(input.outcome);
  }
  return event;
}

export function validateActivityEvent(input, options = {}) {
  try {
    return { valid: true, event: normalizeActivityEvent(input, options), errors: [] };
  } catch (error) {
    return { valid: false, event: null, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function createActivityState(sessionId = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    startedAt: null,
    updatedAt: null,
    lastSequence: 0,
    eventIds: [],
    entities: {},
    metrics: {},
    lock: { state: "unknown", owner: null, observedAt: null },
    verifications: {},
    verificationOrder: [],
    outcome: null,
  };
}

function copyState(state) {
  return structuredClone(state);
}

export function reduceActivityEvent(previous, input, options = {}) {
  const event = normalizeActivityEvent(input, options);
  const state = copyState(previous ?? createActivityState(event.sessionId));
  if (state.sessionId && state.sessionId !== event.sessionId) throw new Error("cannot reduce events from different sessions");
  if (state.eventIds.includes(event.eventId)) return state;
  if (event.sequence <= state.lastSequence) throw new Error("event.sequence must increase monotonically");
  state.sessionId = event.sessionId;
  state.startedAt ??= event.observedAt;
  state.updatedAt = event.observedAt;
  state.lastSequence = event.sequence;
  state.eventIds.push(event.eventId);
  if (state.eventIds.length > 2_000) state.eventIds = state.eventIds.slice(-2_000);

  if (event.type.startsWith("entity.")) {
    const key = `${event.entity.kind}:${event.entity.id}`;
    const isNewEntity = state.entities[key] === undefined;
    if (isNewEntity && Object.keys(state.entities).length >= MAX_ENTITIES) {
      throw new Error(`activity state supports at most ${MAX_ENTITIES} entities per session`);
    }
    const prior = state.entities[key] ?? {
      ...event.entity,
      state: "queued",
      progress: null,
      metrics: {},
      startedAt: null,
      completedAt: null,
      heartbeatAt: null,
      updatedAt: null,
    };
    const next = { ...prior, ...event.entity };
    next.name = event.entity.name ?? prior.name;
    next.parentId = event.entity.parentId ?? prior.parentId;
    next.state = event.state ?? prior.state;
    next.progress = event.progress ?? prior.progress;
    next.metrics = { ...prior.metrics, ...event.metrics };
    next.heartbeatAt = event.heartbeatAt ?? prior.heartbeatAt;
    next.updatedAt = event.observedAt;
    if (event.type === "entity.started" || (isNewEntity && ACTIVE_STATES.has(next.state))) next.startedAt ??= event.observedAt;
    if (TERMINAL_STATES.has(next.state)) next.completedAt = event.observedAt;
    state.entities[key] = next;
    state.metrics = { ...state.metrics, ...event.metrics };
  } else if (event.type === "lock.acquired") {
    state.lock = { state: "locked", owner: event.lock.owner, observedAt: event.observedAt };
  } else if (event.type === "lock.released") {
    state.lock = { state: "unlocked", owner: null, observedAt: event.observedAt };
  } else if (event.type.startsWith("verification.")) {
    const prior = state.verifications[event.verification.id] ?? {};
    state.verifications[event.verification.id] = {
      ...prior,
      ...event.verification,
      startedAt: prior.startedAt ?? event.observedAt,
      completedAt: event.type === "verification.completed" ? event.observedAt : null,
    };
    if (!state.verificationOrder.includes(event.verification.id)) state.verificationOrder.push(event.verification.id);
    while (state.verificationOrder.length > MAX_VERIFICATIONS) {
      const removed = state.verificationOrder.shift();
      delete state.verifications[removed];
    }
  } else if (event.type === "run.outcome") {
    state.outcome = { ...event.outcome, observedAt: event.observedAt };
  }
  return state;
}

export function reduceActivityEvents(inputs, { initialState = null, ...options } = {}) {
  if (!Array.isArray(inputs)) throw new Error("events must be an array");
  return inputs.reduce((state, event) => reduceActivityEvent(state, event, options), initialState);
}

function unknownMetric(source = "runtime") {
  return { value: null, truthClass: "unknown", source, observedAt: null };
}

function deriveRemaining(used, key) {
  if (!used || typeof used.value !== "number") return null;
  const value = Math.max(0, Math.min(100, 100 - used.value));
  return { value, truthClass: "derived", source: `${used.source}:${key}`, observedAt: used.observedAt, unit: "percent" };
}

function metricFromState(state, direct, used, source) {
  return state.metrics[direct] ?? deriveRemaining(state.metrics[used], used) ?? unknownMetric(source);
}

function aggregateProgress(entities) {
  const priority = ["thread", "workflow"];
  for (const kind of priority) {
    const candidates = entities.filter((entity) => entity.kind === kind && entity.progress !== null);
    if (candidates.length === 0) continue;
    const completed = candidates.reduce((sum, entity) => sum + entity.progress.completed, 0);
    const total = candidates.reduce((sum, entity) => sum + entity.progress.total, 0);
    if (total <= 0) return { mode: "indeterminate", completed: null, total: null, percent: null };
    return { mode: "determinate", completed, total, percent: Math.round((completed / total) * 1_000) / 10 };
  }
  return entities.some((entity) => ACTIVE_STATES.has(entity.state))
    ? { mode: "indeterminate", completed: null, total: null, percent: null }
    : { mode: "unavailable", completed: null, total: null, percent: null };
}

export function createActivitySnapshot(state, { clock = () => new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS } = {}) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION) throw new Error("activity state is invalid");
  const generatedAt = nowIso(clock);
  const generatedMs = Date.parse(generatedAt);
  const entities = Object.values(state.entities).sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)).slice(0, 1_000);
  const active = entities.filter((entity) => ACTIVE_STATES.has(entity.state));
  const activeWork = active.slice(0, 200);
  const finishedWork = entities
    .filter((entity) => TERMINAL_STATES.has(entity.state))
    .sort((left, right) => String(right.completedAt ?? right.updatedAt).localeCompare(String(left.completedAt ?? left.updatedAt)))
    .slice(0, 200);
  const heartbeatAt = active.map((entity) => entity.heartbeatAt).filter(Boolean).sort().at(-1) ?? state.updatedAt;
  const ageSeconds = heartbeatAt ? Math.max(0, Math.floor((generatedMs - Date.parse(heartbeatAt)) / 1_000)) : null;
  const isStale = active.length > 0 && ageSeconds !== null && ageSeconds * 1_000 > staleAfterMs;
  let threadState = "ready";
  if (state.lock.state === "locked") threadState = "locked";
  else if (isStale) threadState = "stale";
  else if (active.some((entity) => entity.state === "running" || entity.state === "queued")) threadState = "running";
  else if (active.some((entity) => entity.state === "waiting")) threadState = "waiting";
  else if (!state.startedAt) threadState = "unknown";
  else if (state.outcome?.status === "failed") threadState = "failed";
  else if (state.outcome?.status === "stopped") threadState = "stopped";

  const counts = {};
  for (const kind of ["workflow", "skill", "agent", "tool"]) {
    counts[kind === "workflow" ? "workflows" : `${kind}s`] = active.filter((entity) => entity.kind === kind).length;
  }
  const verifications = state.verificationOrder.map((id) => state.verifications[id]).filter(Boolean);
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: state.sessionId,
    generatedAt,
    thread: { state: threadState, startedAt: state.startedAt },
    progress: aggregateProgress(entities),
    counts,
    usage: {
      contextRemainingPercent: metricFromState(state, "contextRemainingPercent", "contextUsedPercent", "host"),
      quotaRemainingPercent: metricFromState(state, "quotaRemainingPercent", "quotaUsedPercent", "provider"),
      taskBudgetRemainingPercent: metricFromState(state, "taskBudgetRemainingPercent", "taskBudgetUsedPercent", "orchestrator"),
    },
    lock: { ...state.lock },
    freshness: { heartbeatAt, ageSeconds },
    entities,
    activeWork,
    finishedWork,
    verifications,
    outcome: state.outcome,
    capabilities: {
      progress: entities.some((entity) => entity.progress !== null),
      context: state.metrics.contextRemainingPercent !== undefined || state.metrics.contextUsedPercent !== undefined,
      quota: state.metrics.quotaRemainingPercent !== undefined || state.metrics.quotaUsedPercent !== undefined,
      locks: state.lock.state !== "unknown",
      verifications: verifications.length > 0,
    },
  };
  snapshot.lastReceipt = state.outcome ? createRunReceipt(snapshot) : null;
  return snapshot;
}

function visibleLength(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "").length;
}

function truncate(value, width) {
  const text = String(value);
  if (visibleLength(text) <= width) return text;
  if (width < 2) return text.slice(0, width);
  return `${text.slice(0, width - 1)}…`;
}

function metricLabel(metric, prefix) {
  if (!metric || metric.value === null) return `${prefix}—`;
  const marker = metric.truthClass === "estimated" ? "~" : "";
  return `${prefix}${marker}${Math.round(Number(metric.value))}%`;
}

function progressBar(progress, { ascii = false, cells = 10 } = {}) {
  if (progress.mode === "unavailable") return "—";
  if (progress.mode === "indeterminate") return ascii ? "[working]" : "[working]";
  const filled = Math.max(0, Math.min(cells, Math.round((progress.percent / 100) * cells)));
  return `[${(ascii ? "#" : "■").repeat(filled)}${(ascii ? "-" : "□").repeat(cells - filled)}] ${progress.percent}%`;
}

function durationLabel(startedAt, generatedAt) {
  if (!startedAt) return "—";
  const total = Math.max(0, Math.floor((Date.parse(generatedAt) - Date.parse(startedAt)) / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stateLabel(state) {
  return String(state ?? "unknown").replace(/^./, (value) => value.toUpperCase());
}

export function renderActivity(snapshot, {
  preset = "compact",
  width = 100,
  ascii = false,
  isTTY = true,
  color = false,
} = {}) {
  void color;
  if (preset === "json") return JSON.stringify(snapshot, null, 2);
  if (!["compact", "standard", "swarm", "diagnostic"].includes(preset)) throw new Error("preset must be compact, standard, swarm, diagnostic, or json");
  const safeWidth = Number.isFinite(width) ? Math.max(20, Math.floor(width)) : 100;
  const state = stateLabel(snapshot.thread.state);
  const bar = progressBar(snapshot.progress, { ascii });
  const counts = `W${snapshot.counts.workflows} S${snapshot.counts.skills} A${snapshot.counts.agents}`;
  const context = metricLabel(snapshot.usage.contextRemainingPercent, "C");
  const quota = metricLabel(snapshot.usage.quotaRemainingPercent, "Q");
  const elapsed = durationLabel(snapshot.thread.startedAt, snapshot.generatedAt);
  const live = snapshot.freshness.ageSeconds === null ? "L—" : `L${snapshot.freshness.ageSeconds}s`;
  let compact;
  if (safeWidth < 60) compact = `${state} ${snapshot.progress.percent === null ? bar : `${snapshot.progress.percent}%`} · ${counts} · ${context}`;
  else if (safeWidth < 100) compact = `${state} · ${bar} · ${counts} · ${context} ${quota} · ${elapsed} · ${live}`;
  else compact = `${state} · ${bar} · Workflows ${snapshot.counts.workflows} · Skills ${snapshot.counts.skills} · Agents ${snapshot.counts.agents} · Context ${metricLabel(snapshot.usage.contextRemainingPercent, "").replace("—", "—")} left · Quota ${metricLabel(snapshot.usage.quotaRemainingPercent, "").replace("—", "—")} left · ${elapsed} · Live ${snapshot.freshness.ageSeconds ?? "—"}s`;
  compact = truncate(compact, safeWidth);
  if (preset === "compact" || !isTTY) return compact;

  const active = snapshot.entities.filter((entity) => ACTIVE_STATES.has(entity.state));
  if (preset === "standard") {
    const current = active[0];
    const detail = current
      ? `${stateLabel(current.state)} · ${current.name ?? current.id} · ${current.kind}`
      : `No active work · Lock ${snapshot.lock.state}`;
    return `${compact}\n${truncate(detail, safeWidth)}`;
  }
  if (preset === "swarm") {
    const agents = snapshot.entities.filter((entity) => entity.kind === "agent");
    const rows = agents.length === 0 ? ["Agents —"] : agents.map((agent) => {
      const agentProgress = agent.progress ? progressBar({ mode: "determinate", ...agent.progress, percent: Math.round((agent.progress.completed / Math.max(1, agent.progress.total)) * 1_000) / 10 }, { ascii, cells: 8 }) : "[working]";
      return truncate(`${stateLabel(agent.state).padEnd(9)} ${agentProgress} ${agent.name ?? agent.id}`, safeWidth);
    });
    return [compact, ...rows].join("\n");
  }
  const truth = (metric) => metric?.truthClass ?? "unknown";
  return [
    compact,
    `Session ${snapshot.sessionId ?? "—"} · Thread ${snapshot.thread.state} · Lock ${snapshot.lock.state}${snapshot.lock.owner ? ` (${snapshot.lock.owner})` : ""}`,
    `Context ${metricLabel(snapshot.usage.contextRemainingPercent, "")} (${truth(snapshot.usage.contextRemainingPercent)}) · Quota ${metricLabel(snapshot.usage.quotaRemainingPercent, "")} (${truth(snapshot.usage.quotaRemainingPercent)})`,
    `Entities ${snapshot.entities.length} · Verifications ${snapshot.verifications.length} · Heartbeat ${snapshot.freshness.heartbeatAt ?? "—"}`,
  ].map((line) => truncate(line, safeWidth)).join("\n");
}

function verificationResultLabel(verification) {
  if (verification.status === "passed" && verification.exitCode === 0) return "PASS";
  if (verification.status === "failed") return "FAIL";
  if (verification.status === "stopped") return "STOPPED";
  return "UNKNOWN";
}

function formatMilliseconds(value) {
  if (value === null || value === undefined) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

export function createRunReceipt(snapshot) {
  const outcome = snapshot.outcome ?? { status: "partial", summary: null, fixes: [], remaining: [] };
  const verifications = snapshot.verifications.map((verification) => ({
    id: verification.id,
    name: verification.name,
    status: verificationResultLabel(verification),
    exitCode: verification.exitCode,
    durationMs: verification.durationMs,
    rerun: verification.rerun,
    command: verification.command,
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: snapshot.sessionId,
    completedAt: outcome.observedAt ?? snapshot.generatedAt,
    status: outcome.status,
    taskResult: outcome.status,
    projectReadiness: { status: "not_assessed", value: null, source: null },
    summary: outcome.summary,
    fixes: [...outcome.fixes],
    verifications,
    remaining: [...outcome.remaining],
    duration: durationLabel(snapshot.thread.startedAt, outcome.observedAt ?? snapshot.generatedAt),
    counts: {
      workflows: snapshot.entities.filter((entity) => entity.kind === "workflow").length,
      skills: snapshot.entities.filter((entity) => entity.kind === "skill").length,
      agents: snapshot.entities.filter((entity) => entity.kind === "agent").length,
    },
  };
}

export function renderRunReceipt(snapshotOrReceipt, { format = "text" } = {}) {
  const receipt = snapshotOrReceipt?.thread ? createRunReceipt(snapshotOrReceipt) : structuredClone(snapshotOrReceipt);
  if (format === "json") return JSON.stringify(receipt, null, 2);
  if (!["text", "markdown"].includes(format)) throw new Error("receipt format must be text, markdown, or json");
  const passed = receipt.status === "complete" ? "✓" : receipt.status === "failed" ? "✗" : "•";
  const title = `${passed} Run ${receipt.status}${receipt.summary ? ` — ${receipt.summary}` : ""}`;
  const verificationLines = receipt.verifications.length === 0
    ? ["UNKNOWN  No verification was recorded"]
    : receipt.verifications.map((item) => `${item.status.padEnd(7)} ${item.name} · exit ${item.exitCode ?? "—"} · ${formatMilliseconds(item.durationMs)}`);
  const reruns = receipt.verifications.filter((item) => item.rerun || item.command?.length).map((item) => item.rerun ?? item.command.join(" "));
  if (format === "markdown") {
    return [
      `## ${title}`,
      "",
      "### Result",
      `- Task result: ${receipt.taskResult}`,
      "- Project readiness: not assessed",
      "",
      "### Fixed",
      ...(receipt.fixes.length ? receipt.fixes.map((item) => `- ${item}`) : ["- No fixes were declared."]),
      "",
      "### Verification",
      ...verificationLines.map((item) => `- ${item}`),
      ...(reruns.length ? ["", "### Re-run", ...reruns.map((item) => `- \`${item}\``)] : []),
      "",
      "### Remaining",
      ...(receipt.remaining.length ? receipt.remaining.map((item) => `- ${item}`) : ["- None declared."]),
      "",
      `Completed in ${receipt.duration} · ${receipt.counts.agents} agents`,
    ].join("\n");
  }
  return [
    title,
    "",
    "RESULT",
    `Task result: ${receipt.taskResult}`,
    "Project readiness: not assessed",
    "",
    "FIXED",
    ...(receipt.fixes.length ? receipt.fixes.map((item) => `- ${item}`) : ["- No fixes were declared."]),
    "",
    "VERIFICATION",
    ...verificationLines,
    ...(reruns.length ? ["", "RE-RUN", ...reruns.map((item) => `$ ${item}`)] : []),
    "",
    "REMAINING",
    ...(receipt.remaining.length ? receipt.remaining.map((item) => `- ${item}`) : ["- None declared."]),
    "",
    `Completed in ${receipt.duration} · ${receipt.counts.agents} agents`,
  ].join("\n");
}

export function redactActivityText(value, {
  homeDirectory = null,
  workingDirectory = null,
  maxLength = MAX_OUTPUT_LENGTH,
} = {}) {
  let output = String(value ?? "");
  const replacements = [
    [homeDirectory, "<home>"],
    [workingDirectory, "<cwd>"],
  ].filter(([needle]) => typeof needle === "string" && needle.length > 1).sort((left, right) => right[0].length - left[0].length);
  for (const [needle, replacement] of replacements) output = output.split(needle).join(replacement);
  output = output
    .replace(/\b(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, "<redacted>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer <redacted>")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*=\s*([^\s]+)/g, "$1=<redacted>")
    .replace(/(?:^|\s)(\/(?:Users|home|private|var|tmp)\/[^\s]+)/g, (match, path) => match.replace(path, `<path>/${path.split("/").filter(Boolean).at(-1) ?? "item"}`));
  return output.length > maxLength ? output.slice(-maxLength) : output;
}

export function redactActivityEvent(input, options = {}) {
  const event = normalizeActivityEvent(input, options);
  const redacted = structuredClone(event);
  const clean = (value, maxLength) => redactActivityText(value, { ...options, maxLength });
  redacted.source = clean(redacted.source, MAX_LABEL_LENGTH);
  if (redacted.entity) {
    redacted.entity.name = redacted.entity.name === null ? null : clean(redacted.entity.name, MAX_LABEL_LENGTH);
    redacted.entity.parentId = redacted.entity.parentId === null ? null : clean(redacted.entity.parentId, MAX_ID_LENGTH);
  }
  if (redacted.lock?.owner) redacted.lock.owner = clean(redacted.lock.owner, MAX_LABEL_LENGTH);
  if (redacted.verification) {
    redacted.verification.name = clean(redacted.verification.name, MAX_LABEL_LENGTH);
    redacted.verification.command = redacted.verification.command.map((arg) => clean(arg, MAX_SUMMARY_LENGTH));
    if (redacted.verification.output !== null) redacted.verification.output = clean(redacted.verification.output, MAX_OUTPUT_LENGTH);
    if (redacted.verification.rerun !== null) redacted.verification.rerun = clean(redacted.verification.rerun, MAX_SUMMARY_LENGTH);
  }
  if (redacted.outcome) {
    if (redacted.outcome.summary !== null) redacted.outcome.summary = clean(redacted.outcome.summary, MAX_SUMMARY_LENGTH);
    redacted.outcome.fixes = redacted.outcome.fixes.map((item) => clean(item, MAX_SUMMARY_LENGTH));
    redacted.outcome.remaining = redacted.outcome.remaining.map((item) => clean(item, MAX_SUMMARY_LENGTH));
  }
  return redacted;
}
