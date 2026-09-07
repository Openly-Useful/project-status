// Dependency-free: release-sync bundles this exact implementation with the skill.
// Stage scopes reference existing tasks, never a second progress ledger.
const id = { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" };
const refs = { type: "array", uniqueItems: true, items: id };
const text = { type: "string", minLength: 1 };
const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
export const DELIVERY_SCHEMA = object({
  schemaVersion: { const: 1 }, activeStage: id,
  nextMilestoneId: { anyOf: [id, { type: "null" }] },
  stages: { type: "array", minItems: 1, items: object({ id, name: text, taskRefs: refs, milestoneRefs: refs }) },
  milestones: { type: "array", items: object({ id, name: text, taskRefs: { ...refs, minItems: 1 } }) },
});

/** Strict shape and reference validation independent of the host validator. */
export function validateDelivery(manifest) {
  if (!Object.hasOwn(manifest, "delivery")) return [];
  const errors = [];
  const add = (path, message) => errors.push({ code: "invalid_delivery", path, message });
  function shape(value, schema, path) {
    if (schema.anyOf) return value === null ? undefined : shape(value, schema.anyOf[0], path);
    if (Object.hasOwn(schema, "const")) {
      if (value !== schema.const) add(path, `must equal ${schema.const}`);
    } else if (schema.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return add(path, "must be an object");
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) add(`${path}.${key}`, "is not allowed");
      for (const [key, child] of Object.entries(schema.properties)) shape(value[key], child, `${path}.${key}`);
    } else if (schema.type === "array") {
      if (!Array.isArray(value)) return add(path, "must be an array");
      if (value.length < (schema.minItems ?? 0)) add(path, "does not contain enough items");
      if (schema.uniqueItems && new Set(value).size !== value.length) add(path, "contains duplicate references");
      value.forEach((item, index) => shape(item, schema.items, `${path}[${index}]`));
    } else if (schema.type === "string") {
      if (typeof value !== "string" || !value.trim() || (schema.pattern && !new RegExp(schema.pattern).test(value))) add(path, "must be a valid nonempty string");
    }
  }
  shape(manifest.delivery, DELIVERY_SCHEMA, "$.delivery");
  if (errors.length) return errors;
  const d = manifest.delivery;
  const tasks = new Set((Array.isArray(manifest.phases) ? manifest.phases : []).flatMap(p => Array.isArray(p?.tasks) ? p.tasks : []).map(t => t?.id));
  const milestones = new Map(d.milestones.map(m => [m.id, m]));
  const stages = new Set(d.stages.map(s => s.id));
  if (stages.size !== d.stages.length) add("$.delivery.stages", "stage IDs must be unique");
  if (milestones.size !== d.milestones.length) add("$.delivery.milestones", "milestone IDs must be unique");
  if (!stages.has(d.activeStage)) add("$.delivery.activeStage", "must reference a configured stage");
  if (d.nextMilestoneId !== null && !milestones.has(d.nextMilestoneId)) add("$.delivery.nextMilestoneId", "must reference a configured milestone");
  d.milestones.forEach((m, i) => {
    for (const ref of m.taskRefs) if (!tasks.has(ref)) add(`$.delivery.milestones[${i}].taskRefs`, `unknown task: ${ref}`);
  });
  const cumulativeTasks = new Set();
  d.stages.forEach((stage, i) => {
    for (const ref of stage.taskRefs) {
      cumulativeTasks.add(ref);
      if (!tasks.has(ref)) add(`$.delivery.stages[${i}].taskRefs`, `unknown task: ${ref}`);
    }
    for (const ref of stage.milestoneRefs) {
      const milestone = milestones.get(ref);
      if (!milestone) add(`$.delivery.stages[${i}].milestoneRefs`, `unknown milestone: ${ref}`);
      else if (milestone.taskRefs.some(task => !cumulativeTasks.has(task))) add(`$.delivery.stages[${i}].milestoneRefs`, "milestone tasks must be included in this cumulative stage scope");
    }
  });
  return errors;
}

/** Acceptance-only readiness; activity and partial implementation stay separate. */
export function calculateDelivery(manifest, now) {
  if (!manifest.delivery) return null;
  const time = new Date(now).getTime();
  const rank = { assertion: 1, prepared: 2, validated_local: 3, public_reproducible: 4, direct: 5 };
  const tasks = new Map(manifest.phases.flatMap(p => p.tasks).map(t => [t.id, t]));
  const evidence = new Map(manifest.evidence.map(e => [e.id, e]));
  const gates = new Map(manifest.gates.map(g => [g.id, g]));
  const accepted = new Set();
  for (const task of tasks.values()) {
    const qualifying = task.evidenceRefs.filter(ref => {
      const e = evidence.get(ref);
      return e && e.state === "current" && rank[e.tier] >= rank[task.evidenceRequirement.minimumTier]
        && Date.parse(e.capturedAt) <= time && e.verifiedAt !== null && Date.parse(e.verifiedAt) <= time
        && (e.expiresAt === null || Date.parse(e.expiresAt) > time);
    });
    if (task.status === "complete" && qualifying.length >= task.evidenceRequirement.minCount
      && task.gateRefs.every(ref => ["satisfied", "waived"].includes(gates.get(ref)?.status))) accepted.add(task.id);
  }
  const summarize = taskRefs => {
    const ids = [...new Set(taskRefs)];
    const totalWeight = ids.reduce((sum, ref) => sum + tasks.get(ref).weight, 0);
    const acceptedWeight = ids.reduce((sum, ref) => sum + (accepted.has(ref) ? tasks.get(ref).weight : 0), 0);
    return { totalTasks: ids.length, acceptedTasks: ids.filter(ref => accepted.has(ref)).length,
      remainingTasks: ids.length ? ids.filter(ref => !accepted.has(ref)).length : null,
      totalWeight, acceptedWeight, percent: totalWeight ? acceptedWeight / totalWeight * 100 : null,
      displayPercent: totalWeight ? (ids.every(ref => accepted.has(ref)) ? 100 : Math.min(99, Math.round(acceptedWeight / totalWeight * 100))) : null };
  };
  const milestones = new Map(manifest.delivery.milestones.map(m => [m.id, { id: m.id, name: m.name, ...summarize(m.taskRefs) }]));
  const cumulativeTasks = new Set();
  const cumulativeMilestones = new Set();
  const stages = manifest.delivery.stages.map(stage => {
    stage.taskRefs.forEach(ref => cumulativeTasks.add(ref));
    stage.milestoneRefs.forEach(ref => cumulativeMilestones.add(ref));
    return { id: stage.id, name: stage.name, ...summarize(cumulativeTasks), totalMilestones: cumulativeMilestones.size,
      remainingMilestones: [...cumulativeMilestones].filter(ref => milestones.get(ref).remainingTasks !== 0).length };
  });
  const gaps = [...cumulativeTasks].filter(ref => !accepted.has(ref)).map(ref => {
    const task = tasks.get(ref);
    return { id: task.id, name: task.name, state: task.status,
      owner: { type: task.owner.type, label: task.owner.label },
      nextAction: task.nextAction ?? (task.status === "complete" ? "Revalidate acceptance evidence and gates." : "Define the next acceptance action."),
      reason: task.status === "complete" ? "acceptance_evidence_or_gate" : "not_accepted" };
  });
  return { schemaVersion: 1, basis: "current_accepted_task_weight", evidenceAsOf: manifest.audit.evidenceAsOf,
    activeStage: manifest.delivery.activeStage, stages,
    nextMilestone: milestones.get(manifest.delivery.nextMilestoneId) ?? null, gaps };
}
