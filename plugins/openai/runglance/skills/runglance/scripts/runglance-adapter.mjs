#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeActivityEvent } from "./runglance-core.mjs";
import { recordActivityEvent } from "./runglance.mjs";
import { isDirectExecution } from "./entrypoint.mjs";

const ADAPTERS = new Set(["generic", "codex-hook", "codex-app-server", "claude-hook", "claude-statusline"]);

function parse(argv) {
  const adapter = argv[0];
  if (!ADAPTERS.has(adapter)) throw new Error(`adapter must be one of: ${[...ADAPTERS].join(", ")}`);
  const options = { adapter, emit: false, json: false, session_id: null, runtime_dir: null, source: null, now: null };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--emit") options.emit = true;
    else if (arg === "--json") options.json = true;
    else if (["--session-id", "--runtime-dir", "--source", "--now"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      options[arg.slice(2).replaceAll("-", "_")] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function string(value, fallback = null) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeState(value, fallback = "running") {
  const state = String(value ?? "").toLowerCase();
  if (["queued", "pending", "notstarted"].includes(state)) return "queued";
  if (["running", "active", "inprogress", "in_progress", "started"].includes(state)) return "running";
  if (["waiting", "idle", "blocked"].includes(state)) return "waiting";
  if (["completed", "complete", "success", "succeeded", "passed"].includes(state)) return "completed";
  if (["failed", "error", "errored"].includes(state)) return "failed";
  if (["stopped", "cancelled", "canceled", "interrupted"].includes(state)) return "stopped";
  return fallback;
}

function lifecycleType(state, { initial = false, heartbeat = false } = {}) {
  if (heartbeat) return "entity.heartbeat";
  if (initial) return "entity.started";
  if (state === "completed") return "entity.completed";
  if (state === "failed") return "entity.failed";
  if (state === "stopped") return "entity.stopped";
  return "entity.updated";
}

function hookName(input) {
  return string(input.hook_event_name ?? input.hookEventName ?? input.event_name ?? input.event);
}

function mapHook(input, source) {
  const name = hookName(input);
  if (!name) throw new Error(`${source} input does not include a hook event name`);
  const sessionId = string(input.session_id ?? input.sessionId ?? input.thread_id ?? input.threadId);
  const subagentId = string(input.subagent_id ?? input.subagentId ?? input.agent_id ?? input.agentId);
  if (name === "SessionStart") {
    return [{
      sessionId,
      type: "entity.started",
      source,
      entity: { kind: "thread", id: "primary", name: string(input.name, "Primary task") },
      state: "running",
    }];
  }
  if (name === "SubagentStart") {
    if (!subagentId) throw new Error("SubagentStart requires a subagent or agent ID");
    return [{
      sessionId,
      type: "entity.started",
      source,
      entity: {
        kind: "agent",
        id: subagentId,
        name: string(input.agent_type ?? input.subagent_type ?? input.agentType, "Delegated agent"),
        parentId: "primary",
      },
      state: "running",
    }];
  }
  if (name === "SubagentStop") {
    if (!subagentId) throw new Error("SubagentStop requires a subagent or agent ID");
    const state = input.error || input.failed ? "failed" : normalizeState(input.status, "completed");
    return [{
      sessionId,
      type: lifecycleType(state),
      source,
      entity: { kind: "agent", id: subagentId, name: string(input.agent_type ?? input.subagent_type ?? input.agentType) },
      state,
    }];
  }
  if (name === "Stop") {
    return [{
      sessionId,
      type: "entity.updated",
      source,
      entity: { kind: "thread", id: "primary" },
      state: "waiting",
    }];
  }
  throw new Error(`Unsupported ${source} hook event: ${name}`);
}

function getNested(input, paths) {
  for (const path of paths) {
    let value = input;
    for (const segment of path) value = value?.[segment];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function appServerItemKind(item) {
  const type = String(item?.type ?? "").toLowerCase();
  if (["agentmessage", "usermessage", "reasoning", "plan"].includes(type)) return null;
  // Collaboration calls are tools, not child-agent lifecycle evidence.
  if (type.includes("tool") || type.includes("command") || type.includes("search")) return "tool";
  return "tool";
}

function mapCodexAppServer(input) {
  const method = string(input.method ?? input.type);
  const params = input.params ?? input.result ?? {};
  const threadId = string(params.threadId ?? params.thread_id ?? params.thread?.id ?? input.threadId ?? input.thread_id);
  if (method === "thread/status/changed") {
    const state = normalizeState(params.status?.type ?? params.status, "running");
    return [{ sessionId: threadId, type: lifecycleType(state), source: "codex-app-server", entity: { kind: "thread", id: "primary" }, state }];
  }
  if (["turn/started", "turn/completed"].includes(method)) {
    const turn = params.turn ?? {};
    const id = string(turn.id ?? params.turnId ?? params.turn_id);
    if (!id) throw new Error(`${method} requires a turn ID`);
    const state = method === "turn/started" ? "running" : normalizeState(turn.status ?? params.status, "completed");
    return [{
      sessionId: threadId,
      type: lifecycleType(state, { initial: method === "turn/started" }),
      source: "codex-app-server",
      entity: { kind: "workflow", id, name: string(turn.name ?? turn.title, "Turn"), parentId: "primary" },
      state,
    }];
  }
  if (["item/started", "item/completed"].includes(method)) {
    const item = params.item ?? {};
    const kind = appServerItemKind(item);
    if (kind === null) return [];
    const id = string(item.id ?? params.itemId ?? params.item_id);
    if (!id) throw new Error(`${method} requires an item ID`);
    const exitCode = item.exitCode ?? item.exit_code;
    const failedCommand = method === "item/completed" && String(item.type).toLowerCase() === "commandexecution"
      && Number.isInteger(exitCode) && exitCode !== 0;
    const state = failedCommand ? "failed" : method === "item/started" ? "running" : normalizeState(item.status ?? params.status, "completed");
    return [{
      sessionId: threadId,
      type: lifecycleType(state, { initial: method === "item/started" }),
      source: "codex-app-server",
      entity: { kind, id, name: string(item.name ?? item.type, "Work item"), parentId: string(params.turnId ?? params.turn_id) },
      state,
    }];
  }
  if (method === "account/rateLimits/read") {
    const used = getNested(params, [
      ["rateLimits", "primary", "usedPercent"],
      ["rate_limits", "primary", "used_percentage"],
      ["primary", "usedPercent"],
      ["primary", "used_percentage"],
    ]);
    const numeric = typeof used === "number" && Number.isFinite(used) ? used : null;
    return [{
      sessionId: threadId,
      type: "entity.heartbeat",
      source: "codex-app-server",
      entity: { kind: "thread", id: "primary" },
      ...(numeric === null ? {} : { metrics: { quotaUsedPercent: { value: numeric, truthClass: "exact", source: "codex-app-server:account/rateLimits/read", observedAt: null, unit: "percent" } } }),
    }];
  }
  throw new Error(`Unsupported Codex App Server method: ${method ?? "unknown"}`);
}

function collectRateLimitUsed(input) {
  const values = [];
  for (const value of Object.values(input?.rate_limits ?? input?.rateLimits ?? {})) {
    const used = value?.used_percentage ?? value?.usedPercent;
    if (typeof used === "number" && Number.isFinite(used)) values.push(used);
  }
  return values;
}

function mapClaudeStatusline(input) {
  const sessionId = string(input.session_id ?? input.sessionId);
  const observedAt = null;
  const remaining = input.context_window?.remaining_percentage ?? input.contextWindow?.remainingPercentage;
  const metrics = {};
  if (typeof remaining === "number" && Number.isFinite(remaining)) {
    metrics.contextRemainingPercent = { value: remaining, truthClass: "exact", source: "claude-statusline:context_window.remaining_percentage", observedAt, unit: "percent" };
  }
  const rateLimits = collectRateLimitUsed(input);
  if (rateLimits.length) {
    metrics.quotaUsedPercent = {
      value: Math.max(...rateLimits),
      truthClass: "derived",
      source: "claude-statusline:most-constrained-rate-limit",
      observedAt,
      unit: "percent",
    };
  }
  return [{
    sessionId,
    type: "entity.heartbeat",
    source: "claude-statusline",
    entity: { kind: "thread", id: "primary" },
    metrics,
  }];
}

export function mapHostActivity(adapter, input) {
  if (!ADAPTERS.has(adapter)) throw new Error(`Unknown adapter: ${adapter}`);
  if (adapter === "generic") return Array.isArray(input) ? input : [input];
  if (adapter === "codex-hook") return mapHook(input, "codex-hook");
  if (adapter === "codex-app-server") return mapCodexAppServer(input);
  if (adapter === "claude-hook") return mapHook(input, "claude-hook");
  return mapClaudeStatusline(input);
}

function clockFrom(options) {
  if (!options.now) return () => new Date();
  const time = Date.parse(options.now);
  if (!Number.isFinite(time)) throw new Error("--now must be an RFC 3339 timestamp");
  return () => new Date(time);
}

function readInput() {
  const text = readFileSync(0, "utf8");
  if (!text.trim()) throw new Error("adapter requires one JSON object on stdin");
  return JSON.parse(text);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const clock = clockFrom(options);
  const input = readInput();
  const mapped = mapHostActivity(options.adapter, input);
  const inputSessionId = string(input.session_id ?? input.sessionId ?? input.thread_id ?? input.threadId);
  const normalized = mapped.map((item, index) => {
    const sessionId = options.session_id ?? item.sessionId ?? inputSessionId;
    if (!sessionId) throw new Error("adapter input requires a host session/thread ID or explicit --session-id");
    return normalizeActivityEvent({
      ...item,
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: index + 1,
      sessionId,
      observedAt: item.observedAt ?? clock().toISOString(),
      source: options.source ?? item.source ?? options.adapter,
    }, { clock });
  });

  if (options.emit) {
    const snapshots = normalized.map((event) => recordActivityEvent(event, {
      runtimeDirectory: options.runtime_dir,
      sessionId: event.sessionId,
      clock,
    }).snapshot);
    const result = snapshots.at(-1);
    process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : result.sessionId}\n`);
  } else {
    process.stdout.write(`${options.json ? JSON.stringify(normalized, null, 2) : normalized.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  return 0;
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
