import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import * as z from "zod/v4";

import type {
  ActionableError,
  ActivityLock,
  ActivityMetric,
  ActivityReceipt,
  ActivitySnapshot,
  ActivitySource,
  ActivityWorkItem,
} from "./types.js";

const MAX_ACTIVITY_FILE_CHARACTERS = 2_000_000;
const MAX_ENTITIES = 1_000;
const MAX_VERIFICATIONS = 250;
const MAX_RECEIPT_ITEMS = 50;
const MAX_LABEL_CHARACTERS = 160;
const MAX_SUMMARY_CHARACTERS = 2_000;

const EntityKind = z.enum(["thread", "workflow", "skill", "agent", "tool"]);
const ActivityState = z.enum(["queued", "running", "waiting", "completed", "failed", "stopped"]);
const ThreadState = z.enum(["ready", "running", "waiting", "locked", "stale", "unknown", "failed", "stopped"]);
const LockState = z.enum(["unlocked", "locked", "stale", "unknown"]);
const TruthClass = z.enum(["exact", "derived", "estimated", "unknown"]);
const IsoTimestamp = z.string().datetime({ offset: true }).nullable();
const OptionalCount = z.number().int().nonnegative().nullable();
const OptionalSeconds = z.number().nonnegative().finite().nullable();
const OptionalPercent = z.number().min(0).max(100).finite().nullable();

const MetricInput = z.object({
  value: OptionalPercent,
  truthClass: TruthClass,
  source: z.string().max(240),
  observedAt: IsoTimestamp,
  unit: z.string().max(64).nullable().optional(),
});

const EntityProgressInput = z.object({
  completed: z.number().nonnegative().finite(),
  total: z.number().nonnegative().finite(),
}).nullable();

const SnapshotProgressInput = z.object({
  mode: z.enum(["determinate", "indeterminate", "unavailable"]),
  completed: z.number().nonnegative().finite().nullable(),
  total: z.number().nonnegative().finite().nullable(),
  percent: OptionalPercent,
});

const EntityInput = z.object({
  id: z.string().min(1).max(160),
  kind: EntityKind,
  name: z.string().max(240).nullable(),
  parentId: z.string().max(160).nullable(),
  state: ActivityState,
  progress: EntityProgressInput,
  metrics: z.record(z.string(), z.unknown()).optional(),
  startedAt: IsoTimestamp,
  completedAt: IsoTimestamp,
  heartbeatAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});

const VerificationInput = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  status: z.enum(["running", "passed", "failed", "stopped", "unknown"]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  durationMs: z.number().nonnegative().finite().nullable(),
  startedAt: IsoTimestamp,
  completedAt: IsoTimestamp,
  command: z.array(z.string()).optional(),
  output: z.string().nullable().optional(),
  rerun: z.string().nullable().optional(),
});

const OutcomeInput = z.object({
  status: z.enum(["complete", "partial", "failed", "stopped"]),
  summary: z.string().max(2_000).nullable(),
  fixes: z.array(z.string().max(2_000)).max(50),
  remaining: z.array(z.string().max(2_000)).max(50),
  observedAt: z.string().datetime({ offset: true }),
}).nullable();

const ReceiptVerificationInput = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  status: z.enum(["PASS", "FAIL", "STOPPED", "UNKNOWN"]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  durationMs: z.number().nonnegative().finite().nullable(),
  command: z.array(z.string()).optional(),
  rerun: z.string().nullable().optional(),
});

const ReceiptInput = z.object({
  schemaVersion: z.number().int().positive(),
  sessionId: z.string().max(160).nullable(),
  completedAt: z.string().datetime({ offset: true }),
  status: z.enum(["complete", "partial", "failed", "stopped"]),
  taskResult: z.enum(["complete", "partial", "failed", "stopped"]),
  projectReadiness: z.object({
    status: z.literal("not_assessed"),
    value: z.null(),
    source: z.null(),
  }),
  summary: z.string().max(2_000).nullable(),
  fixes: z.array(z.string().max(2_000)).max(50),
  verifications: z.array(ReceiptVerificationInput).max(MAX_VERIFICATIONS),
  remaining: z.array(z.string().max(2_000)).max(50),
  duration: z.string().max(32),
  counts: z.object({
    workflows: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
  }),
});

const SnapshotInput = z.object({
  schemaVersion: z.number().int().positive(),
  sessionId: z.string().max(160).nullable(),
  generatedAt: z.string().datetime({ offset: true }),
  thread: z.object({
    state: ThreadState,
    startedAt: IsoTimestamp,
  }),
  progress: SnapshotProgressInput,
  counts: z.object({
    workflows: OptionalCount,
    skills: OptionalCount,
    agents: OptionalCount,
    tools: OptionalCount.optional(),
  }),
  usage: z.object({
    contextRemainingPercent: MetricInput,
    quotaRemainingPercent: MetricInput,
    taskBudgetRemainingPercent: MetricInput,
  }),
  lock: z.object({
    state: LockState,
    owner: z.string().max(240).nullable(),
    observedAt: IsoTimestamp,
  }),
  freshness: z.object({
    heartbeatAt: IsoTimestamp,
    ageSeconds: OptionalSeconds,
  }),
  entities: z.array(EntityInput).max(MAX_ENTITIES),
  activeWork: z.array(EntityInput).max(200).optional(),
  finishedWork: z.array(EntityInput).max(200).optional(),
  verifications: z.array(VerificationInput).max(MAX_VERIFICATIONS),
  outcome: OutcomeInput,
  lastReceipt: ReceiptInput.nullable().optional(),
  capabilities: z.record(z.string().max(100), z.boolean()),
});

class ActivityAccessError extends Error implements ActionableError {
  constructor(
    readonly code: string,
    message: string,
    readonly nextAction: string,
  ) {
    super(message);
    this.name = "ActivityAccessError";
  }
}

function redactText(value: string, limit: number): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential redacted]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[_A-Za-z0-9-]{8,}\b/g, "[credential redacted]")
    .replace(/\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s]+/g, "[credential redacted]")
    .replace(/(?:file:\/\/)?\/(?:Users|home)\/[^\s/]+/g, "[home]")
    .replace(/(?:file:\/\/)?\/(?:private|var|tmp)\/[^\s]+/g, "[path]")
    .replace(/[A-Za-z]:\\Users\\[^\s\\]+/g, "[home]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[credentials]@")
    .slice(0, limit);
}

function safeIdentifier(value: string | null, fallback: string): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized)) return normalized;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `${fallback}-${digest}`;
}

function publicMetric(metric: z.infer<typeof MetricInput>): ActivityMetric {
  return {
    value: metric.value,
    truthClass: metric.truthClass,
    source: safeIdentifier(metric.source, "unknown") ?? "unknown",
    observedAt: metric.observedAt,
    unit: metric.unit === undefined ? null : redactText(metric.unit ?? "", 64),
  };
}

function entityProgress(progress: z.infer<typeof EntityProgressInput>): ActivitySnapshot["progress"] {
  if (progress === null) return { mode: "unavailable", completed: null, total: null, percent: null };
  if (progress.total <= 0) return { mode: "indeterminate", completed: null, total: null, percent: null };
  return {
    mode: "determinate",
    completed: progress.completed,
    total: progress.total,
    percent: Math.round((progress.completed / progress.total) * 1_000) / 10,
  };
}

function elapsedSeconds(startedAt: string | null, endAt: string): number | null {
  if (startedAt === null) return null;
  return Math.max(0, Math.floor((Date.parse(endAt) - Date.parse(startedAt)) / 1_000));
}

function publicWorkItem(entity: z.infer<typeof EntityInput>, generatedAt: string): ActivityWorkItem {
  return {
    id: safeIdentifier(entity.id, "redacted") ?? "redacted",
    kind: entity.kind,
    label: redactText(entity.name ?? entity.id, MAX_LABEL_CHARACTERS),
    state: entity.state,
    parentId: safeIdentifier(entity.parentId, "redacted"),
    progress: entityProgress(entity.progress),
    startedAt: entity.startedAt,
    updatedAt: entity.updatedAt,
    completedAt: entity.completedAt,
    elapsedSeconds: elapsedSeconds(entity.startedAt, entity.completedAt ?? generatedAt),
  };
}

function publicLock(lock: z.infer<typeof SnapshotInput>["lock"]): ActivityLock {
  return {
    id: "thread",
    state: lock.state,
    owner: safeIdentifier(lock.owner, "redacted"),
    observedAt: lock.observedAt,
  };
}

function verificationStatus(status: z.infer<typeof VerificationInput>["status"]): "PASS" | "FAIL" | "STOPPED" | "UNKNOWN" {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  if (status === "stopped") return "STOPPED";
  return "UNKNOWN";
}

function publicReceipt(snapshot: z.infer<typeof SnapshotInput>): ActivityReceipt | null {
  const receipt = snapshot.lastReceipt;
  if (receipt !== undefined && receipt !== null) {
    return {
      schemaVersion: receipt.schemaVersion,
      sessionId: safeIdentifier(receipt.sessionId, "redacted"),
      completedAt: receipt.completedAt,
      status: receipt.status,
      taskResult: receipt.taskResult,
      projectReadiness: receipt.projectReadiness,
      summary: receipt.summary === null ? null : redactText(receipt.summary, MAX_SUMMARY_CHARACTERS),
      fixes: receipt.fixes.slice(0, MAX_RECEIPT_ITEMS).map((item) => redactText(item, MAX_LABEL_CHARACTERS)),
      verifications: receipt.verifications.slice(0, MAX_RECEIPT_ITEMS).map((item) => ({
        id: safeIdentifier(item.id, "redacted") ?? "redacted",
        name: redactText(item.name, MAX_LABEL_CHARACTERS),
        status: item.status,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
      })),
      remaining: receipt.remaining.slice(0, MAX_RECEIPT_ITEMS).map((item) => redactText(item, MAX_LABEL_CHARACTERS)),
      duration: receipt.duration,
      counts: receipt.counts,
    };
  }
  if (snapshot.outcome === null) return null;
  const outcome = snapshot.outcome;
  const durationSeconds = elapsedSeconds(snapshot.thread.startedAt, outcome.observedAt);
  const duration = durationSeconds === null
    ? "—"
    : `${String(Math.floor(durationSeconds / 60)).padStart(2, "0")}:${String(durationSeconds % 60).padStart(2, "0")}`;
  return {
    schemaVersion: snapshot.schemaVersion,
    sessionId: safeIdentifier(snapshot.sessionId, "redacted"),
    completedAt: outcome.observedAt,
    status: outcome.status,
    taskResult: outcome.status,
    projectReadiness: { status: "not_assessed", value: null, source: null },
    summary: outcome.summary === null
      ? null
      : redactText(outcome.summary, MAX_SUMMARY_CHARACTERS),
    fixes: outcome.fixes.slice(0, MAX_RECEIPT_ITEMS).map((item) => redactText(item, MAX_LABEL_CHARACTERS)),
    verifications: snapshot.verifications.slice(0, MAX_RECEIPT_ITEMS).map((item) => ({
      id: safeIdentifier(item.id, "redacted") ?? "redacted",
      name: redactText(item.name, MAX_LABEL_CHARACTERS),
      status: verificationStatus(item.status),
      exitCode: item.exitCode,
      durationMs: item.durationMs,
    })),
    remaining: outcome.remaining.slice(0, MAX_RECEIPT_ITEMS).map((item) => redactText(item, MAX_LABEL_CHARACTERS)),
    duration,
    counts: {
      workflows: snapshot.entities.filter((entity) => entity.kind === "workflow").length,
      skills: snapshot.entities.filter((entity) => entity.kind === "skill").length,
      agents: snapshot.entities.filter((entity) => entity.kind === "agent").length,
    },
  };
}

export function resolveActivityPath(options: {
  explicitPath?: string;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): string | undefined {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configured = options.explicitPath ?? environment.RUNGLANCE_ACTIVITY_FILE ?? environment.PROJECT_STATUS_ACTIVITY_FILE;
  if (configured !== undefined) return isAbsolute(configured) ? configured : resolve(cwd, configured);
  return undefined;
}

export function createFileActivitySource(filePath: string | undefined): ActivitySource {
  return {
    async load(): Promise<unknown> {
      if (filePath === undefined) {
        throw new ActivityAccessError(
          "activity_unavailable",
          "No RunGlance activity snapshot is configured.",
          "Set RUNGLANCE_ACTIVITY_FILE or RUNGLANCE_RUNTIME_DIR, then start RunGlance.",
        );
      }
      let source: string;
      try {
        source = await readFile(filePath, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new ActivityAccessError(
            "activity_unavailable",
            "The configured RunGlance activity snapshot is not available.",
            "Start RunGlance or confirm the configured snapshot file exists.",
          );
        }
        throw new ActivityAccessError(
          "activity_unreadable",
          "The configured RunGlance activity snapshot could not be read.",
          "Confirm the MCP process has read permission for the configured activity snapshot.",
        );
      }
      if (source.length > MAX_ACTIVITY_FILE_CHARACTERS) {
        throw new ActivityAccessError(
          "activity_snapshot_too_large",
          "The configured activity snapshot exceeds the 2,000,000-character input limit.",
          "Reduce retained entity and verification data before retrying.",
        );
      }
      try {
        return JSON.parse(source) as unknown;
      } catch {
        throw new ActivityAccessError(
          "activity_invalid_json",
          "The configured RunGlance activity snapshot is not valid JSON.",
          "Repair or regenerate the activity snapshot, then retry.",
        );
      }
    },
  };
}

function configuredRuntimeDirectory(options: {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): string | undefined {
  const environment = options.environment ?? process.env;
  const configured = environment.RUNGLANCE_RUNTIME_DIR ?? environment.PROJECT_STATUS_RUNTIME_DIR;
  if (configured === undefined) return undefined;
  const cwd = options.cwd ?? process.cwd();
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function createRuntimeActivitySource(runtimeDirectory: string): ActivitySource {
  return {
    async load(): Promise<unknown> {
      let entries: string[] = [];
      try { entries = await readdir(resolve(runtimeDirectory, "sessions")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ActivityAccessError("activity_unreadable", "Session selection could not be read.", "Confirm runtime directory read access.");
      }
      if (entries.filter(name => name.endsWith(".metadata.json")).length > 1) {
        throw new ActivityAccessError("activity_snapshot_invalid", "Multiple RunGlance sessions require explicit selection.", "Set RUNGLANCE_ACTIVITY_FILE to the intended session snapshot, or use an isolated runtime directory.");
      }
      try {
        return await createFileActivitySource(resolve(runtimeDirectory, "activity-snapshot.json")).load();
      } catch (error) {
        if (!(error instanceof ActivityAccessError) || error.code !== "activity_unavailable") throw error;
      }
      let activeSource: string;
      try {
        activeSource = await readFile(resolve(runtimeDirectory, "active-session.json"), "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new ActivityAccessError(
            "activity_unavailable",
            "No active RunGlance session is available.",
            "Start RunGlance or set RUNGLANCE_ACTIVITY_FILE to a retained snapshot.",
          );
        }
        throw new ActivityAccessError(
          "activity_unreadable",
          "The active RunGlance session marker could not be read.",
          "Confirm the MCP process has read permission for the configured runtime directory.",
        );
      }
      let sessionId: string | undefined;
      try {
        const active = JSON.parse(activeSource) as { sessionId?: unknown };
        if (typeof active.sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(active.sessionId)) {
          sessionId = active.sessionId;
        }
      } catch {
        // Report the same bounded contract error as a malformed marker below.
      }
      if (sessionId === undefined) {
        throw new ActivityAccessError(
          "activity_snapshot_invalid",
          "The active RunGlance session marker is invalid.",
          "Restart the activity session to regenerate active-session.json.",
        );
      }
      return createFileActivitySource(resolve(runtimeDirectory, "sessions", `${sessionId}.snapshot.json`)).load();
    },
  };
}

export function createConfiguredActivitySource(options: {
  explicitPath?: string;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): ActivitySource {
  const filePath = resolveActivityPath(options);
  if (filePath !== undefined) return createFileActivitySource(filePath);
  const runtimeDirectory = configuredRuntimeDirectory(options);
  if (runtimeDirectory !== undefined) return createRuntimeActivitySource(runtimeDirectory);
  return createFileActivitySource(undefined);
}

export interface ActivityService {
  load(): Promise<ActivitySnapshot>;
}

export function createActivityService(source: ActivitySource): ActivityService {
  return {
    async load(): Promise<ActivitySnapshot> {
      const parsed = SnapshotInput.safeParse(await source.load());
      if (!parsed.success) {
        throw new ActivityAccessError(
          "activity_snapshot_invalid",
          "The configured activity snapshot does not match the supported contract.",
          "Regenerate the snapshot with a compatible RunGlance adapter.",
        );
      }
      const input = parsed.data;
      const work = input.entities.map((entity) => publicWorkItem(entity, input.generatedAt));
      const activeWork = input.activeWork === undefined
        ? work.filter((item) => item.state === "queued" || item.state === "running" || item.state === "waiting")
        : input.activeWork.map((entity) => publicWorkItem(entity, input.generatedAt));
      const finishedWork = input.finishedWork === undefined
        ? work.filter((item) => item.state === "completed" || item.state === "failed" || item.state === "stopped")
        : input.finishedWork.map((entity) => publicWorkItem(entity, input.generatedAt));
      return {
        schemaVersion: input.schemaVersion,
        sessionId: safeIdentifier(input.sessionId, "redacted"),
        generatedAt: input.generatedAt,
        thread: input.thread,
        progress: input.progress,
        counts: {
          workflows: input.counts.workflows,
          skills: input.counts.skills,
          agents: input.counts.agents,
          tools: input.counts.tools ?? null,
        },
        usage: {
          contextRemainingPercent: publicMetric(input.usage.contextRemainingPercent),
          quotaRemainingPercent: publicMetric(input.usage.quotaRemainingPercent),
          taskBudgetRemainingPercent: publicMetric(input.usage.taskBudgetRemainingPercent),
        },
        lock: publicLock(input.lock),
        locks: [publicLock(input.lock)],
        freshness: input.freshness,
        capabilities: Object.fromEntries(
          Object.entries(input.capabilities)
            .filter(([key]) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(key))
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
        activeWork,
        finishedWork,
        lastReceipt: publicReceipt(input),
      };
    },
  };
}
