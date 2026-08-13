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

export interface ActionableError {
  code: string;
  message: string;
  nextAction: string;
}
