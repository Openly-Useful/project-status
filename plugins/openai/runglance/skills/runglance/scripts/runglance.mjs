#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createActivitySnapshot,
  createActivityState,
  createRunReceipt,
  normalizeActivityEvent,
  redactActivityEvent,
  redactActivityText,
  reduceActivityEvent,
  reduceActivityEvents,
  renderActivity,
  renderRunReceipt,
} from "./runglance-core.mjs";
import { isDirectExecution } from "./entrypoint.mjs";

const MAX_EVENT_BYTES = 1_048_576;
const MAX_EVENT_LINES = 2_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const RETENTION_OPTIONS = new Set([0, 7]);
const VALUE_OPTIONS = new Set([
  "--runtime-dir", "--session-id", "--source", "--event", "--kind", "--id", "--name", "--parent-id",
  "--state", "--completed", "--total", "--context-used", "--context-remaining", "--quota-used", "--quota-remaining",
  "--task-budget-used", "--task-budget-remaining", "--truth", "--retention-days", "--preset", "--width", "--interval",
  "--final-summary", "--format", "--outcome", "--summary", "--fix", "--remaining", "--output", "--limit", "--now",
  "--lock-owner", "--project-root", "--host",
]);
const BOOLEAN_OPTIONS = new Set(["--json", "--ascii", "--once", "--heartbeat", "--replace", "--unlock"]);

function parse(argv) {
  const separator = argv.indexOf("--");
  const commandArgs = separator === -1 ? [] : argv.slice(separator + 1);
  const input = separator === -1 ? argv : argv.slice(0, separator);
  const command = input.shift();
  const subcommand = command === "setup" && input[0] && !input[0].startsWith("--") ? input.shift() : null;
  const options = {
    command,
    subcommand,
    commandArgs,
    json: false,
    ascii: false,
    once: false,
    heartbeat: false,
    fixes: [],
    remaining: [],
  };
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (BOOLEAN_OPTIONS.has(arg)) {
      options[arg.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      const value = input[index + 1];
      if (value === undefined || value === "--") throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--fix") options.fixes.push(value);
      else if (arg === "--remaining") options.remaining.push(value);
      else options[arg.slice(2).replaceAll("-", "_")] = value;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return parsed;
}

function numeric(value, field, { min = 0, max = 100, fallback = null } = {}) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${field} must be between ${min} and ${max}`);
  return parsed;
}

function clockFromOptions(options) {
  if (!options.now) return () => new Date();
  const timestamp = Date.parse(options.now);
  if (!Number.isFinite(timestamp)) throw new Error("--now must be an RFC 3339 timestamp");
  return () => new Date(timestamp);
}

function runtimeRoot(options = {}) {
  const configured = options.runtime_dir ?? process.env.RUNGLANCE_RUNTIME_DIR;
  if (configured) return resolve(configured);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `runglance-${uid}`, "runtime");
}

function sessionPaths(root, sessionId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(sessionId)) throw new Error("session id contains unsupported characters");
  const directory = join(root, "sessions");
  return {
    directory,
    events: join(directory, `${sessionId}.jsonl`),
    snapshot: join(directory, `${sessionId}.snapshot.json`),
    state: join(directory, `${sessionId}.state.json`),
    metadata: join(directory, `${sessionId}.metadata.json`),
  };
}

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
}

function atomicWrite(path, contents) {
  ensureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function activeSessionPath(root) {
  return join(root, "active-session.json");
}

function latestSnapshotPath(root) {
  return join(root, "activity-snapshot.json");
}

function getSessionId(root, requested) {
  if (requested) return requested;
  const active = readJson(activeSessionPath(root));
  if (!active?.sessionId) throw new Error("No active RunGlance session. Run `runglance.mjs start` or pass --session-id.");
  return active.sessionId;
}

function readEvents(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return [];
  return text.trimEnd().split("\n").map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid activity JSONL at line ${index + 1}`); }
  });
}

function loadState(root, sessionId, clock) {
  const paths = sessionPaths(root, sessionId);
  const events = readEvents(paths.events);
  const persistedState = readJson(paths.state);
  return {
    paths,
    events,
    state: persistedState?.schemaVersion === 1
      ? persistedState
      : events.length ? reduceActivityEvents(events, { clock }) : createActivityState(sessionId),
    metadata: readJson(paths.metadata, { retentionDays: 0, createdAt: null }),
  };
}

function withWriteLock(root, callback) {
  ensureDirectory(root);
  const lock = join(root, ".activity-write-lock");
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try { return callback(); }
      finally { if (existsSync(lock)) rmdirSync(lock); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5_000) {
          rmdirSync(lock);
          continue;
        }
      } catch (staleError) {
        if (staleError?.code !== "ENOENT") throw staleError;
      }
      Atomics.wait(waitBuffer, 0, 0, 5);
    }
  }
  throw new Error("Timed out waiting for the activity writer lock");
}

function compactEventLog(path) {
  if (!existsSync(path) || statSync(path).size <= MAX_EVENT_BYTES) return;
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const retained = lines.slice(-MAX_EVENT_LINES);
  atomicWrite(path, `${retained.join("\n")}\n`);
}

function appendEvent(root, sessionId, input, { clock = () => new Date() } = {}) {
  return withWriteLock(root, () => {
    const loaded = loadState(root, sessionId, clock);
    const candidate = {
      ...input,
      schemaVersion: 1,
      eventId: input.eventId ?? randomUUID(),
      sequence: input.sequence ?? loaded.state.lastSequence + 1,
      sessionId,
      observedAt: input.observedAt,
    };
    const event = redactActivityEvent(candidate, {
      clock,
      homeDirectory: homedir(),
      workingDirectory: process.cwd(),
    });
    const state = reduceActivityEvent(loaded.state, event, { clock });
    const snapshot = createActivitySnapshot(state, { clock });
    ensureDirectory(loaded.paths.directory);
    appendFileSync(loaded.paths.events, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(loaded.paths.events, 0o600); } catch { /* best effort */ }
    compactEventLog(loaded.paths.events);
    atomicWrite(loaded.paths.state, `${JSON.stringify(state)}\n`);
    atomicWrite(loaded.paths.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
    atomicWrite(latestSnapshotPath(root), `${JSON.stringify(snapshot, null, 2)}\n`);
    return { event, state, snapshot, metadata: loaded.metadata, paths: loaded.paths };
  });
}

function makeMetric(value, truthClass, source, observedAt, unit = "percent") {
  if (value === null) return undefined;
  return { value, truthClass, source, observedAt, unit };
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function setupInstructions(options) {
  const host = options.host ?? "all";
  if (!["all", "codex", "claude", "generic"].includes(host)) throw new Error("--host must be all, codex, claude, or generic");
  const adapter = "node <skill-dir>/scripts/runglance-adapter.mjs";
  const instructions = {
    codex: [
      `${adapter} codex-hook --emit`,
      `${adapter} codex-app-server --emit`,
      "Use SessionStart/SubagentStart/SubagentStop/Stop hooks or App Server thread/turn/item lifecycle notifications.",
      "Read account/rateLimits only when the host exposes it; unavailable quota stays unknown.",
    ],
    claude: [
      `${adapter} claude-hook --emit`,
      `${adapter} claude-statusline --emit`,
      "Use statusLine context_window.remaining_percentage and rate_limits.*.used_percentage only when present.",
      "Use SubagentStart/SubagentStop IDs for exact delegated-agent lifecycle.",
    ],
    generic: [
      `${adapter} generic --emit`,
      "Send strict version-1 activity events on stdin. Generic lifecycle data does not imply context or quota.",
    ],
  };
  return host === "all" ? instructions : { [host]: instructions[host] };
}

function setupPlan(options) {
  const root = runtimeRoot(options);
  return {
    readOnly: true,
    mode: "plan",
    runtimeDirectory: root,
    setupModes: ["plan", "instructions", "guided", "apply"],
    writesOnApply: ["<project-root>/.runglance/setup.json"],
    runtimeWritesAfterStart: ["active-session.json", "activity-snapshot.json", "sessions/<session-id>.jsonl", "sessions/<session-id>.state.json", "sessions/<session-id>.snapshot.json", "sessions/<session-id>.metadata.json"],
    permissions: "user-only where supported (directories 0700; files 0600)",
    retention: { default: "session", optionalMetadataDays: 7 },
    network: false,
    modelCalls: false,
    shellExecution: false,
    environmentOverride: "RUNGLANCE_RUNTIME_DIR",
    hostConfigurationMutation: false,
    instructions: setupInstructions(options),
  };
}

function initializeSessionFiles(root, sessionId, { retentionDays = 0, clock = () => new Date() } = {}) {
  const paths = sessionPaths(root, sessionId);
  if (existsSync(paths.metadata)) return paths;
  ensureDirectory(root);
  const timestamp = clock().toISOString();
  atomicWrite(paths.metadata, `${JSON.stringify({ schemaVersion: 1, sessionId, retentionDays, createdAt: timestamp }, null, 2)}\n`);
  atomicWrite(activeSessionPath(root), `${JSON.stringify({ sessionId, updatedAt: timestamp }, null, 2)}\n`);
  return paths;
}

function applySetup(options, clock) {
  const projectRoot = resolve(options.project_root ?? process.cwd());
  if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) throw new Error(`--project-root is not a directory: ${projectRoot}`);
  const path = join(projectRoot, ".runglance", "setup.json");
  if (existsSync(path) && !options.replace) throw new Error(`Refusing to overwrite existing setup: ${path}. Pass --replace after reviewing it.`);
  const config = {
    schemaVersion: 1,
    configuredAt: clock().toISOString(),
    scope: "repository-local",
    host: options.host ?? "all",
    hostConfigurationApplied: false,
    runtimeDirectoryOverride: "RUNGLANCE_RUNTIME_DIR",
    instructions: setupInstructions(options),
  };
  atomicWrite(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, config };
}

function startSession(options, clock) {
  const root = runtimeRoot(options);
  ensureDirectory(root);
  const sessionId = options.session_id ?? `run-${randomUUID()}`;
  const paths = sessionPaths(root, sessionId);
  if (existsSync(paths.events)) throw new Error(`Activity session already exists: ${sessionId}`);
  const retentionDays = integer(options.retention_days, "--retention-days", { min: 0, max: 7, fallback: 0 });
  if (!RETENTION_OPTIONS.has(retentionDays)) throw new Error("--retention-days must be 0 or 7");
  const timestamp = clock().toISOString();
  initializeSessionFiles(root, sessionId, { retentionDays, clock });
  return appendEvent(root, sessionId, {
    type: "entity.started",
    source: options.source ?? "activity-cli",
    observedAt: timestamp,
    entity: { kind: "thread", id: "primary", name: options.name ?? "Primary task" },
    state: "running",
  }, { clock });
}

export function recordActivityEvent(input, {
  runtimeDirectory = process.env.RUNGLANCE_RUNTIME_DIR,
  sessionId = input?.sessionId,
  retentionDays = 0,
  clock = () => new Date(),
} = {}) {
  const root = runtimeRoot({ runtime_dir: runtimeDirectory });
  if (!sessionId) throw new Error("recordActivityEvent requires a sessionId");
  initializeSessionFiles(root, sessionId, { retentionDays, clock });
  const event = { ...input };
  delete event.sessionId;
  delete event.sequence;
  delete event.eventId;
  return appendEvent(root, sessionId, event, { clock });
}

function emitEvent(options, clock) {
  const root = runtimeRoot(options);
  const sessionId = getSessionId(root, options.session_id);
  let input;
  if (options.event) input = JSON.parse(options.event);
  else if (!process.stdin.isTTY) input = JSON.parse(readStdin());
  else throw new Error("emit requires --event <json> or one JSON object on stdin");
  return appendEvent(root, sessionId, { ...input, sessionId: undefined, sequence: undefined, eventId: undefined }, { clock });
}

function updateEvent(options, clock) {
  const root = runtimeRoot(options);
  const sessionId = getSessionId(root, options.session_id);
  const kind = options.kind ?? "thread";
  const id = options.id ?? (kind === "thread" ? "primary" : null);
  if (!id) throw new Error("update requires --id for non-thread entities");
  const observedAt = clock().toISOString();
  const truthClass = options.truth ?? "exact";
  const source = options.source ?? "activity-cli";
  if (options.lock_owner || options.unlock) {
    if (options.lock_owner && options.unlock) throw new Error("--lock-owner and --unlock cannot be combined");
    return appendEvent(root, sessionId, {
      type: options.unlock ? "lock.released" : "lock.acquired",
      source,
      observedAt,
      lock: { owner: options.lock_owner },
    }, { clock });
  }
  const metrics = Object.fromEntries([
    ["contextUsedPercent", makeMetric(numeric(options.context_used, "--context-used"), truthClass, source, observedAt)],
    ["contextRemainingPercent", makeMetric(numeric(options.context_remaining, "--context-remaining"), truthClass, source, observedAt)],
    ["quotaUsedPercent", makeMetric(numeric(options.quota_used, "--quota-used"), truthClass, source, observedAt)],
    ["quotaRemainingPercent", makeMetric(numeric(options.quota_remaining, "--quota-remaining"), truthClass, source, observedAt)],
    ["taskBudgetUsedPercent", makeMetric(numeric(options.task_budget_used, "--task-budget-used"), truthClass, source, observedAt)],
    ["taskBudgetRemainingPercent", makeMetric(numeric(options.task_budget_remaining, "--task-budget-remaining"), truthClass, source, observedAt)],
  ].filter(([, metric]) => metric !== undefined));
  let type = options.heartbeat ? "entity.heartbeat" : "entity.updated";
  if (options.state === "completed") type = "entity.completed";
  if (options.state === "failed") type = "entity.failed";
  if (options.state === "stopped") type = "entity.stopped";
  const completed = numeric(options.completed, "--completed", { max: Number.MAX_SAFE_INTEGER });
  const total = numeric(options.total, "--total", { max: Number.MAX_SAFE_INTEGER });
  if ((completed === null) !== (total === null)) throw new Error("--completed and --total must be supplied together");
  return appendEvent(root, sessionId, {
    type,
    source,
    observedAt,
    entity: { kind, id, name: options.name, parentId: options.parent_id },
    state: options.state,
    ...(completed === null ? {} : { progress: { completed, total } }),
    ...(Object.keys(metrics).length ? { metrics } : {}),
  }, { clock });
}

function readSnapshot(options, clock) {
  const root = runtimeRoot(options);
  const sessionId = getSessionId(root, options.session_id);
  const loaded = loadState(root, sessionId, clock);
  if (loaded.events.length === 0) throw new Error(`No activity events for session ${sessionId}`);
  return createActivitySnapshot(loaded.state, { clock });
}

function renderOptions(options) {
  const width = integer(options.width, "--width", { min: 20, max: 1_000, fallback: process.stdout.columns ?? 100 });
  const ascii = options.ascii || process.env.NO_COLOR !== undefined || process.env.TERM === "dumb";
  return {
    preset: options.json ? "json" : options.preset ?? "compact",
    width,
    ascii,
    isTTY: Boolean(process.stdout.isTTY),
    color: false,
  };
}

async function watch(options, clock) {
  const interval = integer(options.interval, "--interval", { min: 250, max: 60_000, fallback: 1_000 });
  const rendering = renderOptions(options);
  let previous = null;
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    do {
      const output = renderActivity(readSnapshot(options, clock), rendering);
      if (process.stdout.isTTY && previous !== null) process.stdout.write(`\u001b[${previous.split("\n").length}F\u001b[0J`);
      process.stdout.write(`${output}\n`);
      previous = output;
      if (options.once) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, interval));
    } while (!stopped);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return 0;
}

function shellQuote(arg) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'"'"'`)}'`;
}

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
  return 128 + (numbers[signal] ?? 0);
}

async function verify(options, clock) {
  if (options.commandArgs.length === 0) throw new Error("verify requires a command after --");
  const root = runtimeRoot(options);
  let sessionId;
  try { sessionId = getSessionId(root, options.session_id); }
  catch {
    const started = startSession(options, clock);
    sessionId = started.snapshot.sessionId;
  }
  const id = options.id ?? `verify-${randomUUID()}`;
  const name = options.name ?? basename(options.commandArgs[0]);
  const startedAt = clock().toISOString();
  const safeCommand = options.commandArgs.map((arg) => redactActivityText(arg, {
    homeDirectory: homedir(),
    workingDirectory: process.cwd(),
    maxLength: 2_000,
  }));
  appendEvent(root, sessionId, {
    type: "verification.started",
    source: options.source ?? "activity-cli",
    observedAt: startedAt,
    verification: { id, name, command: safeCommand, status: "running" },
  }, { clock });

  const startedNs = process.hrtime.bigint();
  const child = spawn(options.commandArgs[0], options.commandArgs.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["inherit", "pipe", "pipe"],
  });
  let capture = "";
  const collect = (chunk, stream) => {
    stream.write(chunk);
    capture = `${capture}${chunk.toString("utf8")}`.slice(-MAX_CAPTURE_BYTES);
  };
  child.stdout.on("data", (chunk) => collect(chunk, process.stdout));
  child.stderr.on("data", (chunk) => collect(chunk, process.stderr));
  const forwardSigint = () => { if (!child.killed) child.kill("SIGINT"); };
  const forwardSigterm = () => { if (!child.killed) child.kill("SIGTERM"); };
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);
  const result = await new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ code: 127, signal: null, error }));
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  }).finally(() => {
    process.removeListener("SIGINT", forwardSigint);
    process.removeListener("SIGTERM", forwardSigterm);
  });
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  const exitCode = result.code ?? signalExitCode(result.signal);
  const status = result.signal ? "stopped" : exitCode === 0 ? "passed" : result.error ? "unknown" : "failed";
  if (result.error) capture = `${capture}\n${result.error.message}`;
  const completed = appendEvent(root, sessionId, {
    type: "verification.completed",
    source: options.source ?? "activity-cli",
    observedAt: clock().toISOString(),
    verification: {
      id,
      name,
      command: safeCommand,
      status,
      exitCode,
      durationMs,
      output: redactActivityText(capture, { homeDirectory: homedir(), workingDirectory: process.cwd(), maxLength: 8_000 }),
      rerun: safeCommand.map(shellQuote).join(" "),
    },
  }, { clock });
  process.stderr.write(`${status === "passed" ? "PASS" : status === "failed" ? "FAIL" : "STOPPED"} · ${name} · exit ${exitCode} · ${(durationMs / 1_000).toFixed(1)}s\n`);
  return { code: exitCode, snapshot: completed.snapshot };
}

function finish(options, clock) {
  const root = runtimeRoot(options);
  const sessionId = getSessionId(root, options.session_id);
  const mode = options.final_summary ?? "off";
  if (!["off", "concise", "verified"].includes(mode)) throw new Error("--final-summary must be off, concise, or verified");
  const format = options.format ?? (options.json ? "json" : "text");
  const outcomeStatus = options.outcome ?? "complete";
  const before = loadState(root, sessionId, clock);
  const activeEntities = Object.values(before.state.entities)
    .filter((entity) => ["queued", "running", "waiting"].includes(entity.state))
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  for (const entity of activeEntities) {
    const isPrimary = entity.kind === "thread" && entity.id === "primary";
    const state = isPrimary
      ? (["complete", "partial"].includes(outcomeStatus) ? "completed" : outcomeStatus)
      : "stopped";
    const type = state === "completed" ? "entity.completed" : state === "failed" ? "entity.failed" : "entity.stopped";
    appendEvent(root, sessionId, {
      type,
      source: options.source ?? "activity-cli",
      observedAt: clock().toISOString(),
      entity: { kind: entity.kind, id: entity.id, name: entity.name, parentId: entity.parentId },
      state,
    }, { clock });
  }
  if (before.state.lock.state === "locked") {
    appendEvent(root, sessionId, {
      type: "lock.released",
      source: options.source ?? "activity-cli",
      observedAt: clock().toISOString(),
      lock: { owner: null },
    }, { clock });
  }
  const completed = appendEvent(root, sessionId, {
    type: "run.outcome",
    source: options.source ?? "activity-cli",
    observedAt: clock().toISOString(),
    outcome: {
      status: outcomeStatus,
      summary: options.summary,
      fixes: options.fixes,
      remaining: options.remaining,
    },
  }, { clock });
  const receipt = createRunReceipt(completed.snapshot);
  atomicWrite(join(root, "last-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  if (completed.metadata.retentionDays === 7) {
    const historyDirectory = join(root, "history");
    ensureDirectory(historyDirectory);
    atomicWrite(join(historyDirectory, `${sessionId}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    pruneHistory(historyDirectory, clock);
  }
  let output = "";
  if (mode === "concise") {
    output = format === "json"
      ? JSON.stringify(receipt, null, 2)
      : `${receipt.status.toUpperCase()}${receipt.summary ? ` · ${receipt.summary}` : ""} · ${receipt.verifications.length} checks · ${receipt.duration}`;
  } else if (mode === "verified") output = renderRunReceipt(receipt, { format });
  if (completed.metadata.retentionDays === 0) removeSession(root, sessionId);
  else clearActiveIfMatches(root, sessionId);
  return { output, receipt };
}

function clearActiveIfMatches(root, sessionId) {
  const path = activeSessionPath(root);
  const active = readJson(path);
  if (active?.sessionId === sessionId && existsSync(path)) unlinkSync(path);
}

function removeSession(root, sessionId) {
  const paths = sessionPaths(root, sessionId);
  for (const path of [paths.events, paths.snapshot, paths.state, paths.metadata]) if (existsSync(path)) unlinkSync(path);
  clearActiveIfMatches(root, sessionId);
}

function pruneHistory(directory, clock) {
  if (!existsSync(directory)) return;
  const cutoff = clock().getTime() - 7 * 24 * 60 * 60 * 1_000;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".receipt.json")) continue;
    const path = join(directory, entry);
    const receipt = readJson(path);
    if (!receipt?.completedAt || Date.parse(receipt.completedAt) < cutoff) unlinkSync(path);
  }
}

function history(options, clock) {
  const root = runtimeRoot(options);
  const directory = join(root, "history");
  pruneHistory(directory, clock);
  if (!existsSync(directory)) return [];
  const limit = integer(options.limit, "--limit", { min: 1, max: 100, fallback: 20 });
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".receipt.json"))
    .map((entry) => readJson(join(directory, entry)))
    .filter(Boolean)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)))
    .slice(0, limit);
}

function doctor(options) {
  const root = runtimeRoot(options);
  const active = readJson(activeSessionPath(root));
  const checks = [
    { id: "node", ok: Number(process.versions.node.split(".")[0]) >= 20, detail: process.version },
    { id: "runtime-directory", ok: !existsSync(root) || statSync(root).isDirectory(), detail: root },
    { id: "network", ok: true, detail: "not used" },
    { id: "model-calls", ok: true, detail: "not used" },
    { id: "active-session", ok: Boolean(active?.sessionId), detail: active?.sessionId ?? "none" },
  ];
  return { ok: checks.filter((item) => item.id !== "active-session").every((item) => item.ok), checks };
}

function purge(options) {
  const root = runtimeRoot(options);
  const protectedPaths = [resolve("/"), resolve(homedir()), resolve(process.cwd()), resolve(tmpdir())];
  const isAncestorOfProtected = protectedPaths.some((path) => {
    const child = relative(root, path);
    return child === "" || (!child.startsWith("..") && !child.startsWith("/"));
  });
  if (isAncestorOfProtected) throw new Error(`Refusing to purge broad runtime directory: ${root}`);
  if (existsSync(root)) rmSync(root, { recursive: true });
  return root;
}

function usage() {
  return [
    "Usage: runglance.mjs <setup plan|start|emit|update|show|snapshot|watch|verify|finish|history|doctor|purge> [options]",
    "  setup <plan|instructions|guided>   Describe local integration without writing",
    "  setup apply --project-root <dir>   Write only repository-local setup metadata",
    "  start [--retention-days 0|7]       Start a local activity session",
    "  emit --event <json>                Append one strict normalized event",
    "  update --kind <kind> --id <id>     Record state, progress, heartbeat, or usage",
    "  show|snapshot [--preset compact]   Render the current snapshot",
    "  watch [--once] [--interval 1000]   Refresh locally without model calls",
    "  verify --name <label> -- <argv>    Run argv directly, preserve exit code, and record output",
    "  finish --final-summary <mode>      Record outcome and optionally print a receipt",
    "  history|doctor|purge               Inspect retained receipts, diagnose, or remove local state",
    "Environment: RUNGLANCE_RUNTIME_DIR overrides the local runtime directory.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse([...argv]);
  const clock = clockFromOptions(options);
  if (!options.command) throw new Error(usage());
  if (options.command === "setup") {
    const mode = options.subcommand ?? "plan";
    if (!["plan", "instructions", "guided", "apply"].includes(mode)) throw new Error("setup mode must be plan, instructions, guided, or apply");
    if (mode === "apply") {
      const result = applySetup(options, clock);
      process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : result.path}\n`);
      return 0;
    }
    const result = mode === "instructions" ? setupInstructions(options) : setupPlan(options);
    if (mode === "guided") result.nextCommand = `node <skill-dir>/scripts/runglance.mjs setup apply --project-root ${options.project_root ?? process.cwd()}${options.host ? ` --host ${options.host}` : ""}`;
    process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : Object.entries(result).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`).join("\n")}\n`);
    return 0;
  }
  if (options.command === "start") {
    const result = startSession(options, clock);
    process.stdout.write(`${options.json ? JSON.stringify(result.snapshot, null, 2) : result.snapshot.sessionId}\n`);
    return 0;
  }
  if (options.command === "emit") {
    const result = emitEvent(options, clock);
    process.stdout.write(`${options.json ? JSON.stringify(result.snapshot, null, 2) : result.event.eventId}\n`);
    return 0;
  }
  if (options.command === "update") {
    const result = updateEvent(options, clock);
    process.stdout.write(`${options.json ? JSON.stringify(result.snapshot, null, 2) : renderActivity(result.snapshot, renderOptions(options))}\n`);
    return 0;
  }
  if (["show", "snapshot"].includes(options.command)) {
    const snapshot = readSnapshot(options, clock);
    process.stdout.write(`${options.command === "snapshot" || options.json ? JSON.stringify(snapshot, null, 2) : renderActivity(snapshot, renderOptions(options))}\n`);
    return 0;
  }
  if (options.command === "watch") return watch(options, clock);
  if (options.command === "verify") return (await verify(options, clock)).code;
  if (options.command === "finish") {
    const result = finish(options, clock);
    if (result.output) process.stdout.write(`${result.output}\n`);
    return ["failed", "stopped"].includes(result.receipt.status) ? 1 : 0;
  }
  if (options.command === "history") {
    const result = history(options, clock);
    process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : result.map((item) => `${item.completedAt} · ${item.status} · ${item.summary ?? item.sessionId}`).join("\n")}\n`);
    return 0;
  }
  if (options.command === "doctor") {
    const result = doctor(options);
    process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : result.checks.map((item) => `${item.ok ? "PASS" : "WARN"} ${item.id} · ${item.detail}`).join("\n")}\n`);
    return result.ok ? 0 : 1;
  }
  if (options.command === "purge") {
    process.stdout.write(`PURGED ${purge(options)}\n`);
    return 0;
  }
  throw new Error(usage());
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
