export const TASK_STATUSES = Object.freeze(["complete", "in_progress", "blocked", "not_started"]);
export const INITIATIVE_STATES = Object.freeze(["proposal", "active", "complete", "superseded"]);
export const AUDIT_STATES = Object.freeze(["proposal", "current", "stale", "superseded"]);
export const EVIDENCE_KINDS = Object.freeze(["audit_finding", "artifact", "deliverable", "test_result", "external_assertion"]);
export const EVIDENCE_TIERS = Object.freeze(["assertion", "prepared", "validated_local", "public_reproducible", "direct"]);
export const EVIDENCE_STATES = Object.freeze(["current", "stale", "revoked", "unverified"]);
export const VISIBILITIES = Object.freeze(["public", "internal", "restricted"]);
export const LOCATOR_TYPES = Object.freeze(["url", "file", "conversation", "commit", "artifact"]);
export const VERIFIER_TYPES = Object.freeze(["agent", "person", "automation"]);
export const OWNER_TYPES = Object.freeze(["role", "person", "agent", "automation"]);
export const GATE_TYPES = Object.freeze(["provenance", "infrastructure", "deployment", "owner_action", "external_approval", "policy_decision", "security", "evidence"]);
export const GATE_STATUSES = Object.freeze(["satisfied", "unsatisfied", "waiting", "waived"]);
export const WAIT_KINDS = Object.freeze(["unknown", "business_days", "duration_hours"]);
export const DEPENDENCY_TYPES = Object.freeze(["blocks", "informs"]);

export const EVIDENCE_TIER_RANK = Object.freeze({
  assertion: 1,
  prepared: 2,
  validated_local: 3,
  public_reproducible: 4,
  direct: 5,
});

const ID_SCHEMA = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" };
const TEXT_SCHEMA = { type: "string", minLength: 1 };
const TIME_SCHEMA = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$", format: "date-time" };
const SHA_SCHEMA = { type: "string", pattern: "^[a-f0-9]{64}$" };
const ROUTE_SCHEMA = { type: "string", pattern: "^/(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*[?#\\\\])[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$" };
const NULLABLE_TIME_SCHEMA = { anyOf: [TIME_SCHEMA, { type: "null" }] };
const NULLABLE_TEXT_SCHEMA = { anyOf: [TEXT_SCHEMA, { type: "null" }] };
const NULLABLE_RANGE_SCHEMA = { anyOf: [{ $ref: "#/$defs/range" }, { type: "null" }] };

function strictObject(required, properties) {
  return { type: "object", additionalProperties: false, required, properties };
}

// validateManifest enforces this schema plus cross-record semantics without an
// external JSON Schema dependency.
export const MANIFEST_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://project-status.invalid/schema/manifest-v1.json",
  title: "Project Status Initiative Manifest",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "route", "initiative", "source", "audit", "totalWeight", "phases", "evidence", "gates", "dependencies"],
  properties: {
    schemaVersion: { const: 1 },
    route: ROUTE_SCHEMA,
    initiative: { $ref: "#/$defs/initiative" },
    source: { $ref: "#/$defs/source" },
    audit: { $ref: "#/$defs/audit" },
    totalWeight: { const: 100 },
    phases: { type: "array", minItems: 1, items: { $ref: "#/$defs/phase" } },
    evidence: { type: "array", items: { $ref: "#/$defs/evidence" } },
    gates: { type: "array", items: { $ref: "#/$defs/gate" } },
    dependencies: { type: "array", items: { $ref: "#/$defs/dependency" } },
  },
  $defs: {
    initiative: strictObject(["id", "name", "release", "state"], {
      id: ID_SCHEMA,
      name: TEXT_SCHEMA,
      release: TEXT_SCHEMA,
      state: { enum: INITIATIVE_STATES },
    }),
    source: strictObject(["repository", "commit", "deploymentId", "buildId", "manifestSha256"], {
      repository: { anyOf: [{ type: "string", pattern: "^https://" }, { type: "null" }] },
      commit: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{40}$" }, { type: "null" }] },
      deploymentId: NULLABLE_TEXT_SCHEMA,
      buildId: NULLABLE_TEXT_SCHEMA,
      manifestSha256: { anyOf: [SHA_SCHEMA, { type: "null" }] },
    }),
    audit: strictObject(["auditId", "state", "evidenceAsOf", "verifiedAt", "nextDueAt", "staleAfterSeconds"], {
      auditId: ID_SCHEMA,
      state: { enum: AUDIT_STATES },
      evidenceAsOf: TIME_SCHEMA,
      verifiedAt: NULLABLE_TIME_SCHEMA,
      nextDueAt: NULLABLE_TIME_SCHEMA,
      staleAfterSeconds: { type: "integer", minimum: 1 },
    }),
    owner: strictObject(["type", "id", "label"], {
      type: { enum: OWNER_TYPES },
      id: ID_SCHEMA,
      label: TEXT_SCHEMA,
    }),
    range: strictObject(["min", "max"], {
      min: { type: "number", minimum: 0 },
      max: { type: "number", minimum: 0 },
    }),
    evidenceRequirement: strictObject(["minimumTier", "minCount"], {
      minimumTier: { enum: EVIDENCE_TIERS },
      minCount: { type: "integer", minimum: 1 },
    }),
    task: strictObject(
      ["id", "name", "summary", "status", "weight", "earnedWeight", "remainingHours", "recurring", "deferred", "owner", "nextAction", "evidenceRequirement", "evidenceRefs", "gateRefs"],
      {
        id: ID_SCHEMA,
        name: TEXT_SCHEMA,
        summary: TEXT_SCHEMA,
        status: { enum: TASK_STATUSES },
        weight: { type: "number", exclusiveMinimum: 0 },
        earnedWeight: { type: "number", minimum: 0 },
        remainingHours: NULLABLE_RANGE_SCHEMA,
        recurring: { type: "boolean" },
        deferred: { type: "boolean" },
        owner: { $ref: "#/$defs/owner" },
        nextAction: NULLABLE_TEXT_SCHEMA,
        evidenceRequirement: { $ref: "#/$defs/evidenceRequirement" },
        evidenceRefs: { type: "array", uniqueItems: true, items: ID_SCHEMA },
        gateRefs: { type: "array", uniqueItems: true, items: ID_SCHEMA },
      },
    ),
    phase: strictObject(["id", "name", "summary", "weight", "tasks"], {
      id: ID_SCHEMA,
      name: TEXT_SCHEMA,
      summary: TEXT_SCHEMA,
      weight: { type: "number", exclusiveMinimum: 0 },
      tasks: { type: "array", minItems: 1, items: { $ref: "#/$defs/task" } },
    }),
    urlLocator: strictObject(["type", "url"], {
      type: { const: "url" },
      url: { type: "string", pattern: "^https://" },
    }),
    fileLocator: strictObject(["type", "path"], {
      type: { const: "file" },
      path: { type: "string", pattern: "^/" },
    }),
    conversationLocator: strictObject(["type", "reference"], {
      type: { const: "conversation" },
      reference: TEXT_SCHEMA,
    }),
    commitLocator: strictObject(["type", "repository", "commit"], {
      type: { const: "commit" },
      repository: { type: "string", pattern: "^https://" },
      commit: { type: "string", pattern: "^[a-f0-9]{40}$" },
    }),
    artifactLocator: strictObject(["type", "name", "digest"], {
      type: { const: "artifact" },
      name: TEXT_SCHEMA,
      digest: SHA_SCHEMA,
    }),
    locator: {
      oneOf: [
        { $ref: "#/$defs/urlLocator" },
        { $ref: "#/$defs/fileLocator" },
        { $ref: "#/$defs/conversationLocator" },
        { $ref: "#/$defs/commitLocator" },
        { $ref: "#/$defs/artifactLocator" },
      ],
    },
    integrity: strictObject(["algorithm", "digest"], {
      algorithm: { const: "sha256" },
      digest: SHA_SCHEMA,
    }),
    verifier: strictObject(["type", "id", "label"], {
      type: { enum: VERIFIER_TYPES },
      id: ID_SCHEMA,
      label: TEXT_SCHEMA,
    }),
    evidence: strictObject(
      ["id", "kind", "tier", "state", "visibility", "assertion", "publicSummary", "capturedAt", "verifiedAt", "expiresAt", "locator", "integrity", "verifier"],
      {
        id: ID_SCHEMA,
        kind: { enum: EVIDENCE_KINDS },
        tier: { enum: EVIDENCE_TIERS },
        state: { enum: EVIDENCE_STATES },
        visibility: { enum: VISIBILITIES },
        assertion: TEXT_SCHEMA,
        publicSummary: TEXT_SCHEMA,
        capturedAt: TIME_SCHEMA,
        verifiedAt: TIME_SCHEMA,
        expiresAt: NULLABLE_TIME_SCHEMA,
        locator: { $ref: "#/$defs/locator" },
        integrity: { anyOf: [{ $ref: "#/$defs/integrity" }, { type: "null" }] },
        verifier: { $ref: "#/$defs/verifier" },
      },
    ),
    unknownWait: strictObject(["kind", "label"], { kind: { const: "unknown" }, label: TEXT_SCHEMA }),
    rangedWait: strictObject(["kind", "label", "min", "max"], {
      kind: { enum: ["business_days", "duration_hours"] },
      label: TEXT_SCHEMA,
      min: { type: "number", minimum: 0 },
      max: { type: "number", minimum: 0 },
    }),
    wait: { oneOf: [{ $ref: "#/$defs/unknownWait" }, { $ref: "#/$defs/rangedWait" }, { type: "null" }] },
    gate: strictObject(["id", "name", "type", "status", "reason", "owner", "nextAction", "wait", "taskRefs"], {
      id: ID_SCHEMA,
      name: TEXT_SCHEMA,
      type: { enum: GATE_TYPES },
      status: { enum: GATE_STATUSES },
      reason: TEXT_SCHEMA,
      owner: { $ref: "#/$defs/owner" },
      nextAction: NULLABLE_TEXT_SCHEMA,
      wait: { $ref: "#/$defs/wait" },
      taskRefs: { type: "array", uniqueItems: true, items: ID_SCHEMA },
    }),
    dependency: strictObject(["id", "type", "prerequisiteTaskId", "dependentTaskId"], {
      id: ID_SCHEMA,
      type: { enum: DEPENDENCY_TYPES },
      prerequisiteTaskId: ID_SCHEMA,
      dependentTaskId: ID_SCHEMA,
    }),
  },
});
