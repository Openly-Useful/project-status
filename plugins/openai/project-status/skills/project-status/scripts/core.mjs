import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The portable archive cannot import ../../packages/core. Its bundled JSON
// Schema is therefore the structural source of truth, with the same semantic
// checks vendored below. tests/skill-cli.test.mjs guards parity with core.
export const MANIFEST_SCHEMA = Object.freeze(JSON.parse(readFileSync(
  fileURLToPath(new URL("../assets/manifest.schema.json", import.meta.url)),
  "utf8",
)));

const EVIDENCE_TIER_RANK = Object.freeze({
  assertion: 1,
  prepared: 2,
  validated_local: 3,
  public_reproducible: 4,
  direct: 5,
});
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET_QUERY_RE = /(?:^|_)(?:access|api|auth|credential|key|password|secret|signature|token)(?:$|_)/i;
const EPSILON = 1e-9;
const SKIP_DIRECTORIES = new Set([
  ".agent-skills",
  ".agents",
  ".claude",
  ".git",
  ".next",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function close(first, second) {
  return Math.abs(first - second) <= EPSILON;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function sortedValue(value, stack = new WeakSet(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite JSON number`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} contains a non-JSON ${typeof value} value`);
  if (stack.has(value)) throw new TypeError(`${path} contains a circular reference`);
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => {
      if (!(index in value)) throw new TypeError(`${path}[${index}] is a sparse array entry`);
      return sortedValue(item, stack, `${path}[${index}]`);
    });
  } else {
    if (!isRecord(value)) throw new TypeError(`${path} must be a plain JSON object`);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${path} contains symbol keys`);
    result = Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key], stack, `${path}.${key}`)]));
  }
  stack.delete(value);
  return result;
}

export function stableStringify(value, space = 0) {
  return JSON.stringify(sortedValue(value), null, space);
}

export function canonicalize(value) {
  return stableStringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function manifestDigest(manifest) {
  return sha256(manifest);
}

export function validTimestamp(value) {
  return typeof value === "string"
    && ISO_PATTERN.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function toInstant(value, label = "time") {
  const candidate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(candidate.getTime())) throw new TypeError(`${label} must resolve to a valid instant`);
  return candidate;
}

function resolveClock(options = {}) {
  if (options.clock !== undefined && typeof options.clock !== "function") {
    throw new TypeError("options.clock must be a function");
  }
  const supplied = options.clock ? options.clock() : options.now;
  return toInstant(supplied ?? Date.now(), "clock");
}

export function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.split("/").some((part) => part === ".." || part === "");
}

export function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function walkForManifests(root, maxDepth = 6) {
  const matches = [];
  const visit = (directory, depth) => {
    if (depth > maxDepth) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === "status-manifest.json") matches.push(full);
      if (entry.name === "manifest.json" && [".project-status", "status"].includes(basename(dirname(full)))) matches.push(full);
    }
  };
  visit(root, 0);
  return [...new Set(matches.map((path) => resolve(path)))].sort();
}

export function findManifest(target) {
  const candidate = resolve(target);
  if (!existsSync(candidate)) throw new Error(`Target does not exist: ${candidate}`);
  if (statSync(candidate).isFile()) return candidate;
  if (!statSync(candidate).isDirectory()) throw new Error(`Target is not a file or directory: ${candidate}`);
  const preferred = [
    join(candidate, ".project-status", "manifest.json"),
    join(candidate, "status", "manifest.json"),
    join(candidate, "status-manifest.json"),
  ].filter(existsSync).map((path) => resolve(path));
  const matches = [...new Set([...preferred, ...walkForManifests(candidate)])].sort();
  if (matches.length === 0) throw new Error(`No project-status manifest found under ${candidate}`);
  if (matches.length > 1) throw new Error(`Multiple project-status manifests found:\n${matches.map((path) => `- ${path}`).join("\n")}`);
  return matches[0];
}

export function readManifest(target) {
  const targetPath = resolve(target);
  const path = findManifest(targetPath);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let root = targetPath;
  if (!statSync(targetPath).isDirectory()) {
    root = [".project-status", "status"].includes(basename(dirname(path))) ? dirname(dirname(path)) : dirname(path);
  }
  return { path, manifest, root };
}

class Collector {
  errors = [];

  add(code, path, message) {
    this.errors.push({ code, path, message });
  }
}

function schemaRef(root, reference) {
  if (!reference.startsWith("#/")) throw new Error(`Unsupported schema reference: ${reference}`);
  return reference.slice(2).split("/").reduce((value, part) => value[part.replaceAll("~1", "/").replaceAll("~0", "~")], root);
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "object") return isRecord(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return finite(value);
  return typeof value === type;
}

function validateSchema(value, schema, path, root, collector) {
  if (schema.$ref) {
    validateSchema(value, schemaRef(root, schema.$ref), path, root, collector);
    return;
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    const attempts = alternatives.map((candidate) => {
      const trial = new Collector();
      validateSchema(value, candidate, path, root, trial);
      return trial.errors;
    });
    const passing = attempts.filter((errors) => errors.length === 0);
    if ((schema.anyOf && passing.length === 0) || (schema.oneOf && passing.length !== 1)) {
      const best = attempts.slice().sort((first, second) => first.length - second.length)[0];
      if (best.length > 0) collector.errors.push(...best);
      else collector.add("schema_alternative_mismatch", path, schema.oneOf ? "must match exactly one allowed shape" : "must match an allowed shape");
    }
    return;
  }
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) {
    collector.add(path === "$.schemaVersion" ? "unsupported_schema_version" : "invalid_const", path, `must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    collector.add("invalid_enum", path, `must be one of: ${schema.enum.join(", ")}`);
    return;
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    collector.add(`expected_${schema.type}`, path, `must be ${schema.type === "object" ? "a plain object" : `a${/^[aeiou]/.test(schema.type) ? "n" : ""} ${schema.type}`}`);
    return;
  }
  if (schema.type === "string") {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) collector.add("empty_string", path, "must not be empty");
    if (schema.pattern && !(new RegExp(schema.pattern)).test(value)) collector.add(path === "$.route" ? "invalid_route" : "invalid_format", path, "has an invalid format");
    if (schema.format === "date-time" && !validTimestamp(value)) collector.add("invalid_timestamp", path, "must be an exact UTC ISO-8601 timestamp with milliseconds");
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (schema.minimum !== undefined && value < schema.minimum) collector.add("number_out_of_range", path, `must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) collector.add("number_out_of_range", path, `must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) collector.add("number_out_of_range", path, `must be greater than ${schema.exclusiveMinimum}`);
  }
  if (schema.type === "array") {
    if (schema.minItems !== undefined && value.length < schema.minItems) collector.add("array_too_short", path, `must contain at least ${schema.minItems} item(s)`);
    if (schema.uniqueItems) {
      const seen = new Set();
      value.forEach((item, index) => {
        const key = stableStringify(item);
        if (seen.has(key)) collector.add("duplicate_item", `${path}[${index}]`, "duplicates an earlier item");
        seen.add(key);
      });
    }
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`, root, collector));
  }
  if (schema.type === "object") {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) collector.add("missing_property", `${path}.${key}`, "is required");
    }
    for (const key of Object.keys(value)) {
      if (schema.properties?.[key]) validateSchema(value[key], schema.properties[key], `${path}.${key}`, root, collector);
      else if (schema.additionalProperties === false) collector.add("unknown_property", `${path}.${key}`, "is not allowed");
      else if (isRecord(schema.additionalProperties)) validateSchema(value[key], schema.additionalProperties, `${path}.${key}`, root, collector);
    }
  }
}

function instant(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;
}

function addUnique(collector, map, id, path, kind) {
  if (typeof id !== "string") return;
  if (map.has(id)) collector.add("duplicate_id", path, `${kind} id ${id} is duplicated`);
  else map.set(id, path);
}

function validateRangeOrder(collector, range, path) {
  if (isRecord(range) && finite(range.min) && finite(range.max) && range.max < range.min) {
    collector.add("invalid_range", path, "max must be greater than or equal to min");
  }
}

function validateRoute(collector, route) {
  if (typeof route !== "string") return;
  if (!route.startsWith("/") || route.startsWith("//") || /[?#\\\\\u0000-\u001f\u007f]/.test(route)) {
    collector.add("invalid_route", "$.route", "must be an absolute URL path without authority, query, fragment, backslash, or control characters");
    return;
  }
  try {
    if (route.split("/").some((segment) => [".", ".."].includes(decodeURIComponent(segment).toLowerCase()))) {
      collector.add("invalid_route", "$.route", "must not contain traversal segments");
    }
  } catch {
    collector.add("invalid_route", "$.route", "must contain valid percent encoding");
  }
}

function validateHttpsUrl(collector, value, path) {
  if (value === null || typeof value !== "string") return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("unsafe URL");
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_QUERY_RE.test(key)) throw new Error("secret query");
    }
  } catch {
    collector.add("invalid_url", path, "must be an absolute HTTPS URL without credentials or secret-like query parameters");
  }
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
      collector.add("dependency_cycle", "$.dependencies", `contains a cycle: ${[...stack.slice(start), id].join(" -> ")}`);
      return true;
    }
    if (visited.has(id)) return false;
    visiting.add(id);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) if (walk(next)) return true;
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const id of [...taskIds].sort()) if (walk(id)) break;
}

function semanticValidation(collector, manifest, options) {
  if (!isRecord(manifest)) return;
  validateRoute(collector, manifest.route);

  const phaseIds = new Map();
  const tasks = new Map();
  let phaseWeight = 0;
  for (const [phaseIndex, phase] of (Array.isArray(manifest.phases) ? manifest.phases : []).entries()) {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) continue;
    addUnique(collector, phaseIds, phase.id, `$.phases[${phaseIndex}].id`, "phase");
    let taskWeight = 0;
    for (const [taskIndex, task] of phase.tasks.entries()) {
      if (!isRecord(task)) continue;
      const path = `$.phases[${phaseIndex}].tasks[${taskIndex}]`;
      addUnique(collector, tasks, task.id, `${path}.id`, "task");
      if (finite(task.weight)) taskWeight += task.weight;
      validateRangeOrder(collector, task.remainingHours, `${path}.remainingHours`);
      if (finite(task.weight) && finite(task.earnedWeight) && task.earnedWeight > task.weight + EPSILON) {
        collector.add("earned_exceeds_weight", `${path}.earnedWeight`, "must not exceed task weight");
      }
      if (task.status === "complete" && finite(task.weight) && finite(task.earnedWeight) && !close(task.earnedWeight, task.weight)) {
        collector.add("invalid_credit", `${path}.earnedWeight`, "complete tasks must earn full weight");
      }
      if (["blocked", "not_started"].includes(task.status) && finite(task.earnedWeight) && !close(task.earnedWeight, 0)) {
        collector.add("invalid_credit", `${path}.earnedWeight`, `${task.status} tasks must earn zero`);
      }
      if (task.status === "complete") {
        if (!isRecord(task.remainingHours) || !close(task.remainingHours.min, 0) || !close(task.remainingHours.max, 0)) {
          collector.add("invalid_remaining_hours", `${path}.remainingHours`, "complete tasks must have a 0–0 range");
        }
        if (task.nextAction !== null) collector.add("invalid_next_action", `${path}.nextAction`, "complete tasks must use null");
      } else if (typeof task.nextAction !== "string" || task.nextAction.trim() === "") {
        collector.add("missing_next_action", `${path}.nextAction`, "unfinished tasks require a concrete next action");
      }
    }
    if (finite(phase.weight) && !close(taskWeight, phase.weight)) {
      collector.add("phase_weight_mismatch", `$.phases[${phaseIndex}].tasks`, `task weights ${taskWeight} do not equal phase weight ${phase.weight}`);
    }
    if (finite(phase.weight)) phaseWeight += phase.weight;
  }
  if (finite(manifest.totalWeight) && !close(phaseWeight, manifest.totalWeight)) {
    collector.add("total_weight_mismatch", "$.phases", `phase weights ${phaseWeight} do not equal total weight ${manifest.totalWeight}`);
  }

  const evidence = new Map();
  for (const [index, item] of (Array.isArray(manifest.evidence) ? manifest.evidence : []).entries()) {
    if (!isRecord(item)) continue;
    addUnique(collector, evidence, item.id, `$.evidence[${index}].id`, "evidence");
    const captured = instant(item.capturedAt);
    const verified = instant(item.verifiedAt);
    const expires = instant(item.expiresAt);
    if (captured !== null && verified !== null && verified < captured) collector.add("invalid_time_order", `$.evidence[${index}].verifiedAt`, "must not precede capturedAt");
    if (captured !== null && expires !== null && expires <= captured) collector.add("invalid_time_order", `$.evidence[${index}].expiresAt`, "must follow capturedAt");
    if (item.locator?.type === "url") validateHttpsUrl(collector, item.locator.url, `$.evidence[${index}].locator.url`);
    if (item.locator?.type === "commit") validateHttpsUrl(collector, item.locator.repository, `$.evidence[${index}].locator.repository`);
  }

  const gates = new Map();
  for (const [index, gate] of (Array.isArray(manifest.gates) ? manifest.gates : []).entries()) {
    if (!isRecord(gate)) continue;
    addUnique(collector, gates, gate.id, `$.gates[${index}].id`, "gate");
    validateRangeOrder(collector, gate.wait, `$.gates[${index}].wait`);
    if (["unsatisfied", "waiting"].includes(gate.status) && (typeof gate.nextAction !== "string" || gate.nextAction.trim() === "")) {
      collector.add("missing_next_action", `$.gates[${index}].nextAction`, "uncleared gates require a concrete next action");
    }
    if (["satisfied", "waived"].includes(gate.status) && gate.nextAction !== null) {
      collector.add("invalid_next_action", `$.gates[${index}].nextAction`, "cleared gates must use null");
    }
  }

  const auditAsOf = instant(manifest.audit?.evidenceAsOf);
  for (const [taskId, taskPath] of tasks) {
    const [phaseIndex, taskIndex] = taskPath.match(/\d+/g)?.map(Number) ?? [];
    const task = manifest.phases?.[phaseIndex]?.tasks?.[taskIndex];
    if (!task) continue;
    const evidenceRefs = Array.isArray(task.evidenceRefs) ? task.evidenceRefs : [];
    const gateRefs = Array.isArray(task.gateRefs) ? task.gateRefs : [];
    for (const [index, evidenceId] of evidenceRefs.entries()) {
      if (!evidence.has(evidenceId)) collector.add("dangling_evidence_ref", `${taskPath}.evidenceRefs[${index}]`, `unknown evidence id ${evidenceId}`);
    }
    for (const [index, gateId] of gateRefs.entries()) {
      if (!gates.has(gateId)) collector.add("dangling_gate_ref", `${taskPath}.gateRefs[${index}]`, `unknown gate id ${gateId}`);
    }
    if (finite(task.earnedWeight) && task.earnedWeight > 0 && isRecord(task.evidenceRequirement)) {
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
        collector.add("insufficient_evidence", `${taskPath}.evidenceRefs`, `earned credit requires ${task.evidenceRequirement.minCount} current ${task.evidenceRequirement.minimumTier}-or-better evidence record(s)`);
      }
    }
    for (const gateId of gateRefs) {
      const gatePath = gates.get(gateId);
      if (!gatePath) continue;
      const gateIndex = Number(gatePath.match(/\d+/)?.[0]);
      const gate = manifest.gates[gateIndex];
      const reciprocalTaskRefs = Array.isArray(gate.taskRefs) ? gate.taskRefs : [];
      if (!reciprocalTaskRefs.includes(taskId)) collector.add("gate_reference_mismatch", `${taskPath}.gateRefs`, `${gateId} does not reciprocally reference ${taskId}`);
      if (["unsatisfied", "waiting"].includes(gate.status) && task.earnedWeight > 0) collector.add("credit_behind_gate", `${taskPath}.earnedWeight`, `must be zero while gate ${gateId} is uncleared`);
    }
  }

  for (const [gateIndex, gate] of (Array.isArray(manifest.gates) ? manifest.gates : []).entries()) {
    if (!isRecord(gate)) continue;
    const taskRefs = Array.isArray(gate.taskRefs) ? gate.taskRefs : [];
    for (const [index, taskId] of taskRefs.entries()) {
      const taskPath = tasks.get(taskId);
      if (!taskPath) collector.add("dangling_task_ref", `$.gates[${gateIndex}].taskRefs[${index}]`, `unknown task id ${taskId}`);
      else {
        const [phaseIndex, taskIndex] = taskPath.match(/\d+/g)?.map(Number) ?? [];
        const reciprocalGateRefs = manifest.phases[phaseIndex].tasks[taskIndex].gateRefs;
        if (!(Array.isArray(reciprocalGateRefs) ? reciprocalGateRefs : []).includes(gate.id)) collector.add("gate_reference_mismatch", `$.gates[${gateIndex}].taskRefs`, `${taskId} does not reciprocally reference ${gate.id}`);
      }
    }
  }

  const dependencyIds = new Map();
  const edgeKeys = new Set();
  const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
  for (const [index, dependency] of dependencies.entries()) {
    if (!isRecord(dependency)) continue;
    addUnique(collector, dependencyIds, dependency.id, `$.dependencies[${index}].id`, "dependency");
    if (!tasks.has(dependency.prerequisiteTaskId)) collector.add("dangling_dependency_ref", `$.dependencies[${index}].prerequisiteTaskId`, `unknown task id ${dependency.prerequisiteTaskId}`);
    if (!tasks.has(dependency.dependentTaskId)) collector.add("dangling_dependency_ref", `$.dependencies[${index}].dependentTaskId`, `unknown task id ${dependency.dependentTaskId}`);
    if (dependency.prerequisiteTaskId === dependency.dependentTaskId) collector.add("self_dependency", `$.dependencies[${index}]`, "a task cannot depend on itself");
    const edgeKey = `${dependency.type}:${dependency.prerequisiteTaskId}:${dependency.dependentTaskId}`;
    if (edgeKeys.has(edgeKey)) collector.add("duplicate_dependency", `$.dependencies[${index}]`, "duplicates an existing dependency edge");
    edgeKeys.add(edgeKey);
  }
  detectCycles(collector, new Set(tasks.keys()), dependencies.filter(isRecord));

  const evidenceAsOf = instant(manifest.audit?.evidenceAsOf);
  const verifiedAt = instant(manifest.audit?.verifiedAt);
  const nextDueAt = instant(manifest.audit?.nextDueAt);
  if (evidenceAsOf !== null && verifiedAt !== null && verifiedAt < evidenceAsOf) collector.add("invalid_time_order", "$.audit.verifiedAt", "must not precede evidenceAsOf");
  const auditBaseline = verifiedAt ?? evidenceAsOf;
  if (auditBaseline !== null && nextDueAt !== null && nextDueAt <= auditBaseline) collector.add("invalid_time_order", "$.audit.nextDueAt", "must follow the latest audit timestamp");

  validateHttpsUrl(collector, manifest.source?.repository, "$.source.repository");
  if (manifest.source?.commit !== null && manifest.source?.repository === null) collector.add("incomplete_provenance", "$.source.repository", "is required when commit is present");
  if ([manifest.source?.deploymentId, manifest.source?.buildId, manifest.source?.manifestSha256].some((value) => value !== null) && manifest.source?.commit === null) {
    collector.add("incomplete_provenance", "$.source.commit", "is required when build or deployment provenance is present");
  }

  if (options.now !== undefined || options.clock !== undefined) {
    const now = resolveClock(options).getTime();
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

export class ManifestValidationError extends Error {
  constructor(errors) {
    super(`Manifest validation failed with ${errors.length} error(s)`);
    this.name = "ManifestValidationError";
    this.errors = errors;
  }
}

function runValidation(manifest, options = {}) {
  const collector = new Collector();
  validateSchema(manifest, MANIFEST_SCHEMA, "$", MANIFEST_SCHEMA, collector);
  semanticValidation(collector, manifest, options);
  return Object.freeze({
    valid: collector.errors.length === 0,
    errors: Object.freeze(collector.errors.map((error) => Object.freeze(error))),
  });
}

function taskRecords(manifest) {
  return manifest.phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phaseId: phase.id })));
}

function topologicalOrderUnchecked(manifest) {
  const ids = taskRecords(manifest).map((task) => task.id).sort();
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const dependency of manifest.dependencies) {
    outgoing.get(dependency.prerequisiteTaskId).push(dependency.dependentTaskId);
    incoming.set(dependency.dependentTaskId, incoming.get(dependency.dependentTaskId) + 1);
  }
  for (const values of outgoing.values()) values.sort();
  const ready = ids.filter((id) => incoming.get(id) === 0);
  const ordered = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(id);
    for (const dependent of outgoing.get(id)) {
      incoming.set(dependent, incoming.get(dependent) - 1);
      if (incoming.get(dependent) === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  return Object.freeze(ordered);
}

function lexicographicPath(first, second) {
  const firstKey = first.join("\u0000");
  const secondKey = second.join("\u0000");
  if (firstKey < secondKey) return -1;
  if (firstKey > secondKey) return 1;
  return 0;
}

function criticalPathUnchecked(manifest) {
  const ordered = [...topologicalOrderUnchecked(manifest)];
  const tasks = new Map(taskRecords(manifest).map((task) => [task.id, task]));
  const activeIds = ordered.filter((id) => tasks.get(id).status !== "complete" && !tasks.get(id).deferred);
  const missingEstimateTaskIds = activeIds.filter((id) => tasks.get(id).remainingHours === null);
  if (missingEstimateTaskIds.length > 0) {
    return Object.freeze({ determinate: false, reason: "missing_estimates", path: Object.freeze([]), durationHours: null, missingEstimateTaskIds: Object.freeze(missingEstimateTaskIds), topologicalOrder: Object.freeze(ordered) });
  }
  if (activeIds.length === 0) {
    return Object.freeze({ determinate: true, reason: null, path: Object.freeze([]), durationHours: Object.freeze({ min: 0, max: 0 }), missingEstimateTaskIds: Object.freeze([]), topologicalOrder: Object.freeze(ordered) });
  }
  const active = new Set(activeIds);
  const prerequisites = new Map(activeIds.map((id) => [id, []]));
  for (const dependency of manifest.dependencies) {
    if (dependency.type === "blocks" && active.has(dependency.prerequisiteTaskId) && active.has(dependency.dependentTaskId)) prerequisites.get(dependency.dependentTaskId).push(dependency.prerequisiteTaskId);
  }
  for (const values of prerequisites.values()) values.sort();
  const best = new Map();
  for (const id of ordered.filter((candidate) => active.has(candidate))) {
    const task = tasks.get(id);
    const candidates = prerequisites.get(id).map((prerequisite) => best.get(prerequisite));
    candidates.sort((first, second) => second.max - first.max || lexicographicPath(first.path, second.path));
    const previous = candidates[0] ?? { min: 0, max: 0, path: [] };
    best.set(id, { min: previous.min + task.remainingHours.min, max: previous.max + task.remainingHours.max, path: [...previous.path, id] });
  }
  const selected = [...best.values()].sort((first, second) => second.max - first.max || lexicographicPath(first.path, second.path))[0];
  return Object.freeze({ determinate: true, reason: null, path: Object.freeze(selected.path), durationHours: Object.freeze({ min: selected.min, max: selected.max }), missingEstimateTaskIds: Object.freeze([]), topologicalOrder: Object.freeze(ordered) });
}

function calculateStatusUnchecked(manifest, options = {}) {
  const now = resolveClock(options);
  const nowMs = now.getTime();
  const tasks = taskRecords(manifest);
  const evidenceById = new Map(manifest.evidence.map((item) => [item.id, item]));
  const credit = (task) => task.status === "complete" ? task.weight : task.status === "in_progress" ? task.earnedWeight : 0;
  const phases = manifest.phases.map((phase) => {
    const earnedWeight = phase.tasks.reduce((sum, task) => sum + credit(task), 0);
    return Object.freeze({ id: phase.id, weight: phase.weight, earnedWeight, exactPercent: (earnedWeight / phase.weight) * 100, displayPercent: Math.round((earnedWeight / phase.weight) * 100), taskCount: phase.tasks.length, completedTaskCount: phase.tasks.filter((task) => task.status === "complete").length });
  });
  const earnedWeight = phases.reduce((sum, phase) => sum + phase.earnedWeight, 0);
  const evidenceSupportingCredit = new Set(tasks.filter((task) => credit(task) > 0).flatMap((task) => task.evidenceRefs));
  const evidenceIsCurrent = (item) => item.state === "current" && (item.expiresAt === null || Date.parse(item.expiresAt) > nowMs);
  const invalidEvidenceIds = [...evidenceSupportingCredit].filter((id) => !evidenceIsCurrent(evidenceById.get(id))).sort();
  const expiredEvidenceIds = [...evidenceSupportingCredit].filter((id) => {
    const item = evidenceById.get(id);
    return item.expiresAt !== null && Date.parse(item.expiresAt) <= nowMs;
  }).sort();
  const baseline = manifest.audit.verifiedAt ?? manifest.audit.evidenceAsOf;
  const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(baseline)) / 1000));
  const auditIsStale = manifest.audit.nextDueAt !== null ? nowMs > Date.parse(manifest.audit.nextDueAt) : ageSeconds > manifest.audit.staleAfterSeconds;
  let verificationState = "current";
  if (manifest.audit.state === "proposal") verificationState = "proposal";
  else if (invalidEvidenceIds.length > 0) verificationState = "stale_evidence";
  else if (auditIsStale || manifest.audit.state === "stale") verificationState = "stale_audit";
  else if (manifest.audit.state === "superseded") verificationState = "superseded";
  const timeSummary = tasks.reduce((summary, task) => {
    if (task.remainingHours === null) {
      if (task.status !== "complete") summary.unknownEstimateTaskIds.push(task.id);
      return summary;
    }
    const bucket = task.deferred ? summary.deferred : summary.active;
    bucket.min += task.remainingHours.min;
    bucket.max += task.remainingHours.max;
    return summary;
  }, { active: { min: 0, max: 0 }, deferred: { min: 0, max: 0 }, unknownEstimateTaskIds: [] });
  const gateSummary = {
    satisfied: manifest.gates.filter((gate) => gate.status === "satisfied").length,
    unsatisfied: manifest.gates.filter((gate) => gate.status === "unsatisfied").length,
    waiting: manifest.gates.filter((gate) => gate.status === "waiting").length,
    waived: manifest.gates.filter((gate) => gate.status === "waived").length,
  };
  return Object.freeze({
    asOf: now.toISOString(),
    score: Object.freeze({ earnedWeight, totalWeight: manifest.totalWeight, exactPercent: (earnedWeight / manifest.totalWeight) * 100, displayPercent: Math.round((earnedWeight / manifest.totalWeight) * 100) }),
    phases: Object.freeze(phases),
    tasks: Object.freeze({ total: tasks.length, complete: tasks.filter((task) => task.status === "complete").length, inProgress: tasks.filter((task) => task.status === "in_progress").length, blocked: tasks.filter((task) => task.status === "blocked").length, notStarted: tasks.filter((task) => task.status === "not_started").length }),
    evidence: Object.freeze({ total: manifest.evidence.length, supportingCredit: evidenceSupportingCredit.size, invalidEvidenceIds: Object.freeze(invalidEvidenceIds), expiredEvidenceIds: Object.freeze(expiredEvidenceIds), highestTier: manifest.evidence.reduce((best, item) => EVIDENCE_TIER_RANK[item.tier] > EVIDENCE_TIER_RANK[best] ? item.tier : best, "assertion") }),
    audit: Object.freeze({ state: manifest.audit.state, verificationState, ageSeconds, staleAfterSeconds: manifest.audit.staleAfterSeconds, isStale: auditIsStale, nextDueAt: manifest.audit.nextDueAt }),
    time: Object.freeze({ active: Object.freeze(timeSummary.active), deferred: Object.freeze(timeSummary.deferred), unknownEstimateTaskIds: Object.freeze(timeSummary.unknownEstimateTaskIds.sort()) }),
    gates: Object.freeze(gateSummary),
    criticalPath: criticalPathUnchecked(manifest),
  });
}

function summaryForCli(manifest, status) {
  const tasks = taskRecords(manifest);
  return {
    ...status,
    project: manifest.initiative.name,
    readinessQuestion: `Delivery readiness for ${manifest.initiative.release}`,
    statusState: manifest.initiative.state,
    route: manifest.route,
    totalWeight: status.score.totalWeight,
    earnedWeight: status.score.earnedWeight,
    exactCompletion: status.score.exactPercent,
    displayedCompletion: status.score.displayPercent,
    phases: status.phases.map((phaseStatus) => ({
      ...phaseStatus,
      name: manifest.phases.find((phase) => phase.id === phaseStatus.id).name,
      summary: manifest.phases.find((phase) => phase.id === phaseStatus.id).summary,
      completion: phaseStatus.exactPercent,
    })),
    activeHandsOnRemaining: status.time.active,
    soakTime: null,
    deferredExpansion: status.time.deferred,
    blockers: tasks.filter((task) => task.status === "blocked").map((task) => ({ id: task.id, name: task.name, reason: task.summary, nextAction: task.nextAction })),
    externalGates: manifest.gates.filter((gate) => gate.type === "external_approval" && ["unsatisfied", "waiting"].includes(gate.status)),
    recurringTaskCount: tasks.filter((task) => task.recurring && task.status !== "complete").length,
    updatedAt: manifest.audit.evidenceAsOf,
    lastVerifiedAt: manifest.audit.verifiedAt,
    auditAgeHours: status.audit.ageSeconds / 3600,
    stale: status.audit.isStale,
  };
}

function assertOptions(options, allowed) {
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(`Unknown option: ${key}`);
}

export function validateManifest(manifest, options = {}) {
  assertOptions(options, new Set(["throwOnError", "now", "clock"]));
  const baseline = runValidation(manifest);
  let result = baseline;
  let now = null;
  if (baseline.valid) {
    now = resolveClock(options);
    if (options.now !== undefined || options.clock !== undefined) result = runValidation(manifest, { now });
  }
  const digest = (() => { try { return manifestDigest(manifest); } catch { return null; } })();
  let summary = null;
  const warnings = [];
  if (result.valid) {
    const status = calculateStatusUnchecked(manifest, { now });
    summary = summaryForCli(manifest, status);
    if (manifest.audit.state === "proposal") warnings.push("Manifest freshness is proposal-based; no live evidence check was performed.");
    else if (status.audit.isStale) warnings.push("Manifest freshness is stale at the selected clock; this is not a live service check.");
  }
  const output = Object.freeze({ valid: result.valid, errors: result.errors, warnings: Object.freeze(warnings), summary, manifestDigest: digest });
  if (!result.valid && options.throwOnError) throw new ManifestValidationError(result.errors);
  return output;
}

export function calculateStatus(manifest, options = {}) {
  assertOptions(options, new Set(["now", "clock"]));
  let validation = runValidation(manifest);
  if (!validation.valid) throw new ManifestValidationError(validation.errors);
  const now = resolveClock(options);
  if (options.now !== undefined || options.clock !== undefined) validation = runValidation(manifest, { now });
  if (!validation.valid) throw new ManifestValidationError(validation.errors);
  return calculateStatusUnchecked(manifest, { now });
}

export function topologicalOrder(manifest) {
  const validation = runValidation(manifest);
  if (!validation.valid) throw new ManifestValidationError(validation.errors);
  return topologicalOrderUnchecked(manifest);
}

export function criticalPath(manifest) {
  const validation = runValidation(manifest);
  if (!validation.valid) throw new ManifestValidationError(validation.errors);
  return criticalPathUnchecked(manifest);
}

function publicOwner(owner) {
  return { type: owner.type, label: owner.label };
}

function publicLocator(evidence) {
  if (evidence.visibility !== "public") return undefined;
  if (["url", "commit", "artifact"].includes(evidence.locator.type)) return { ...evidence.locator };
  return undefined;
}

function publicEvidence(evidence) {
  const projected = {
    id: evidence.id,
    kind: evidence.kind,
    tier: evidence.tier,
    state: evidence.state,
    visibility: evidence.visibility,
    summary: evidence.visibility === "public" ? evidence.assertion : evidence.publicSummary,
    capturedAt: evidence.capturedAt,
    verifiedAt: evidence.verifiedAt,
    expiresAt: evidence.expiresAt,
    verifier: { type: evidence.verifier.type, label: evidence.verifier.label },
  };
  if (evidence.visibility === "public") projected.integrity = evidence.integrity;
  const locator = publicLocator(evidence);
  if (locator !== undefined) projected.locator = locator;
  return projected;
}

function manifestStaleAt(manifest) {
  if (manifest.audit.nextDueAt !== null) return manifest.audit.nextDueAt;
  const baseline = manifest.audit.verifiedAt ?? manifest.audit.evidenceAsOf;
  return new Date(Date.parse(baseline) + manifest.audit.staleAfterSeconds * 1000).toISOString();
}

export function createPublicProjection(manifest, validationOrOptions = {}, maybeOptions = {}) {
  const options = validationOrOptions && Array.isArray(validationOrOptions.errors) && Object.hasOwn(validationOrOptions, "summary") ? maybeOptions : validationOrOptions;
  assertOptions(options, new Set(["now", "clock"]));
  const status = calculateStatus(manifest, options);
  const canonicalManifestSha256 = manifestDigest(manifest);
  const tasks = manifest.phases.flatMap((phase) => phase.tasks);
  const blockers = tasks.filter((task) => task.status === "blocked").map((task) => ({ id: task.id, name: task.name, summary: task.summary, nextAction: task.nextAction }));
  const externalGates = manifest.gates.filter((gate) => gate.type === "external_approval" && ["unsatisfied", "waiting"].includes(gate.status)).map((gate) => ({ id: gate.id, name: gate.name, status: gate.status, reason: gate.reason, wait: gate.wait, nextAction: gate.nextAction }));
  const staleAt = manifestStaleAt(manifest);
  return {
    schemaVersion: manifest.schemaVersion,
    route: manifest.route,
    initiative: { ...manifest.initiative },
    project: manifest.initiative.name,
    readinessQuestion: `Delivery readiness for ${manifest.initiative.release}`,
    statusState: manifest.initiative.state,
    source: { ...manifest.source },
    provenance: { canonicalManifestSha256, auditId: manifest.audit.auditId },
    manifestDigest: canonicalManifestSha256,
    audit: { ...manifest.audit, asOf: status.asOf, verificationState: status.audit.verificationState, staleAt },
    manifestFreshness: { basis: "manifest_snapshot", state: status.audit.verificationState, asOf: status.asOf, evidenceAsOf: manifest.audit.evidenceAsOf, verifiedAt: manifest.audit.verifiedAt, staleAt, ageSeconds: status.audit.ageSeconds, isStale: status.audit.isStale },
    score: { ...status.score },
    readiness: { exact: status.score.exactPercent, displayed: status.score.displayPercent, denominator: status.score.totalWeight },
    phases: manifest.phases.map((phase) => {
      const phaseStatus = status.phases.find((item) => item.id === phase.id);
      return {
        id: phase.id,
        name: phase.name,
        summary: phase.summary,
        weight: phase.weight,
        score: phaseStatus,
        earnedWeight: phaseStatus.earnedWeight,
        completion: phaseStatus.exactPercent,
        tasks: phase.tasks.map((task) => ({ id: task.id, name: task.name, summary: task.summary, status: task.status, weight: task.weight, earnedWeight: task.earnedWeight, remainingHours: task.remainingHours, recurring: task.recurring, deferred: task.deferred, owner: publicOwner(task.owner), nextAction: task.nextAction, evidenceRequirement: { ...task.evidenceRequirement }, evidenceRefs: [...task.evidenceRefs], gateRefs: [...task.gateRefs] })),
      };
    }),
    evidence: manifest.evidence.map(publicEvidence),
    gates: manifest.gates.map((gate) => ({ id: gate.id, name: gate.name, type: gate.type, status: gate.status, reason: gate.reason, owner: publicOwner(gate.owner), nextAction: gate.nextAction, wait: gate.wait === null ? null : { ...gate.wait }, taskRefs: [...gate.taskRefs] })),
    dependencies: manifest.dependencies.map((dependency) => ({ ...dependency })),
    effort: { active: { ...status.time.active }, soak: null, deferred: { ...status.time.deferred } },
    blockers,
    externalGates,
    recurringTaskCount: tasks.filter((task) => task.recurring && task.status !== "complete").length,
    liveHealth: { state: "unknown", observedAt: null },
    summaries: {
      tasks: { ...status.tasks },
      evidence: { ...status.evidence },
      gates: { ...status.gates },
      time: { active: { ...status.time.active }, deferred: { ...status.time.deferred }, unknownEstimateTaskIds: [...status.time.unknownEstimateTaskIds] },
      criticalPath: { ...status.criticalPath, path: [...status.criticalPath.path], missingEstimateTaskIds: [...status.criticalPath.missingEstimateTaskIds], topologicalOrder: [...status.criticalPath.topologicalOrder] },
    },
  };
}

export function resolveProjectFile(projectRoot, locator) {
  if (!safeRelativePath(locator)) throw new Error("Evidence locator is not a safe relative path");
  const root = realpathSync(resolve(projectRoot));
  const candidate = resolve(root, locator);
  if (!isWithin(root, candidate)) throw new Error("Evidence locator escapes the project root");
  if (existsSync(candidate)) {
    const real = realpathSync(candidate);
    if (!isWithin(root, real)) throw new Error("Evidence symlink escapes the project root");
    if (lstatSync(candidate).isSymbolicLink() && !isWithin(root, real)) throw new Error("Evidence symlink escapes the project root");
  }
  return candidate;
}
