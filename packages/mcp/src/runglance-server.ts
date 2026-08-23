import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  createActivityService,
  createConfiguredActivitySource,
  type ActivityService,
} from "./activity-adapter.js";
import type {
  ActionableError,
  ActivitySnapshot,
  ActivitySource,
} from "./types.js";

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const MAX_RESOURCE_CHARACTERS = 128_000;
const MAX_RESOURCE_ITEMS = 50;
const EmptyInput = z.object({}).strict();

const ProgressOutput = z.object({
  mode: z.enum(["determinate", "indeterminate", "unavailable"]),
  completed: z.number().nonnegative().nullable(),
  total: z.number().nonnegative().nullable(),
  percent: z.number().min(0).max(100).nullable(),
}).strict();

const MetricOutput = z.object({
  value: z.number().min(0).max(100).nullable(),
  truthClass: z.enum(["exact", "derived", "estimated", "unknown"]),
  source: z.string(),
  observedAt: z.string().nullable(),
  unit: z.string().nullable(),
}).strict();

const UsageOutput = z.object({
  contextRemainingPercent: MetricOutput,
  quotaRemainingPercent: MetricOutput,
  taskBudgetRemainingPercent: MetricOutput,
}).strict();

const LockOutput = z.object({
  id: z.string(),
  state: z.enum(["unlocked", "locked", "stale", "unknown"]),
  owner: z.string().nullable(),
  observedAt: z.string().nullable(),
}).strict();

const VerificationOutput = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["PASS", "FAIL", "STOPPED", "UNKNOWN"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
}).strict();

const ReceiptOutput = z.object({
  schemaVersion: z.number().int().positive(),
  sessionId: z.string().nullable(),
  completedAt: z.string(),
  status: z.enum(["complete", "partial", "failed", "stopped", "unknown"]),
  taskResult: z.enum(["complete", "partial", "failed", "stopped", "unknown"]),
  projectReadiness: z.object({
    status: z.literal("not_assessed"),
    value: z.null(),
    source: z.null(),
  }).strict(),
  summary: z.string().nullable(),
  fixes: z.array(z.string()),
  verifications: z.array(VerificationOutput),
  remaining: z.array(z.string()),
  duration: z.string(),
  counts: z.object({
    workflows: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const StatusOutput = z.object({
  ok: z.literal(true),
  schemaVersion: z.number().int().positive(),
  sessionId: z.string().nullable(),
  generatedAt: z.string(),
  thread: z.object({
    state: z.enum(["ready", "running", "waiting", "locked", "stale", "unknown", "failed", "stopped"]),
    startedAt: z.string().nullable(),
  }).strict(),
  progress: ProgressOutput,
  counts: z.object({
    workflows: z.number().int().nonnegative().nullable(),
    skills: z.number().int().nonnegative().nullable(),
    agents: z.number().int().nonnegative().nullable(),
    tools: z.number().int().nonnegative().nullable(),
  }).strict(),
  usage: UsageOutput,
  lock: LockOutput,
  freshness: z.object({
    heartbeatAt: z.string().nullable(),
    ageSeconds: z.number().nonnegative().nullable(),
  }).strict(),
  capabilities: z.record(z.string(), z.boolean()),
  lastReceipt: ReceiptOutput.nullable(),
}).strict();

const WorkOutput = z.object({
  id: z.string(),
  kind: z.enum(["thread", "workflow", "skill", "agent", "tool"]),
  label: z.string(),
  state: z.enum(["queued", "running", "waiting", "completed", "failed", "stopped"]),
  parentId: z.string().nullable(),
  progress: ProgressOutput,
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  elapsedSeconds: z.number().nonnegative().nullable(),
}).strict();

const ListWorkInput = z.object({
  scope: z.enum(["active", "finished", "all"]).default("active")
    .describe("Select active work, terminal finished work, or both."),
  kind: z.enum(["thread", "workflow", "skill", "agent", "tool"]).optional()
    .describe("Optional exact entity-kind filter."),
  state: z.enum(["queued", "running", "waiting", "completed", "failed", "stopped"]).optional()
    .describe("Optional exact lifecycle-state filter."),
  limit: z.number().int().min(1).max(100).default(25)
    .describe("Maximum work items to return, from 1 through 100."),
  offset: z.number().int().min(0).default(0)
    .describe("Number of matching work items to skip."),
}).strict();

const ListWorkOutput = z.object({
  ok: z.literal(true),
  scope: z.enum(["active", "finished", "all"]),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  work: z.array(WorkOutput),
}).strict();

const UsageToolOutput = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  usage: UsageOutput,
}).strict();

const LocksToolOutput = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  count: z.number().int().nonnegative(),
  locks: z.array(LockOutput),
}).strict();

function actionableError(error: unknown): ActionableError {
  if (error !== null && typeof error === "object") {
    const candidate = error as Partial<ActionableError>;
    if (
      typeof candidate.code === "string"
      && typeof candidate.message === "string"
      && typeof candidate.nextAction === "string"
    ) {
      return { code: candidate.code, message: candidate.message, nextAction: candidate.nextAction };
    }
  }
  return {
    code: "runglance_operation_failed",
    message: "The RunGlance status operation failed.",
    nextAction: "Run the local RunGlance doctor command and confirm the configured snapshot is readable.",
  };
}

function success(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function failure(error: unknown): CallToolResult {
  const detail = actionableError(error);
  return {
    isError: true,
    content: [{
      type: "text",
      text: `Error: ${detail.message}\nNext action: ${detail.nextAction}`,
    }],
    structuredContent: { ok: false, error: detail },
  };
}

function statusProjection(snapshot: ActivitySnapshot): Record<string, unknown> {
  return {
    ok: true,
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    generatedAt: snapshot.generatedAt,
    thread: snapshot.thread,
    progress: snapshot.progress,
    counts: snapshot.counts,
    usage: snapshot.usage,
    lock: snapshot.lock,
    freshness: snapshot.freshness,
    capabilities: snapshot.capabilities,
    lastReceipt: snapshot.lastReceipt,
  };
}

function registerStatus(server: McpServer, service: ActivityService): void {
  server.registerTool(
    "runglance_get_status",
    {
      title: "Get RunGlance Status",
      description: "Read the latest local RunGlance snapshot. Returns thread state, progress, active counts, usage truth classes, explicit lock state, freshness, capabilities, and the bounded final receipt. It never calculates project readiness or writes activity.",
      inputSchema: EmptyInput,
      outputSchema: StatusOutput,
      annotations: { title: "Get RunGlance Status", ...READ_ONLY_ANNOTATIONS },
    },
    async () => {
      try {
        const snapshot = await service.load();
        const count = (value: number | null): string => value === null ? "—" : String(value);
        return success(
          statusProjection(snapshot),
          `RunGlance: ${snapshot.thread.state}. Workflows ${count(snapshot.counts.workflows)}, skills ${count(snapshot.counts.skills)}, agents ${count(snapshot.counts.agents)}, tools ${count(snapshot.counts.tools)}. Snapshot ${snapshot.generatedAt}.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerWork(server: McpServer, service: ActivityService): void {
  server.registerTool(
    "runglance_list_work",
    {
      title: "List RunGlance Work",
      description: "List bounded, redacted RunGlance thread, workflow, skill, agent, and tool activity. Defaults to active work and supports finished/all scope, exact filters, and offset pagination.",
      inputSchema: ListWorkInput,
      outputSchema: ListWorkOutput,
      annotations: { title: "List RunGlance Work", ...READ_ONLY_ANNOTATIONS },
    },
    async ({ scope, kind, state, limit, offset }) => {
      try {
        const snapshot = await service.load();
        const candidates = scope === "active"
          ? snapshot.activeWork
          : scope === "finished"
            ? snapshot.finishedWork
            : [...snapshot.activeWork, ...snapshot.finishedWork];
        const matches = candidates.filter((item) => (
          (kind === undefined || item.kind === kind)
          && (state === undefined || item.state === state)
        ));
        const work = matches.slice(offset, offset + limit);
        const hasMore = offset + work.length < matches.length;
        const output = {
          ok: true,
          scope,
          total: matches.length,
          count: work.length,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + work.length : null,
          work,
        };
        return success(output, `Found ${matches.length} matching ${scope} work item(s); returning ${work.length} from offset ${offset}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerUsage(server: McpServer, service: ActivityService): void {
  server.registerTool(
    "runglance_get_usage",
    {
      title: "Get RunGlance Usage",
      description: "Read context, provider-quota, and task-budget remaining percentages from RunGlance. Every metric preserves exact, derived, estimated, or unknown truth and never substitutes zero for unavailable data.",
      inputSchema: EmptyInput,
      outputSchema: UsageToolOutput,
      annotations: { title: "Get RunGlance Usage", ...READ_ONLY_ANNOTATIONS },
    },
    async () => {
      try {
        const snapshot = await service.load();
        return success(
          { ok: true, generatedAt: snapshot.generatedAt, usage: snapshot.usage },
          `RunGlance usage snapshot from ${snapshot.generatedAt}; unavailable metrics remain explicitly unknown.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerLocks(server: McpServer, service: ActivityService): void {
  server.registerTool(
    "runglance_get_locks",
    {
      title: "Get RunGlance Locks",
      description: "Read the bounded, redacted RunGlance lock observation. Stale, unknown, and unlocked are distinct states; silence never becomes a lock.",
      inputSchema: EmptyInput,
      outputSchema: LocksToolOutput,
      annotations: { title: "Get RunGlance Locks", ...READ_ONLY_ANNOTATIONS },
    },
    async () => {
      try {
        const snapshot = await service.load();
        return success(
          { ok: true, generatedAt: snapshot.generatedAt, count: snapshot.locks.length, locks: snapshot.locks },
          `RunGlance lock state: ${snapshot.lock.state}. Observation: ${snapshot.lock.observedAt ?? "unknown"}.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerStatusResource(server: McpServer, service: ActivityService): void {
  server.registerResource(
    "runglance-status",
    "runglance://status",
    {
      title: "RunGlance status snapshot",
      description: "Bounded public projection of the latest RunGlance status with separate active and finished work. Prompts, transcripts, commands, environment values, credentials, and raw paths are omitted or redacted.",
      mimeType: "application/json",
      cacheHint: { ttlMs: 1_000, cacheScope: "private" },
    },
    async (uri) => {
      try {
        const snapshot = await service.load();
        const activeWork = snapshot.activeWork.slice(0, MAX_RESOURCE_ITEMS);
        const finishedWork = snapshot.finishedWork.slice(0, MAX_RESOURCE_ITEMS);
        const projection = {
          ...statusProjection(snapshot),
          activeWork,
          finishedWork,
          bounds: {
            activeWorkTotal: snapshot.activeWork.length,
            activeWorkTruncated: activeWork.length < snapshot.activeWork.length,
            finishedWorkTotal: snapshot.finishedWork.length,
            finishedWorkTruncated: finishedWork.length < snapshot.finishedWork.length,
          },
        };
        const text = JSON.stringify(projection, null, 2);
        if (text.length > MAX_RESOURCE_CHARACTERS) {
          throw {
            code: "runglance_resource_too_large",
            message: "The bounded RunGlance resource exceeds the 128,000-character limit.",
            nextAction: "Use runglance_get_status and runglance_list_work with filters and pagination.",
          };
        }
        return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
      } catch (error) {
        const detail = actionableError(error);
        throw new Error(`${detail.code}: ${detail.message} ${detail.nextAction}`);
      }
    },
  );
}

export interface RunGlanceServerOptions {
  activitySource?: ActivitySource;
  activityPath?: string;
}

export function createRunGlanceServer(options: RunGlanceServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "runglance-mcp-server",
      version: "1.2.1",
      description: "Read-only access to local RunGlance progress, work, usage, locks, and verification receipts.",
    },
    {
      instructions: "All tools are local, read-only, bounded, and idempotent. RunGlance reports run activity only; it never changes activity, drives the HUD refresh loop, or calculates project readiness. Unknown host metrics remain unknown.",
    },
  );
  const service = createActivityService(
    options.activitySource
      ?? createConfiguredActivitySource(options.activityPath === undefined ? {} : { explicitPath: options.activityPath }),
  );
  registerStatus(server, service);
  registerWork(server, service);
  registerUsage(server, service);
  registerLocks(server, service);
  registerStatusResource(server, service);
  return server;
}
