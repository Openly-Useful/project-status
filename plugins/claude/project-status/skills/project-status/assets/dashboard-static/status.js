const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function range(value) {
  if (!value) return "Unknown";
  return `${number.format(value.min)}–${number.format(value.max)}h`;
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function progress(percent, label) {
  const root = document.createElement("div");
  root.className = "progress";
  root.setAttribute("role", "progressbar");
  root.setAttribute("aria-label", label);
  root.setAttribute("aria-valuemin", "0");
  root.setAttribute("aria-valuemax", "100");
  root.setAttribute("aria-valuenow", String(percent));
  root.setAttribute("aria-valuetext", `${number.format(percent)} percent`);
  const fill = document.createElement("span");
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  root.append(fill);
  return root;
}

function render(payload) {
  setText("project-name", payload.project || "Project status");
  setText("readiness-question", payload.readinessQuestion || "Readiness question not declared");
  setText("score", number.format(payload.readiness.exact));
  const manifestFreshness = payload.manifestFreshness ?? {};
  const snapshotStale = !manifestFreshness.staleAt || Date.now() > Date.parse(manifestFreshness.staleAt);
  const freshnessLabel = manifestFreshness.state === "proposal"
    ? "Manifest snapshot is a proposal · no live evidence check"
    : snapshotStale
      ? "Manifest freshness stale · no live evidence check"
      : "Manifest freshness within declared window · no live evidence check";
  setText("audit-state", freshnessLabel);
  setText("hands-on", range(payload.effort.active));
  setText("soak", range(payload.effort.soak));
  setText("deferred", range(payload.effort.deferred));
  setText("gates", String(payload.externalGates.length));
  setText("manifest-digest", payload.manifestDigest);

  const stages = payload.delivery?.stages ?? ["Alpha", "Beta", "Live launch"].map(name => ({ name, percent: null, remainingTasks: null, remainingMilestones: null }));
  document.getElementById("delivery-stages").replaceChildren(...stages.map(stage => {
    const card = document.createElement("article");
    card.className = "phase";
    const title = document.createElement("h3");
    title.textContent = `${stage.name}: ${stage.percent === null ? "unknown" : `${stage.displayPercent}/100`}`;
    const remaining = document.createElement("p");
    remaining.textContent = `Remaining: ${stage.remainingMilestones ?? "unknown"} milestones · ${stage.remainingTasks ?? "unknown"} tasks`;
    card.append(title);
    if (stage.percent !== null) card.append(progress(stage.percent, `${stage.name} acceptance`));
    card.append(remaining);
    return card;
  }));
  const next = payload.delivery?.nextMilestone;
  setText("delivery-next", next ? `Next integrated milestone: ${next.name} · ${next.remainingTasks} tasks remaining` : "Next integrated milestone not declared.");
  const gaps = payload.delivery?.gaps;
  document.getElementById("delivery-gaps").replaceChildren(...(gaps?.length ? gaps.map(gap => {
    const li = document.createElement("li");
    li.textContent = `${gap.name} → ${gap.owner.label} → ${gap.nextAction}`;
    return li;
  }) : [Object.assign(document.createElement("li"), { textContent: gaps ? "No current acceptance gaps in declared scope." : "Scope unknown." })]));

  const overall = document.getElementById("overall-progress");
  overall.setAttribute("aria-valuenow", String(payload.readiness.exact));
  overall.setAttribute("aria-valuetext", `${number.format(payload.readiness.exact)} of 100`);
  document.getElementById("overall-fill").style.width = `${payload.readiness.exact}%`;

  const phaseRoot = document.getElementById("phases");
  phaseRoot.replaceChildren(...payload.phases.map((phase) => {
    const card = document.createElement("article");
    card.className = "phase";
    const head = document.createElement("div");
    head.className = "phase-head";
    const title = document.createElement("h2");
    title.textContent = phase.name;
    const score = document.createElement("p");
    score.textContent = `${number.format(phase.earnedWeight)}/${number.format(phase.weight)} · ${number.format(phase.completion)}%`;
    head.append(title, score);
    card.append(head, progress(phase.completion, `${phase.name} readiness`));
    return card;
  }));

  const blockers = document.getElementById("blockers");
  const items = payload.blockers.length > 0
    ? payload.blockers.map((blocker) => {
      const item = document.createElement("li");
      item.textContent = blocker.reason ? `${blocker.name}: ${blocker.reason}` : blocker.name;
      return item;
    })
    : [Object.assign(document.createElement("li"), { textContent: "No declared blockers." })];
  blockers.replaceChildren(...items);

  if (payload.liveHealth?.observedAt) {
    setText("health", `${payload.liveHealth.state} · observed ${payload.liveHealth.observedAt}`);
  }
}

async function load() {
  const response = await fetch("./status.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Status projection returned ${response.status}`);
  render(await response.json());
}

load().catch((error) => {
  setText("audit-state", "Status unavailable");
  setText("readiness-question", error instanceof Error ? error.message : "Unable to load status");
});
