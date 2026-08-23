import {
  AUDIT_STATES,
  DEPENDENCY_TYPES,
  EVIDENCE_KINDS,
  EVIDENCE_STATES,
  EVIDENCE_TIER_RANK,
  EVIDENCE_TIERS,
  GATE_STATUSES,
  GATE_TYPES,
  INITIATIVE_STATES,
  LOCATOR_TYPES,
  OWNER_TYPES,
  TASK_STATUSES,
  VERIFIER_TYPES,
  VISIBILITIES,
  WAIT_KINDS,
} from "./schema.mjs";
import { resolveClock } from "./time.mjs";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const EPSILON = 1e-9;
const SECRET_QUERY_RE = /(?:^|_)(?:access|api|auth|credential|key|password|secret|signature|token)(?:$|_)/i;

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function close(first, second) {
  return Math.abs(first - second) <= EPSILON;
}

class Collector {
  errors = [];

  add(code, path, message) {
    this.errors.push({ code, path, message });
  }

  object(value, path, allowed, required = allowed) {
    if (!isRecord(value)) {
      this.add("expected_object", path, "must be a plain object");
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.add("unknown_property", `${path}.${key}`, "is not allowed");
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) this.add("missing_property", `${path}.${key}`, "is required");
    }
    return true;
  }

  array(value, path, { min = 0 } = {}) {
    if (!Array.isArray(value)) {
      this.add("expected_array", path, "must be an array");
      return false;
    }
    if (value.length < min) this.add("array_too_short", path, `must contain at least ${min} item(s)`);
    return true;
  }

  string(value, path, { nullable = false, pattern, min = 1 } = {}) {
    if (nullable && value === null) return true;
    if (typeof value !== "string") {
      this.add("expected_string", path, nullable ? "must be a string or null" : "must be a string");
      return false;
    }
    if (value.trim().length < min) this.add("empty_string", path, "must not be empty");
    if (pattern && !pattern.test(value)) this.add("invalid_format", path, "has an invalid format");
    return true;
  }

  number(value, path, { min = -Infinity, max = Infinity, integer = false } = {}) {
    if (!Number.isFinite(value)) {
      this.add("expected_number", path, "must be a finite number");
      return false;
    }
    if (integer && !Number.isInteger(value)) this.add("expected_integer", path, "must be an integer");
    if (value < min || value > max) this.add("number_out_of_range", path, `must be between ${min} and ${max}`);
    return true;
  }

  boolean(value, path) {
    if (typeof value !== "boolean") {
      this.add("expected_boolean", path, "must be a boolean");
      return false;
    }
    return true;
  }

  enum(value, path, values) {
    if (!values.includes(value)) {
      this.add("invalid_enum", path, `must be one of: ${values.join(", ")}`);
      return false;
    }
    return true;
  }

  timestamp(value, path, { nullable = false } = {}) {
    if (nullable && value === null) return true;
    if (!this.string(value, path)) return false;
    if (!ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
      this.add("invalid_timestamp", path, "must be an exact UTC ISO-8601 timestamp with milliseconds");
      return false;
    }
    return true;
  }

  id(value, path) {
    return this.string(value, path, { pattern: ID_PATTERN });
  }

  httpsUrl(value, path, { nullable = false } = {}) {
    if (nullable && value === null) return true;
    if (!this.string(value, path)) return false;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") throw new Error("not https");
      if (parsed.username || parsed.password) throw new Error("credentials");
      for (const key of parsed.searchParams.keys()) {
        if (SECRET_QUERY_RE.test(key)) throw new Error("secret query");
      }
    } catch {
      this.add("invalid_url", path, "must be an absolute HTTPS URL without credentials or secret-like query parameters");
      return false;
    }
    return true;
  }

  route(value, path) {
    if (!this.string(value, path)) return false;
    if (!value.startsWith("/") || value.startsWith("//") || /[?#\\\\\u0000-\u001f\u007f]/.test(value)) {
      this.add("invalid_route", path, "must be an absolute URL path without authority, query, fragment, backslash, or control characters");
      return false;
    }
    try {
      const segments = value.split("/");
      if (segments.some((segment) => {
        const decoded = decodeURIComponent(segment).toLowerCase();
        return decoded === "." || decoded === "..";
      })) {
        this.add("invalid_route", path, "must not contain traversal segments");
        return false;
      }
    } catch {
      this.add("invalid_route", path, "must contain valid percent encoding");
      return false;
    }
    return true;
  }
}

function validateStringArray(collector, value, path) {
  if (!collector.array(value, path)) return;
  const seen = new Set();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!collector.id(item, itemPath)) return;
    if (seen.has(item)) collector.add("duplicate_reference", itemPath, `duplicates ${item}`);
    seen.add(item);
  });
}

function validateOwner(collector, owner, path) {
  if (!collector.object(owner, path, ["type", "id", "label"])) return;
  collector.enum(owner.type, `${path}.type`, OWNER_TYPES);
  collector.id(owner.id, `${path}.id`);
  collector.string(owner.label, `${path}.label`);
}

function validateRange(collector, range, path) {
  if (range === null) return;
  if (!collector.object(range, path, ["min", "max"])) return;
  const minValid = collector.number(range.min, `${path}.min`, { min: 0 });
  const maxValid = collector.number(range.max, `${path}.max`, { min: 0 });
  if (minValid && maxValid && range.max < range.min) {
    collector.add("invalid_range", path, "max must be greater than or equal to min");
  }
}

function validateTask(collector, task, path) {
  const keys = [
    "id", "name", "summary", "status", "weight", "earnedWeight", "remainingHours",
    "recurring", "deferred", "owner", "nextAction", "evidenceRequirement", "evidenceRefs", "gateRefs",
  ];
  if (!collector.object(task, path, keys)) return;
  collector.id(task.id, `${path}.id`);
  collector.string(task.name, `${path}.name`);
  collector.string(task.summary, `${path}.summary`);
  collector.enum(task.status, `${path}.status`, TASK_STATUSES);
  collector.number(task.weight, `${path}.weight`, { min: Number.EPSILON });
  collector.number(task.earnedWeight, `${path}.earnedWeight`, { min: 0 });
  validateRange(collector, task.remainingHours, `${path}.remainingHours`);
  collector.boolean(task.recurring, `${path}.recurring`);
  collector.boolean(task.deferred, `${path}.deferred`);
  validateOwner(collector, task.owner, `${path}.owner`);
  collector.string(task.nextAction, `${path}.nextAction`, { nullable: true });

  if (collector.object(task.evidenceRequirement, `${path}.evidenceRequirement`, ["minimumTier", "minCount"])) {
    collector.enum(task.evidenceRequirement.minimumTier, `${path}.evidenceRequirement.minimumTier`, EVIDENCE_TIERS);
    collector.number(task.evidenceRequirement.minCount, `${path}.evidenceRequirement.minCount`, { min: 1, integer: true });
  }
  validateStringArray(collector, task.evidenceRefs, `${path}.evidenceRefs`);
  validateStringArray(collector, task.gateRefs, `${path}.gateRefs`);
}

function validatePhase(collector, phase, path) {
  if (!collector.object(phase, path, ["id", "name", "summary", "weight", "tasks"])) return;
  collector.id(phase.id, `${path}.id`);
  collector.string(phase.name, `${path}.name`);
  collector.string(phase.summary, `${path}.summary`);
  collector.number(phase.weight, `${path}.weight`, { min: Number.EPSILON });
  if (collector.array(phase.tasks, `${path}.tasks`, { min: 1 })) {
    phase.tasks.forEach((task, index) => validateTask(collector, task, `${path}.tasks[${index}]`));
  }
}

function validateLocator(collector, locator, path) {
  if (!isRecord(locator)) {
    collector.add("expected_object", path, "must be a locator object");
    return;
  }
  if (!LOCATOR_TYPES.includes(locator.type)) {
    collector.enum(locator.type, `${path}.type`, LOCATOR_TYPES);
    return;
  }

  const shapes = {
    url: ["type", "url"],
    file: ["type", "path"],
    conversation: ["type", "reference"],
    commit: ["type", "repository", "commit"],
    artifact: ["type", "name", "digest"],
  };
  const keys = shapes[locator.type];
  collector.object(locator, path, keys);
  if (locator.type === "url") collector.httpsUrl(locator.url, `${path}.url`);
  if (locator.type === "file") {
    if (collector.string(locator.path, `${path}.path`) && !locator.path.startsWith("/")) {
      collector.add("invalid_file_path", `${path}.path`, "must be an absolute path");
    }
  }
  if (locator.type === "conversation") collector.string(locator.reference, `${path}.reference`);
  if (locator.type === "commit") {
    collector.httpsUrl(locator.repository, `${path}.repository`);
    collector.string(locator.commit, `${path}.commit`, { pattern: COMMIT_PATTERN });
  }
  if (locator.type === "artifact") {
    collector.string(locator.name, `${path}.name`);
    collector.string(locator.digest, `${path}.digest`, { pattern: SHA256_PATTERN });
  }
}

function validateIntegrity(collector, integrity, path) {
  if (integrity === null) return;
  if (!collector.object(integrity, path, ["algorithm", "digest"])) return;
  if (integrity.algorithm !== "sha256") collector.add("invalid_enum", `${path}.algorithm`, "must be sha256");
  collector.string(integrity.digest, `${path}.digest`, { pattern: SHA256_PATTERN });
}

function validateVerifier(collector, verifier, path) {
  if (!collector.object(verifier, path, ["type", "id", "label"])) return;
  collector.enum(verifier.type, `${path}.type`, VERIFIER_TYPES);
  collector.id(verifier.id, `${path}.id`);
  collector.string(verifier.label, `${path}.label`);
}

function validateEvidence(collector, evidence, path) {
  const keys = [
    "id", "kind", "tier", "state", "visibility", "assertion", "publicSummary",
    "capturedAt", "verifiedAt", "expiresAt", "locator", "integrity", "verifier",
  ];
  if (!collector.object(evidence, path, keys)) return;
  collector.id(evidence.id, `${path}.id`);
  collector.enum(evidence.kind, `${path}.kind`, EVIDENCE_KINDS);
  collector.enum(evidence.tier, `${path}.tier`, EVIDENCE_TIERS);
  collector.enum(evidence.state, `${path}.state`, EVIDENCE_STATES);
  collector.enum(evidence.visibility, `${path}.visibility`, VISIBILITIES);
  collector.string(evidence.assertion, `${path}.assertion`);
  collector.string(evidence.publicSummary, `${path}.publicSummary`);
  collector.timestamp(evidence.capturedAt, `${path}.capturedAt`);
  collector.timestamp(evidence.verifiedAt, `${path}.verifiedAt`);
  collector.timestamp(evidence.expiresAt, `${path}.expiresAt`, { nullable: true });
  validateLocator(collector, evidence.locator, `${path}.locator`);
  validateIntegrity(collector, evidence.integrity, `${path}.integrity`);
  validateVerifier(collector, evidence.verifier, `${path}.verifier`);
}

function validateWait(collector, wait, path) {
  if (wait === null) return;
  if (!isRecord(wait)) {
    collector.add("expected_object", path, "must be a typed wait object or null");
    return;
  }
  if (!WAIT_KINDS.includes(wait.kind)) {
    collector.enum(wait.kind, `${path}.kind`, WAIT_KINDS);
    return;
  }
  const keys = wait.kind === "unknown" ? ["kind", "label"] : ["kind", "label", "min", "max"];
  collector.object(wait, path, keys);
  collector.string(wait.label, `${path}.label`);
  if (wait.kind !== "unknown") validateRange(collector, { min: wait.min, max: wait.max }, path);
}

function validateGate(collector, gate, path) {
  const keys = ["id", "name", "type", "status", "reason", "owner", "nextAction", "wait", "taskRefs"];
  if (!collector.object(gate, path, keys)) return;
  collector.id(gate.id, `${path}.id`);
  collector.string(gate.name, `${path}.name`);
  collector.enum(gate.type, `${path}.type`, GATE_TYPES);
  collector.enum(gate.status, `${path}.status`, GATE_STATUSES);
  collector.string(gate.reason, `${path}.reason`);
  validateOwner(collector, gate.owner, `${path}.owner`);
  collector.string(gate.nextAction, `${path}.nextAction`, { nullable: true });
  validateWait(collector, gate.wait, `${path}.wait`);
  validateStringArray(collector, gate.taskRefs, `${path}.taskRefs`);
}

function validateDependency(collector, dependency, path) {
  const keys = ["id", "type", "prerequisiteTaskId", "dependentTaskId"];
  if (!collector.object(dependency, path, keys)) return;
  collector.id(dependency.id, `${path}.id`);
  collector.enum(dependency.type, `${path}.type`, DEPENDENCY_TYPES);
  collector.id(dependency.prerequisiteTaskId, `${path}.prerequisiteTaskId`);
  collector.id(dependency.dependentTaskId, `${path}.dependentTaskId`);
}

function addUnique(collector, map, id, path, kind) {
  if (typeof id !== "string") return;
  if (map.has(id)) collector.add("duplicate_id", path, `${kind} id ${id} is duplicated`);
  else map.set(id, path);
}

function instant(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;
}

function detectCycles(collector, taskIds, dependencies) {
  const adjacency = new Map([...taskIds].map((id) => [id, []]));
  for (const dependency of dependencies) {
    if (adjacency.has(dependency.prerequisiteTaskId) && adjacency.has(dependency.dependentTaskId)) {
      adjacency.get(dependency.prerequisiteTaskId).push(dependency.dependentTaskId);
    }
  }
  for (const values of adjacency.values()) values.sort();

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function walk(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      collector.add("dependency_cycle", "$.dependencies", `contains a cycle: ${cycle.join(" -> ")}`);
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (walk(next)) return true;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const id of [...taskIds].sort()) {
    if (walk(id)) break;
  }
}

function semanticValidation(collector, manifest, options) {
  if (!isRecord(manifest) || !Array.isArray(manifest.phases)) return;

  const phaseIds = new Map();
  const tasks = new Map();
  let phaseWeight = 0;
  manifest.phases.forEach((phase, phaseIndex) => {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) return;
    addUnique(collector, phaseIds, phase.id, `$.phases[${phaseIndex}].id`, "phase");
    let taskWeight = 0;
    phase.tasks.forEach((task, taskIndex) => {
      if (!isRecord(task)) return;
      const path = `$.phases[${phaseIndex}].tasks[${taskIndex}]`;
      addUnique(collector, tasks, task.id, `${path}.id`, "task");
      if (Number.isFinite(task.weight)) taskWeight += task.weight;
      if (Number.isFinite(task.weight) && Number.isFinite(task.earnedWeight) && task.earnedWeight > task.weight + EPSILON) {
        collector.add("earned_exceeds_weight", `${path}.earnedWeight`, "must not exceed task weight");
      }
      if (task.status === "complete" && Number.isFinite(task.weight) && !close(task.earnedWeight, task.weight)) {
        collector.add("invalid_credit", `${path}.earnedWeight`, "complete tasks must earn full weight");
      }
      if (["blocked", "not_started"].includes(task.status) && !close(task.earnedWeight, 0)) {
        collector.add("invalid_credit", `${path}.earnedWeight`, `${task.status} tasks must earn zero`);
      }
      if (task.status === "complete") {
        if (task.remainingHours === null || !close(task.remainingHours?.min ?? NaN, 0) || !close(task.remainingHours?.max ?? NaN, 0)) {
          collector.add("invalid_remaining_hours", `${path}.remainingHours`, "complete tasks must have a 0–0 range");
        }
        if (task.nextAction !== null) collector.add("invalid_next_action", `${path}.nextAction`, "complete tasks must use null");
      } else if (typeof task.nextAction !== "string" || task.nextAction.trim() === "") {
        collector.add("missing_next_action", `${path}.nextAction`, "unfinished tasks require a concrete next action");
      }
    });
    if (Number.isFinite(phase.weight) && !close(taskWeight, phase.weight)) {
      collector.add("phase_weight_mismatch", `$.phases[${phaseIndex}].tasks`, `task weights ${taskWeight} do not equal phase weight ${phase.weight}`);
    }
    if (Number.isFinite(phase.weight)) phaseWeight += phase.weight;
  });
  if (Number.isFinite(manifest.totalWeight) && !close(phaseWeight, manifest.totalWeight)) {
    collector.add("total_weight_mismatch", "$.phases", `phase weights ${phaseWeight} do not equal total weight ${manifest.totalWeight}`);
  }
  if (manifest.totalWeight !== 100) collector.add("invalid_total_weight", "$.totalWeight", "must equal 100");

  const evidence = new Map();
  if (Array.isArray(manifest.evidence)) {
    manifest.evidence.forEach((item, index) => {
      if (!isRecord(item)) return;
      addUnique(collector, evidence, item.id, `$.evidence[${index}].id`, "evidence");
      const captured = instant(item.capturedAt);
      const verified = instant(item.verifiedAt);
      const expires = instant(item.expiresAt);
      if (captured !== null && verified !== null && verified < captured) {
        collector.add("invalid_time_order", `$.evidence[${index}].verifiedAt`, "must not precede capturedAt");
      }
      if (captured !== null && expires !== null && expires <= captured) {
        collector.add("invalid_time_order", `$.evidence[${index}].expiresAt`, "must follow capturedAt");
      }
    });
  }

  const gates = new Map();
  if (Array.isArray(manifest.gates)) {
    manifest.gates.forEach((gate, index) => {
      if (!isRecord(gate)) return;
      addUnique(collector, gates, gate.id, `$.gates[${index}].id`, "gate");
      if (["unsatisfied", "waiting"].includes(gate.status) && (typeof gate.nextAction !== "string" || gate.nextAction.trim() === "")) {
        collector.add("missing_next_action", `$.gates[${index}].nextAction`, "uncleared gates require a concrete next action");
      }
      if (["satisfied", "waived"].includes(gate.status) && gate.nextAction !== null) {
        collector.add("invalid_next_action", `$.gates[${index}].nextAction`, "cleared gates must use null");
      }
    });
  }

  const auditAsOf = instant(manifest.audit?.evidenceAsOf);
  for (const [taskId, taskPath] of tasks) {
    const [phaseIndex, taskIndex] = taskPath.match(/\d+/g)?.map(Number) ?? [];
    const task = manifest.phases[phaseIndex]?.tasks[taskIndex];
    if (!task) continue;
    const evidenceRefs = Array.isArray(task.evidenceRefs) ? task.evidenceRefs : [];
    const gateRefs = Array.isArray(task.gateRefs) ? task.gateRefs : [];

    for (const [index, evidenceId] of evidenceRefs.entries()) {
      if (!evidence.has(evidenceId)) {
        collector.add("dangling_evidence_ref", `${taskPath}.evidenceRefs[${index}]`, `unknown evidence id ${evidenceId}`);
      }
    }
    for (const [index, gateId] of gateRefs.entries()) {
      if (!gates.has(gateId)) {
        collector.add("dangling_gate_ref", `${taskPath}.gateRefs[${index}]`, `unknown gate id ${gateId}`);
      }
    }

    if (Number.isFinite(task.earnedWeight) && task.earnedWeight > 0 && isRecord(task.evidenceRequirement)) {
      const qualifying = evidenceRefs.filter((evidenceId) => {
        const evidencePath = evidence.get(evidenceId);
        if (!evidencePath) return false;
        const index = Number(evidencePath.match(/\d+/)?.[0]);
        const item = manifest.evidence[index];
        const captured = instant(item.capturedAt);
        const expires = instant(item.expiresAt);
        return item.state === "current"
          && EVIDENCE_TIER_RANK[item.tier] >= EVIDENCE_TIER_RANK[task.evidenceRequirement.minimumTier]
          && (auditAsOf === null || captured === null || captured <= auditAsOf)
          && (auditAsOf === null || expires === null || expires > auditAsOf);
      });
      if (qualifying.length < task.evidenceRequirement.minCount) {
        collector.add(
          "insufficient_evidence",
          `${taskPath}.evidenceRefs`,
          `earned credit requires ${task.evidenceRequirement.minCount} current ${task.evidenceRequirement.minimumTier}-or-better evidence record(s)`,
        );
      }
    }

    for (const gateId of gateRefs) {
      const gatePath = gates.get(gateId);
      if (!gatePath) continue;
      const gateIndex = Number(gatePath.match(/\d+/)?.[0]);
      const gate = manifest.gates[gateIndex];
      const reciprocalTaskRefs = Array.isArray(gate.taskRefs) ? gate.taskRefs : [];
      if (!reciprocalTaskRefs.includes(taskId)) {
        collector.add("gate_reference_mismatch", `${taskPath}.gateRefs`, `${gateId} does not reciprocally reference ${taskId}`);
      }
      if (["unsatisfied", "waiting"].includes(gate.status) && task.earnedWeight > 0) {
        collector.add("credit_behind_gate", `${taskPath}.earnedWeight`, `must be zero while gate ${gateId} is uncleared`);
      }
    }
  }

  if (Array.isArray(manifest.gates)) {
    manifest.gates.forEach((gate, gateIndex) => {
      if (!isRecord(gate)) return;
      const taskRefs = Array.isArray(gate.taskRefs) ? gate.taskRefs : [];
      for (const [index, taskId] of taskRefs.entries()) {
        const taskPath = tasks.get(taskId);
        if (!taskPath) collector.add("dangling_task_ref", `$.gates[${gateIndex}].taskRefs[${index}]`, `unknown task id ${taskId}`);
        else {
          const [phaseIndex, taskIndex] = taskPath.match(/\d+/g)?.map(Number) ?? [];
          const reciprocalGateRefs = manifest.phases[phaseIndex].tasks[taskIndex].gateRefs;
          if (!(Array.isArray(reciprocalGateRefs) ? reciprocalGateRefs : []).includes(gate.id)) {
            collector.add("gate_reference_mismatch", `$.gates[${gateIndex}].taskRefs`, `${taskId} does not reciprocally reference ${gate.id}`);
          }
        }
      }
    });
  }

  const dependencyIds = new Map();
  const edgeKeys = new Set();
  if (Array.isArray(manifest.dependencies)) {
    manifest.dependencies.forEach((dependency, index) => {
      if (!isRecord(dependency)) return;
      addUnique(collector, dependencyIds, dependency.id, `$.dependencies[${index}].id`, "dependency");
      if (!tasks.has(dependency.prerequisiteTaskId)) {
        collector.add("dangling_dependency_ref", `$.dependencies[${index}].prerequisiteTaskId`, `unknown task id ${dependency.prerequisiteTaskId}`);
      }
      if (!tasks.has(dependency.dependentTaskId)) {
        collector.add("dangling_dependency_ref", `$.dependencies[${index}].dependentTaskId`, `unknown task id ${dependency.dependentTaskId}`);
      }
      if (dependency.prerequisiteTaskId === dependency.dependentTaskId) {
        collector.add("self_dependency", `$.dependencies[${index}]`, "a task cannot depend on itself");
      }
      const edgeKey = `${dependency.type}:${dependency.prerequisiteTaskId}:${dependency.dependentTaskId}`;
      if (edgeKeys.has(edgeKey)) collector.add("duplicate_dependency", `$.dependencies[${index}]`, "duplicates an existing dependency edge");
      edgeKeys.add(edgeKey);
    });
    detectCycles(collector, new Set(tasks.keys()), manifest.dependencies.filter(isRecord));
  }

  const evidenceAsOf = instant(manifest.audit?.evidenceAsOf);
  const verifiedAt = instant(manifest.audit?.verifiedAt);
  const nextDueAt = instant(manifest.audit?.nextDueAt);
  if (evidenceAsOf !== null && verifiedAt !== null && verifiedAt < evidenceAsOf) {
    collector.add("invalid_time_order", "$.audit.verifiedAt", "must not precede evidenceAsOf");
  }
  const auditBaseline = verifiedAt ?? evidenceAsOf;
  if (auditBaseline !== null && nextDueAt !== null && nextDueAt <= auditBaseline) {
    collector.add("invalid_time_order", "$.audit.nextDueAt", "must follow the latest audit timestamp");
  }

  if (manifest.source?.commit !== null && manifest.source?.repository === null) {
    collector.add("incomplete_provenance", "$.source.repository", "is required when commit is present");
  }
  if ([manifest.source?.deploymentId, manifest.source?.buildId, manifest.source?.manifestSha256].some((value) => value !== null)
      && manifest.source?.commit === null) {
    collector.add("incomplete_provenance", "$.source.commit", "is required when build or deployment provenance is present");
  }

  if (options.now !== undefined || options.clock !== undefined) {
    let now;
    try {
      now = resolveClock(options).getTime();
    } catch (error) {
      throw error;
    }
    const evidenceItems = Array.isArray(manifest.evidence) ? manifest.evidence : [];
    const timeFields = [
      ["$.audit.evidenceAsOf", manifest.audit?.evidenceAsOf],
      ["$.audit.verifiedAt", manifest.audit?.verifiedAt],
      ...evidenceItems.flatMap((item, index) => [
        [`$.evidence[${index}].capturedAt`, item?.capturedAt],
        [`$.evidence[${index}].verifiedAt`, item?.verifiedAt],
      ]),
    ];
    for (const [path, value] of timeFields) {
      const parsed = instant(value);
      if (parsed !== null && parsed > now) collector.add("timestamp_in_future", path, "must not be later than the injected clock");
    }
  }
}

function structuralValidation(collector, manifest) {
  const rootKeys = ["schemaVersion", "route", "initiative", "source", "audit", "totalWeight", "phases", "evidence", "gates", "dependencies"];
  if (!collector.object(manifest, "$", rootKeys)) return;
  if (manifest.schemaVersion !== 1) collector.add("unsupported_schema_version", "$.schemaVersion", "must equal 1");
  collector.route(manifest.route, "$.route");
  collector.number(manifest.totalWeight, "$.totalWeight", { min: 100, max: 100 });

  if (collector.object(manifest.initiative, "$.initiative", ["id", "name", "release", "state"])) {
    collector.id(manifest.initiative.id, "$.initiative.id");
    collector.string(manifest.initiative.name, "$.initiative.name");
    collector.string(manifest.initiative.release, "$.initiative.release");
    collector.enum(manifest.initiative.state, "$.initiative.state", INITIATIVE_STATES);
  }

  const sourceKeys = ["repository", "commit", "deploymentId", "buildId", "manifestSha256"];
  if (collector.object(manifest.source, "$.source", sourceKeys)) {
    collector.httpsUrl(manifest.source.repository, "$.source.repository", { nullable: true });
    collector.string(manifest.source.commit, "$.source.commit", { nullable: true, pattern: COMMIT_PATTERN });
    collector.string(manifest.source.deploymentId, "$.source.deploymentId", { nullable: true });
    collector.string(manifest.source.buildId, "$.source.buildId", { nullable: true });
    collector.string(manifest.source.manifestSha256, "$.source.manifestSha256", { nullable: true, pattern: SHA256_PATTERN });
  }

  const auditKeys = ["auditId", "state", "evidenceAsOf", "verifiedAt", "nextDueAt", "staleAfterSeconds"];
  if (collector.object(manifest.audit, "$.audit", auditKeys)) {
    collector.id(manifest.audit.auditId, "$.audit.auditId");
    collector.enum(manifest.audit.state, "$.audit.state", AUDIT_STATES);
    collector.timestamp(manifest.audit.evidenceAsOf, "$.audit.evidenceAsOf");
    collector.timestamp(manifest.audit.verifiedAt, "$.audit.verifiedAt", { nullable: true });
    collector.timestamp(manifest.audit.nextDueAt, "$.audit.nextDueAt", { nullable: true });
    collector.number(manifest.audit.staleAfterSeconds, "$.audit.staleAfterSeconds", { min: 1, integer: true });
  }

  if (collector.array(manifest.phases, "$.phases", { min: 1 })) {
    manifest.phases.forEach((phase, index) => validatePhase(collector, phase, `$.phases[${index}]`));
  }
  if (collector.array(manifest.evidence, "$.evidence")) {
    manifest.evidence.forEach((evidence, index) => validateEvidence(collector, evidence, `$.evidence[${index}]`));
  }
  if (collector.array(manifest.gates, "$.gates")) {
    manifest.gates.forEach((gate, index) => validateGate(collector, gate, `$.gates[${index}]`));
  }
  if (collector.array(manifest.dependencies, "$.dependencies")) {
    manifest.dependencies.forEach((dependency, index) => validateDependency(collector, dependency, `$.dependencies[${index}]`));
  }
}

export class ManifestValidationError extends Error {
  constructor(errors) {
    super(`Manifest validation failed with ${errors.length} error(s)`);
    this.name = "ManifestValidationError";
    this.errors = errors;
  }
}

/** Validate strict shape and cross-record semantics without mutating the input. */
export function validateManifest(manifest, options = {}) {
  const allowedOptions = new Set(["throwOnError", "now", "clock"]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) throw new TypeError(`Unknown validateManifest option: ${key}`);
  }
  const collector = new Collector();
  structuralValidation(collector, manifest);
  semanticValidation(collector, manifest, options);
  const result = Object.freeze({
    valid: collector.errors.length === 0,
    errors: Object.freeze(collector.errors.map((error) => Object.freeze(error))),
  });
  if (!result.valid && options.throwOnError) throw new ManifestValidationError(result.errors);
  return result;
}
