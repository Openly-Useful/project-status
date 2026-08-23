export type TaskStatus = "complete" | "in_progress" | "blocked" | "not_started";

export interface Owner {
  type: string;
  id: string;
  label: string;
}

export interface RemainingHours {
  min: number;
  max: number;
}

export interface ManifestTask {
  id: string;
  name: string;
  summary: string;
  status: TaskStatus;
  weight: number;
  earnedWeight: number;
  remainingHours: RemainingHours | null;
  recurring: boolean;
  deferred: boolean;
  owner: Owner;
  nextAction: string | null;
  evidenceRequirement: { minimumTier: string; minCount: number };
  evidenceRefs: string[];
  gateRefs: string[];
}

export interface ManifestPhase {
  id: string;
  name: string;
  summary: string;
  weight: number;
  tasks: ManifestTask[];
}

export interface ManifestDependency {
  id: string;
  type: "blocks" | "informs";
  prerequisiteTaskId: string;
  dependentTaskId: string;
}

export interface ProjectStatusManifest {
  schemaVersion: number;
  initiative: { id: string; name: string; release: string; state: string };
  audit: {
    auditId: string;
    state: string;
    evidenceAsOf: string;
    verifiedAt: string | null;
    nextDueAt: string | null;
    staleAfterSeconds: number;
  };
  totalWeight: number;
  phases: ManifestPhase[];
  evidence: unknown[];
  gates: Array<{ id: string; status: string }>;
  dependencies: ManifestDependency[];
}

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface CoreModule {
  validateManifest(manifest: unknown, options?: Record<string, unknown>): ValidationResult;
  calculateStatus(manifest: ProjectStatusManifest, options?: Record<string, unknown>): Record<string, unknown>;
  createPublicProjection(manifest: ProjectStatusManifest, options?: Record<string, unknown>): Record<string, unknown>;
}

export interface ManifestSource {
  load(): Promise<unknown>;
}

export type ActivityEntityKind = "thread" | "workflow" | "skill" | "agent" | "tool";

export type ActivityState = "queued" | "running" | "waiting" | "completed" | "failed" | "stopped";

export type ActivityThreadState = "ready" | "running" | "waiting" | "locked" | "stale" | "unknown" | "failed" | "stopped";

export type ActivityTruthClass = "exact" | "derived" | "estimated" | "unknown";

export interface ActivityMetric {
  value: number | null;
  truthClass: ActivityTruthClass;
  source: string;
  observedAt: string | null;
  unit: string | null;
}

export interface ActivityProgress {
  mode: "determinate" | "indeterminate" | "unavailable";
  completed: number | null;
  total: number | null;
  percent: number | null;
}

export interface ActivityWorkItem {
  id: string;
  kind: ActivityEntityKind;
  label: string;
  state: ActivityState;
  parentId: string | null;
  progress: ActivityProgress;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  elapsedSeconds: number | null;
}

export interface ActivityLock {
  id: string;
  state: "unlocked" | "locked" | "stale" | "unknown";
  owner: string | null;
  observedAt: string | null;
}

export interface ActivityVerification {
  id: string;
  name: string;
  status: "PASS" | "FAIL" | "STOPPED" | "UNKNOWN";
  exitCode: number | null;
  durationMs: number | null;
}

export interface ActivityReceipt {
  schemaVersion: number;
  sessionId: string | null;
  completedAt: string;
  status: "complete" | "partial" | "failed" | "stopped" | "unknown";
  taskResult: "complete" | "partial" | "failed" | "stopped" | "unknown";
  projectReadiness: {
    status: "not_assessed";
    value: null;
    source: null;
  };
  summary: string | null;
  fixes: string[];
  verifications: ActivityVerification[];
  remaining: string[];
  duration: string;
  counts: {
    workflows: number;
    skills: number;
    agents: number;
  };
}

export interface ActivitySnapshot {
  schemaVersion: number;
  sessionId: string | null;
  generatedAt: string;
  thread: {
    state: ActivityThreadState;
    startedAt: string | null;
  };
  progress: ActivityProgress;
  counts: {
    workflows: number | null;
    skills: number | null;
    agents: number | null;
    tools: number | null;
  };
  usage: {
    contextRemainingPercent: ActivityMetric;
    quotaRemainingPercent: ActivityMetric;
    taskBudgetRemainingPercent: ActivityMetric;
  };
  lock: ActivityLock;
  locks: ActivityLock[];
  freshness: {
    heartbeatAt: string | null;
    ageSeconds: number | null;
  };
  capabilities: Record<string, boolean>;
  activeWork: ActivityWorkItem[];
  finishedWork: ActivityWorkItem[];
  lastReceipt: ActivityReceipt | null;
}

export interface ActivitySource {
  load(): Promise<unknown>;
}

export interface ActionableError {
  code: string;
  message: string;
  nextAction: string;
}
