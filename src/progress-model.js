export function workflowState(tasks = []) {
  if (tasks.length > 0 && tasks.every((task) => task.status === "complete")) return "complete";
  if (tasks.some((task) => task.status === "in_progress")) return "in_progress";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  return "not_started";
}

export function groupProgressPhases(phases = []) {
  return phases.reduce((groups, phase) => {
    const target = workflowState(phase.tasks ?? []) === "complete" ? groups.finished : groups.running;
    target.push(phase);
    return groups;
  }, { running: [], finished: [] });
}
