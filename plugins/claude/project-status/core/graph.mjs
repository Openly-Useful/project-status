import { validateManifest } from "./validator.mjs";

function taskRecords(manifest) {
  return manifest.phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phaseId: phase.id })));
}

function lexicographicPath(first, second) {
  const firstKey = first.join("\u0000");
  const secondKey = second.join("\u0000");
  if (firstKey < secondKey) return -1;
  if (firstKey > secondKey) return 1;
  return 0;
}

/** Return a deterministic topological ordering for the validated dependency DAG. */
export function topologicalOrder(manifest) {
  validateManifest(manifest, { throwOnError: true });
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

/**
 * Compute the longest remaining blocking path by maximum hours.
 * An unknown estimate makes the result explicitly indeterminate rather than
 * inventing a calendar duration.
 */
export function criticalPath(manifest) {
  validateManifest(manifest, { throwOnError: true });
  const ordered = [...topologicalOrder(manifest)];
  const tasks = new Map(taskRecords(manifest).map((task) => [task.id, task]));
  const activeIds = ordered.filter((id) => {
    const task = tasks.get(id);
    return task.status !== "complete" && !task.deferred;
  });
  const missingEstimateTaskIds = activeIds.filter((id) => tasks.get(id).remainingHours === null);

  if (missingEstimateTaskIds.length > 0) {
    return Object.freeze({
      determinate: false,
      reason: "missing_estimates",
      path: Object.freeze([]),
      durationHours: null,
      missingEstimateTaskIds: Object.freeze(missingEstimateTaskIds),
      topologicalOrder: Object.freeze(ordered),
    });
  }

  if (activeIds.length === 0) {
    return Object.freeze({
      determinate: true,
      reason: null,
      path: Object.freeze([]),
      durationHours: Object.freeze({ min: 0, max: 0 }),
      missingEstimateTaskIds: Object.freeze([]),
      topologicalOrder: Object.freeze(ordered),
    });
  }

  const active = new Set(activeIds);
  const prerequisites = new Map(activeIds.map((id) => [id, []]));
  for (const dependency of manifest.dependencies) {
    if (dependency.type === "blocks" && active.has(dependency.prerequisiteTaskId) && active.has(dependency.dependentTaskId)) {
      prerequisites.get(dependency.dependentTaskId).push(dependency.prerequisiteTaskId);
    }
  }
  for (const values of prerequisites.values()) values.sort();

  const best = new Map();
  for (const id of ordered.filter((candidate) => active.has(candidate))) {
    const task = tasks.get(id);
    const own = task.remainingHours;
    const candidates = prerequisites.get(id).map((prerequisite) => best.get(prerequisite));
    candidates.sort((first, second) => {
      if (second.max !== first.max) return second.max - first.max;
      return lexicographicPath(first.path, second.path);
    });
    const previous = candidates[0] ?? { min: 0, max: 0, path: [] };
    best.set(id, {
      min: previous.min + own.min,
      max: previous.max + own.max,
      path: [...previous.path, id],
    });
  }

  const candidates = [...best.values()].sort((first, second) => {
    if (second.max !== first.max) return second.max - first.max;
    return lexicographicPath(first.path, second.path);
  });
  const selected = candidates[0];
  return Object.freeze({
    determinate: true,
    reason: null,
    path: Object.freeze(selected.path),
    durationHours: Object.freeze({ min: selected.min, max: selected.max }),
    missingEstimateTaskIds: Object.freeze([]),
    topologicalOrder: Object.freeze(ordered),
  });
}
