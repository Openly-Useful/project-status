import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  McpServer,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  createConfiguredActivitySource,
  createActivityService,
  type ActivityService,
} from "./activity-adapter.js";
import {
  actionableError,
  boundedValidationErrors,
  createFileManifestSource,
  createManifestService,
  createWorkspaceRootsManifestSource,
  resolveManifestPath,
  type ManifestService,
} from "./manifest-adapter.js";
import type {
  ActivitySnapshot,
  ActivitySource,
  ManifestSource,
  ManifestTask,
  ProjectStatusManifest,
} from "./types.js";

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const TASK_STATUSES = ["complete", "in_progress", "blocked", "not_started"] as const;
const MAX_RESOURCE_CHARACTERS = 512_000;
const MAX_ACTIVITY_RESOURCE_CHARACTERS = 128_000;
const MAX_ACTIVITY_RESOURCE_ITEMS = 50;
const ROOTS_RESPONSE_KEY = "project_status_workspace_roots";

const EmptyInput = z.object({}).strict();
const ErrorOutput = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    nextAction: z.string(),
  }),
});

function success(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function failure(error: unknown): CallToolResult {
  const detail = actionableError(error);
  const structuredContent = { ok: false as const, error: detail };
  return {
    isError: true,
    content: [{
      type: "text",
      text: `Error: ${detail.message}\nNext action: ${detail.nextAction}`,
    }],
    structuredContent,
  };
}

type ServiceResolution = ManifestService | InputRequiredResult;
type ServiceResolver = (ctx: ServerContext) => Promise<ServiceResolution>;

function isManifestService(resolution: ServiceResolution): resolution is ManifestService {
  return "loadValidated" in resolution;
}

function createServiceResolver(server: McpServer, options: ProjectStatusServerOptions): ServiceResolver {
  if (options.source !== undefined) {
    const service = createManifestService(options.source);
    return async () => service;
  }
  if (options.manifestPath !== undefined) {
    const service = createManifestService(createFileManifestSource(options.manifestPath));
    return async () => service;
  }

  const fallback = createManifestService(createFileManifestSource(resolveManifestPath()));
  return async (ctx: ServerContext): Promise<ServiceResolution> => {
    const embedded = inputResponse(ctx.mcpReq.inputResponses, ROOTS_RESPONSE_KEY);
    if (embedded.kind === "roots") {
      return createManifestService(createWorkspaceRootsManifestSource(embedded.roots.map((root) => root.uri)));
    }

    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const modernCapabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
    const capabilities = modernCapabilities !== null && typeof modernCapabilities === "object"
      ? modernCapabilities as { roots?: object }
      : server.server.getClientCapabilities();
    if (capabilities?.roots !== undefined) {
      if (server.server.getNegotiatedProtocolVersion() === "2026-07-28") {
        return inputRequired({
          inputRequests: { [ROOTS_RESPONSE_KEY]: inputRequired.listRoots() },
        });
      }
      const { roots } = await server.server.listRoots();
      return createManifestService(createWorkspaceRootsManifestSource(roots.map((root) => root.uri)));
    }
    return fallback;
  };
}

function records(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function summaryOutput(manifest: ProjectStatusManifest, calculated: Record<string, unknown>): Record<string, unknown> {
  const score = records(calculated.score);
  const tasks = records(calculated.tasks);
  const audit = records(calculated.audit);
  const gates = records(calculated.gates);
  const time = records(calculated.time);
  const criticalPath = records(calculated.criticalPath);
  const taskById = new Map(manifest.phases.flatMap((phase) => phase.tasks.map((task) => [task.id, task] as const)));
  const path = Array.isArray(criticalPath.path) ? criticalPath.path.filter((id): id is string => typeof id === "string") : [];
  const missing = Array.isArray(criticalPath.missingEstimateTaskIds)
    ? criticalPath.missingEstimateTaskIds.filter((id): id is string => typeof id === "string")
    : [];
  return {
    ok: true,
    initiative: {
      name: manifest.initiative.name,
      release: manifest.initiative.release,
      state: manifest.initiative.state,
    },
    asOf: String(calculated.asOf),
    score: {
      earnedWeight: Number(score.earnedWeight),
      totalWeight: Number(score.totalWeight),
      exactPercent: Number(score.exactPercent),
      displayPercent: Number(score.displayPercent),
    },
    tasks: {
      total: Number(tasks.total),
      complete: Number(tasks.complete),
      inProgress: Number(tasks.inProgress),
      blocked: Number(tasks.blocked),
      notStarted: Number(tasks.notStarted),
    },
    audit: {
      state: String(audit.state),
      verificationState: String(audit.verificationState),
      ageSeconds: Number(audit.ageSeconds),
      isStale: Boolean(audit.isStale),
      nextDueAt: audit.nextDueAt === null ? null : String(audit.nextDueAt),
    },
    gates: {
      satisfied: Number(gates.satisfied),
      unsatisfied: Number(gates.unsatisfied),
      waiting: Number(gates.waiting),
      waived: Number(gates.waived),
    },
    time: {
      active: records(time.active),
      deferred: records(time.deferred),
      unknownEstimateCount: Array.isArray(time.unknownEstimateTaskIds) ? time.unknownEstimateTaskIds.length : 0,
    },
    criticalPath: {
      determinate: Boolean(criticalPath.determinate),
      reason: criticalPath.reason === null ? null : String(criticalPath.reason),
      durationHours: criticalPath.durationHours === null ? null : records(criticalPath.durationHours),
      taskNames: path.map((id) => taskById.get(id)?.name ?? id),
      missingEstimateTaskNames: missing.map((id) => taskById.get(id)?.name ?? id),
    },
  };
}

const NumberRange = z.object({ min: z.number(), max: z.number() });
const SummaryOutput = z.object({
  ok: z.literal(true),
  initiative: z.object({ name: z.string(), release: z.string(), state: z.string() }),
  asOf: z.string(),
  score: z.object({
    earnedWeight: z.number(), totalWeight: z.number(), exactPercent: z.number(), displayPercent: z.number(),
  }),
  tasks: z.object({
    total: z.number(), complete: z.number(), inProgress: z.number(), blocked: z.number(), notStarted: z.number(),
  }),
  audit: z.object({
    state: z.string(), verificationState: z.string(), ageSeconds: z.number(), isStale: z.boolean(), nextDueAt: z.string().nullable(),
  }),
  gates: z.object({ satisfied: z.number(), unsatisfied: z.number(), waiting: z.number(), waived: z.number() }),
  time: z.object({ active: NumberRange, deferred: NumberRange, unknownEstimateCount: z.number() }),
  criticalPath: z.object({
    determinate: z.boolean(),
    reason: z.string().nullable(),
    durationHours: NumberRange.nullable(),
    taskNames: z.array(z.string()),
    missingEstimateTaskNames: z.array(z.string()),
  }),
});

const ValidationOutput = z.object({
  ok: z.literal(true),
  valid: z.boolean(),
  errorCount: z.number().int().nonnegative(),
  errors: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() })),
  truncated: z.boolean(),
});

const ListTasksInput = z.object({
  status: z.enum(TASK_STATUSES).optional().describe("Optional task status filter."),
  phase_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional().describe("Optional exact phase identifier."),
  limit: z.number().int().min(1).max(100).default(25).describe("Maximum tasks to return (1-100)."),
  offset: z.number().int().min(0).default(0).describe("Number of matching tasks to skip."),
}).strict();

const PublicTask = z.object({
  id: z.string(),
  name: z.string(),
  phaseId: z.string(),
  phaseName: z.string(),
  summary: z.string(),
  status: z.enum(TASK_STATUSES),
  weight: z.number(),
  earnedWeight: z.number(),
  remainingHours: NumberRange.nullable(),
  recurring: z.boolean(),
  deferred: z.boolean(),
  owner: z.string(),
  nextAction: z.string().nullable(),
  evidenceRequirement: z.object({ minimumTier: z.string(), minCount: z.number(), referencedCount: z.number() }),
  gateCount: z.number(),
});

const ListTasksOutput = z.object({
  ok: z.literal(true),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
  tasks: z.array(PublicTask),
});

const DependenciesInput = z.object({
  task_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional().describe("Optional task identifier to focus on."),
  direction: z.enum(["all", "upstream", "downstream"]).default("all").describe("Relationship direction relative to task_id."),
  type: z.enum(["blocks", "informs"]).optional().describe("Optional dependency type filter."),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
}).strict();

const PublicDependency = z.object({
  type: z.enum(["blocks", "informs"]),
  prerequisite: z.object({ id: z.string(), name: z.string() }),
  dependent: z.object({ id: z.string(), name: z.string() }),
});

const DependenciesOutput = z.object({
  ok: z.literal(true),
  taskId: z.string().nullable(),
  total: z.number(),
  count: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
  dependencies: z.array(PublicDependency),
});

const ActivityProgressOutput = z.object({
  mode: z.enum(["determinate", "indeterminate", "unavailable"]),
  completed: z.number().nonnegative().nullable(),
  total: z.number().nonnegative().nullable(),
  percent: z.number().min(0).max(100).nullable(),
}).strict();

const ActivityMetricOutput = z.object({
  value: z.number().min(0).max(100).nullable(),
  truthClass: z.enum(["exact", "derived", "estimated", "unknown"]),
  source: z.string(),
  observedAt: z.string().nullable(),
  unit: z.string().nullable(),
}).strict();

const ActivityUsageOutput = z.object({
  contextRemainingPercent: ActivityMetricOutput,
  quotaRemainingPercent: ActivityMetricOutput,
  taskBudgetRemainingPercent: ActivityMetricOutput,
}).strict();

const ActivityLockOutput = z.object({
  id: z.string(),
  state: z.enum(["unlocked", "locked", "stale", "unknown"]),
  owner: z.string().nullable(),
  observedAt: z.string().nullable(),
}).strict();

const ActivityVerificationOutput = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["PASS", "FAIL", "STOPPED", "UNKNOWN"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
}).strict();

const ActivityReceiptOutput = z.object({
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
  verifications: z.array(ActivityVerificationOutput),
  remaining: z.array(z.string()),
  duration: z.string(),
  counts: z.object({
    workflows: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    agents: z.number().int().nonnegative(),
  }).strict(),
}).strict();

const ActivitySummaryOutput = z.object({
  ok: z.literal(true),
  schemaVersion: z.number().int().positive(),
  sessionId: z.string().nullable(),
  generatedAt: z.string(),
  thread: z.object({
    state: z.enum(["ready", "running", "waiting", "locked", "stale", "unknown", "failed", "stopped"]),
    startedAt: z.string().nullable(),
  }).strict(),
  progress: ActivityProgressOutput,
  counts: z.object({
    workflows: z.number().int().nonnegative().nullable(),
    skills: z.number().int().nonnegative().nullable(),
    agents: z.number().int().nonnegative().nullable(),
    tools: z.number().int().nonnegative().nullable(),
  }).strict(),
  usage: ActivityUsageOutput,
  lock: ActivityLockOutput,
  freshness: z.object({
    heartbeatAt: z.string().nullable(),
    ageSeconds: z.number().nonnegative().nullable(),
  }).strict(),
  capabilities: z.record(z.string(), z.boolean()),
  lastReceipt: ActivityReceiptOutput.nullable(),
}).strict();

const ActivityWorkOutput = z.object({
  id: z.string(),
  kind: z.enum(["thread", "workflow", "skill", "agent", "tool"]),
  label: z.string(),
  state: z.enum(["queued", "running", "waiting", "completed", "failed", "stopped"]),
  parentId: z.string().nullable(),
  progress: ActivityProgressOutput,
  startedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  elapsedSeconds: z.number().nonnegative().nullable(),
}).strict();

const ListActiveWorkInput = z.object({
  scope: z.enum(["active", "finished", "all"]).default("active")
    .describe("Select currently active work, terminal finished work, or both."),
  kind: z.enum(["thread", "workflow", "skill", "agent", "tool"]).optional()
    .describe("Optional exact activity entity kind filter."),
  state: z.enum(["queued", "running", "waiting", "completed", "failed", "stopped"]).optional()
    .describe("Optional exact lifecycle state filter."),
  limit: z.number().int().min(1).max(100).default(25).describe("Maximum work items to return (1-100)."),
  offset: z.number().int().min(0).default(0).describe("Number of matching work items to skip."),
}).strict();

const ListActiveWorkOutput = z.object({
  ok: z.literal(true),
  scope: z.enum(["active", "finished", "all"]),
  total: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  work: z.array(ActivityWorkOutput),
}).strict();

const ActivityUsageToolOutput = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  usage: ActivityUsageOutput,
}).strict();

const ActivityLocksToolOutput = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  count: z.number().int().nonnegative(),
  locks: z.array(ActivityLockOutput),
}).strict();

function taskRecords(manifest: ProjectStatusManifest): Array<ManifestTask & { phaseId: string; phaseName: string }> {
  return manifest.phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phaseId: phase.id, phaseName: phase.name })));
}

function publicTask(task: ManifestTask & { phaseId: string; phaseName: string }): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    phaseId: task.phaseId,
    phaseName: task.phaseName,
    summary: task.summary,
    status: task.status,
    weight: task.weight,
    earnedWeight: task.earnedWeight,
    remainingHours: task.remainingHours,
    recurring: task.recurring,
    deferred: task.deferred,
    owner: task.owner.label,
    nextAction: task.nextAction,
    evidenceRequirement: {
      minimumTier: task.evidenceRequirement.minimumTier,
      minCount: task.evidenceRequirement.minCount,
      referencedCount: task.evidenceRefs.length,
    },
    gateCount: task.gateRefs.length,
  };
}

function activitySummary(snapshot: ActivitySnapshot): Record<string, unknown> {
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

function registerActivitySummary(server: McpServer, activity: ActivityService): void {
  server.registerTool(
    "project_status_get_activity",
    {
      title: "Get Project Status Activity",
      description: "Read the optional local activity snapshot and return its thread state, progress, live counts, usage truth classes, lock, freshness, capabilities, and bounded last verification receipt. No readiness value is calculated or changed.",
      inputSchema: EmptyInput,
      outputSchema: ActivitySummaryOutput,
      annotations: { title: "Get Project Status Activity", ...READ_ONLY_ANNOTATIONS },
    },
    async () => {
      try {
        const snapshot = await activity.load();
        const output = activitySummary(snapshot);
        const counts = snapshot.counts;
        const label = (value: number | null): string => value === null ? "—" : String(value);
        return success(
          output,
          `Activity: ${snapshot.thread.state}. Workflows ${label(counts.workflows)}, skills ${label(counts.skills)}, agents ${label(counts.agents)}, tools ${label(counts.tools)}. Snapshot ${snapshot.generatedAt}.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerActiveWork(server: McpServer, activity: ActivityService): void {
  server.registerTool(
    "project_status_list_active_work",
    {
      title: "List Project Status Activity Work",
      description: "List bounded, redacted workflow, skill, agent, thread, and tool activity. Defaults to active work; scope can include finished work. Supports exact kind/state filters and offset pagination.",
      inputSchema: ListActiveWorkInput,
      outputSchema: ListActiveWorkOutput,
      annotations: { title: "List Project Status Activity Work", ...READ_ONLY_ANNOTATIONS },
    },
    async ({ scope, kind, state, limit, offset }) => {
      try {
        const snapshot = await activity.load();
        const candidates = scope === "active"
          ? snapshot.activeWork
          : scope === "finished"
            ? snapshot.finishedWork
            : [...snapshot.activeWork, ...snapshot.finishedWork];
        const matches = candidates.filter((item) => (
          (kind === undefined || item.kind === kind)
          && (state === undefined || item.state === state)
        ));
        const page = matches.slice(offset, offset + limit);
        const hasMore = offset + page.length < matches.length;
        const output = {
          ok: true,
          scope,
          total: matches.length,
          count: page.length,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + page.length : null,
          work: page,
        };
        return success(output, `Found ${matches.length} matching ${scope} work item(s); returning ${page.length} from offset ${offset}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerActivityUsage(server: McpServer, activity: ActivityService): void {
  server.registerTool(
    "project_status_get_usage",
    {
      title: "Get Project Status Usage",
      description: "Read context, provider-quota, and task-budget remaining percentages from the optional activity snapshot. Each metric preserves exact, derived, estimated, or unknown truth and never substitutes zero for unavailable data.",
      inputSchema: EmptyInput,
      outputSchema: ActivityUsageToolOutput,
      annotations: { title: "Get Project Status Usage", ...READ_ONLY_ANNOTATIONS },
    },
    async () => {
      try {
        const snapshot = await activity.load();
        const output = { ok: true, generatedAt: snapshot.generatedAt, usage: snapshot.usage };
        return success(output, `Usage snapshot from ${snapshot.generatedAt}; unavailable metrics remain explicitly unknown.`);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerActivityLocks(server: McpServer, activity: ActivityService): void {
  server.registerTool(
    "project_status_get_locks",
    {
      title: "Get Project Status Locks",
      description: "Read the bounded, redacted local thread-lock observation. A stale or unknown observation is not reported as unlocked.",
      inputSchema: EmptyInput,
      outputSchema: ActivityLocksToolOutput,
      annotations: { title: "Get Project Status Locks", ...READ_ONLY_ANNOTATIONS },
    },
    async () => {
      try {
        const snapshot = await activity.load();
        const output = {
          ok: true,
          generatedAt: snapshot.generatedAt,
          count: snapshot.locks.length,
          locks: snapshot.locks,
        };
        return success(output, `Lock state: ${snapshot.lock.state}. Observation: ${snapshot.lock.observedAt ?? "unknown"}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerSummary(server: McpServer, resolveService: ServiceResolver): void {
  server.registerTool(
    "project_status_get_summary",
    {
      title: "Get Project Status Summary",
      description: "Read the validated manifest and return its weighted readiness, task totals, audit freshness, gates, time ranges, and critical-path summary. This tool never modifies files or executes monitoring probes.",
      inputSchema: EmptyInput,
      outputSchema: SummaryOutput,
      annotations: { title: "Get Project Status Summary", ...READ_ONLY_ANNOTATIONS },
    },
    async (_args, ctx) => {
      try {
        const resolution = await resolveService(ctx);
        if (!isManifestService(resolution)) return resolution;
        const service = resolution;
        const manifest = await service.loadValidated();
        const output = summaryOutput(manifest, await service.calculate(manifest));
        const score = records(output.score);
        const tasks = records(output.tasks);
        return success(
          output,
          `# ${manifest.initiative.name}\n\nReadiness: ${score.displayPercent}% (${score.earnedWeight}/${score.totalWeight})\nTasks: ${tasks.complete} complete, ${tasks.inProgress} active, ${tasks.blocked} blocked, ${tasks.notStarted} not started.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerValidation(server: McpServer, resolveService: ServiceResolver): void {
  server.registerTool(
    "project_status_validate_manifest",
    {
      title: "Validate Project Status Manifest",
      description: "Read and validate the configured manifest against the canonical core contract. Returns bounded field-level errors without changing the manifest.",
      inputSchema: EmptyInput,
      outputSchema: ValidationOutput,
      annotations: { title: "Validate Project Status Manifest", ...READ_ONLY_ANNOTATIONS },
    },
    async (_args, ctx) => {
      try {
        const resolution = await resolveService(ctx);
        if (!isManifestService(resolution)) return resolution;
        const service = resolution;
        const result = await service.validate(await service.load());
        const bounded = boundedValidationErrors(result.errors);
        const output = {
          ok: true,
          valid: result.valid,
          errorCount: result.errors.length,
          errors: bounded.errors,
          truncated: bounded.truncated,
        };
        const text = result.valid
          ? "Manifest is valid under the canonical Project Status contract."
          : `Manifest is invalid with ${result.errors.length} error(s). Repair the listed fields and validate again.`;
        return success(output, text);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerTaskList(server: McpServer, resolveService: ServiceResolver): void {
  server.registerTool(
    "project_status_list_tasks",
    {
      title: "List Project Status Tasks",
      description: "List validated manifest tasks with optional status and phase filters plus bounded offset pagination. Returns public task details and no local evidence locators.",
      inputSchema: ListTasksInput,
      outputSchema: ListTasksOutput,
      annotations: { title: "List Project Status Tasks", ...READ_ONLY_ANNOTATIONS },
    },
    async ({ status, phase_id: phaseId, limit, offset }, ctx) => {
      try {
        const resolution = await resolveService(ctx);
        if (!isManifestService(resolution)) return resolution;
        const service = resolution;
        const manifest = await service.loadValidated();
        if (phaseId !== undefined && !manifest.phases.some((phase) => phase.id === phaseId)) {
          return failure({
            code: "phase_not_found",
            message: `No phase matches '${phaseId}'.`,
            nextAction: "Call project_status_list_tasks without phase_id to inspect available phase identifiers.",
          });
        }
        const matches = taskRecords(manifest).filter((task) => (
          (status === undefined || task.status === status)
          && (phaseId === undefined || task.phaseId === phaseId)
        ));
        const page = matches.slice(offset, offset + limit).map(publicTask);
        const hasMore = offset + page.length < matches.length;
        const output = {
          ok: true,
          total: matches.length,
          count: page.length,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + page.length : null,
          tasks: page,
        };
        return success(output, `Found ${matches.length} matching task(s); returning ${page.length} from offset ${offset}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerDependencies(server: McpServer, resolveService: ServiceResolver): void {
  server.registerTool(
    "project_status_get_dependencies",
    {
      title: "Get Project Status Dependencies",
      description: "Read blocking and informing relationships from the validated task DAG. Optionally focus upstream or downstream of one task and paginate the result.",
      inputSchema: DependenciesInput,
      outputSchema: DependenciesOutput,
      annotations: { title: "Get Project Status Dependencies", ...READ_ONLY_ANNOTATIONS },
    },
    async ({ task_id: taskId, direction, type, limit, offset }, ctx) => {
      try {
        const resolution = await resolveService(ctx);
        if (!isManifestService(resolution)) return resolution;
        const service = resolution;
        const manifest = await service.loadValidated();
        const tasks = new Map(taskRecords(manifest).map((task) => [task.id, task] as const));
        if (taskId !== undefined && !tasks.has(taskId)) {
          return failure({
            code: "task_not_found",
            message: `No task matches '${taskId}'.`,
            nextAction: "Call project_status_list_tasks to inspect available task identifiers.",
          });
        }
        if (taskId === undefined && direction !== "all") {
          return failure({
            code: "task_id_required",
            message: `direction '${direction}' requires task_id.`,
            nextAction: "Provide task_id or set direction to 'all'.",
          });
        }
        const matches = manifest.dependencies.filter((dependency) => {
          if (type !== undefined && dependency.type !== type) return false;
          if (taskId === undefined) return true;
          if (direction === "upstream") return dependency.dependentTaskId === taskId;
          if (direction === "downstream") return dependency.prerequisiteTaskId === taskId;
          return dependency.prerequisiteTaskId === taskId || dependency.dependentTaskId === taskId;
        });
        const dependencies = matches.slice(offset, offset + limit).map((dependency) => ({
          type: dependency.type,
          prerequisite: {
            id: dependency.prerequisiteTaskId,
            name: tasks.get(dependency.prerequisiteTaskId)?.name ?? dependency.prerequisiteTaskId,
          },
          dependent: {
            id: dependency.dependentTaskId,
            name: tasks.get(dependency.dependentTaskId)?.name ?? dependency.dependentTaskId,
          },
        }));
        const hasMore = offset + dependencies.length < matches.length;
        const output = {
          ok: true,
          taskId: taskId ?? null,
          total: matches.length,
          count: dependencies.length,
          offset,
          hasMore,
          nextOffset: hasMore ? offset + dependencies.length : null,
          dependencies,
        };
        return success(output, `Found ${matches.length} matching dependency relationship(s); returning ${dependencies.length}.`);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

function registerManifestResource(server: McpServer, resolveService: ServiceResolver): void {
  server.registerResource(
    "project-status-manifest",
    "project-status://manifest",
    {
      title: "Project Status public manifest",
      description: "Deterministic public projection of the configured validated manifest; local and internal evidence locators are omitted.",
      mimeType: "application/json",
      cacheHint: { ttlMs: 5_000, cacheScope: "private" },
    },
    async (uri, ctx) => {
      try {
        const resolution = await resolveService(ctx);
        if (!isManifestService(resolution)) return resolution;
        const service = resolution;
        const manifest = await service.loadValidated();
        const text = JSON.stringify(await service.publicProjection(manifest), null, 2);
        if (text.length > MAX_RESOURCE_CHARACTERS) {
          throw new Error("Public manifest resource exceeds the 512,000-character limit. Use the paginated task and dependency tools instead.");
        }
        return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
      } catch (error) {
        const detail = actionableError(error);
        throw new Error(`${detail.message} ${detail.nextAction}`);
      }
    },
  );
}

function registerActivityResource(server: McpServer, activity: ActivityService): void {
  server.registerResource(
    "project-status-activity",
    "project-status://activity",
    {
      title: "Project Status activity snapshot",
      description: "Bounded public projection of optional local activity, including separate active and finished work lists. Prompt, transcript, command, environment, credential, and raw path fields are omitted or redacted.",
      mimeType: "application/json",
      cacheHint: { ttlMs: 1_000, cacheScope: "private" },
    },
    async (uri) => {
      try {
        const snapshot = await activity.load();
        const activeWork = snapshot.activeWork.slice(0, MAX_ACTIVITY_RESOURCE_ITEMS);
        const finishedWork = snapshot.finishedWork.slice(0, MAX_ACTIVITY_RESOURCE_ITEMS);
        const projection = {
          ...activitySummary(snapshot),
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
        if (text.length > MAX_ACTIVITY_RESOURCE_CHARACTERS) {
          throw {
            code: "activity_resource_too_large",
            message: "The bounded activity resource exceeds the 128,000-character limit.",
            nextAction: "Use project_status_get_activity and project_status_list_active_work with pagination instead.",
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

export interface ProjectStatusServerOptions {
  source?: ManifestSource;
  manifestPath?: string;
  activitySource?: ActivitySource;
  activityPath?: string;
}

export function createProjectStatusServer(options: ProjectStatusServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "project-status-mcp-server",
      version: "1.3.0",
      description: "Read-only access to validated Project Status readiness and optional local activity.",
    },
    {
      instructions: "All tools are local, read-only, idempotent views. Readiness comes only from the validated manifest; activity is an independent optional snapshot and never changes readiness. Validate first when a manifest tool reports a contract error. Monitoring probes and activity writes are intentionally unavailable through MCP.",
    },
  );
  const resolveService = createServiceResolver(server, options);
  const activity = createActivityService(
    options.activitySource ?? createConfiguredActivitySource({ explicitPath: options.activityPath }),
  );
  registerSummary(server, resolveService);
  registerValidation(server, resolveService);
  registerTaskList(server, resolveService);
  registerDependencies(server, resolveService);
  registerActivitySummary(server, activity);
  registerActiveWork(server, activity);
  registerActivityUsage(server, activity);
  registerActivityLocks(server, activity);
  registerManifestResource(server, resolveService);
  registerActivityResource(server, activity);
  return server;
}

export { ErrorOutput };
