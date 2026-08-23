import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowSquareOut,
  CaretRight,
  ChartBar,
  Check,
  CheckCircle,
  ClipboardText,
  Clock,
  Command,
  Copy,
  Cube,
  CaretDown,
  Database,
  FileMagnifyingGlass,
  GitCommit,
  Hash,
  Heartbeat,
  House,
  MagnifyingGlass,
  Moon,
  Octagon,
  Package,
  PlayCircle,
  Plus,
  Question,
  ShieldCheck,
  SidebarSimple,
  Sun,
  TerminalWindow,
  Timer,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { mergeStatus } from "./status-adapter.js";
import { groupProgressPhases, workflowState } from "./progress-model.js";
import { countLabel, formatDuration, metricLabel } from "./activity-model.js";

const bundledStatus = mergeStatus(__PROJECT_STATUS_FALLBACK__, null);

const sectionDefinitions = [
  { id: "readiness", label: "Readiness", icon: ShieldCheck },
  { id: "evidence", label: "Evidence", icon: ClipboardText },
  { id: "monitoring", label: "Monitoring", icon: Heartbeat },
  { id: "runs", label: "Runs", icon: PlayCircle },
  { id: "blockers", label: "Blockers", icon: Octagon },
  { id: "source", label: "Packages", icon: Database },
];

const commandSections = [
  { id: "progress", label: "RunGlance HUD", icon: ChartBar },
  ...sectionDefinitions,
  { id: "install", label: "Attach skill", icon: Package },
];

const validSectionIds = new Set(commandSections.map((item) => item.id));

function useStatusData() {
  const [status, setStatus] = useState(bundledStatus);
  const [loadState, setLoadState] = useState("loading");

  useEffect(() => {
    const controller = new AbortController();
    let manifestSnapshot = __PROJECT_STATUS_FALLBACK__;
    let monitorSnapshot = null;
    let activityTimer = null;

    const fetchJson = (url) => fetch(url, { signal: controller.signal }).then((response) => {
      if (!response.ok) {
        const error = new Error(`${url} ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    });

    const activityPollDelay = (activity) => {
      const state = activity?.thread?.state;
      if (["running", "waiting", "locked"].includes(state) || (activity?.activeWork?.length ?? 0) > 0) return 1000;
      return activity ? 5000 : 15000;
    };

    const scheduleActivityPoll = (delay) => {
      window.clearTimeout(activityTimer);
      activityTimer = window.setTimeout(async () => {
        let activity = null;
        try {
          activity = await fetchJson("/api/activity");
          if (!controller.signal.aborted) {
            setStatus(mergeStatus(manifestSnapshot, monitorSnapshot, undefined, activity));
          }
        } catch (error) {
          if (!controller.signal.aborted && error?.status === 503) {
            setStatus(mergeStatus(manifestSnapshot, monitorSnapshot, undefined, null));
          }
          // Other transient errors keep the last good snapshot; discovery continues with backoff.
        }
        if (!controller.signal.aborted) scheduleActivityPoll(activityPollDelay(activity));
      }, delay);
    };

    Promise.allSettled([
      fetchJson("/status/manifest"),
      fetchJson("/api/status"),
      fetchJson("/api/activity"),
    ]).then(([manifestResult, monitorResult, activityResult]) => {
      if (controller.signal.aborted) return;
      const manifest = manifestResult.status === "fulfilled" ? manifestResult.value : null;
      const monitor = monitorResult.status === "fulfilled" ? monitorResult.value : null;
      const activity = activityResult.status === "fulfilled" ? activityResult.value : null;
      manifestSnapshot = manifest ?? manifestSnapshot;
      monitorSnapshot = monitor;
      setStatus(mergeStatus(manifestSnapshot, monitorSnapshot, undefined, activity));
      setLoadState(manifest ? "loaded" : "fallback");
      scheduleActivityPoll(activityPollDelay(activity));
    });

    return () => {
      window.clearTimeout(activityTimer);
      controller.abort();
    };
  }, []);

  return { status, loadState };
}

function percent(earned, total) {
  if (!total) return 0;
  return (earned / total) * 100;
}

function compactHash(value, length = 12) {
  if (!value) return "Not recorded";
  if (value.length <= length) return value;
  return `${value.slice(0, length)}…`;
}

function dateTime(value) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(parsed);
}

function timeOnly(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(parsed);
}

function StateIcon({ state, size = 18 }) {
  if (["healthy", "verified", "complete", "added"].includes(state)) {
    return <CheckCircle size={size} weight="fill" aria-hidden="true" />;
  }
  if (["blocked", "unhealthy"].includes(state)) {
    return <Octagon size={size} weight="regular" aria-hidden="true" />;
  }
  if (["degraded", "stale", "in_progress"].includes(state)) {
    return <WarningCircle size={size} weight="fill" aria-hidden="true" />;
  }
  return <Question size={size} weight="regular" aria-hidden="true" />;
}

function MetricBar({ value, max, tone = "accent", label }) {
  const amount = Math.max(0, Math.min(100, percent(value, max)));
  return (
    <div
      className={`metric-bar metric-bar--${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin="0"
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} of ${max} points`}
    >
      <span style={{ width: `${amount}%` }} />
    </div>
  );
}

function allTasks(status) {
  return (status.phases ?? []).flatMap((phase) =>
    (phase.tasks ?? []).map((task) => ({ ...task, phaseId: phase.id, phaseName: phase.name })),
  );
}

function taskStats(tasks) {
  return tasks.reduce((result, task) => {
    result.total += 1;
    if (task.status === "complete") result.complete += 1;
    else if (task.status === "in_progress") result.active += 1;
    else if (task.status === "blocked") result.blocked += 1;
    else result.remaining += 1;
    return result;
  }, { total: 0, complete: 0, active: 0, blocked: 0, remaining: 0 });
}

function overallLabel(score) {
  if (score >= 100) return "Complete";
  if (score >= 70) return "Approaching ready";
  if (score >= 35) return "Progressing";
  if (score > 0) return "In progress";
  return "Not started";
}

function overallSummary(counts, score) {
  if (score >= 100) return "Every weighted outcome is complete and backed by qualifying evidence.";
  if (counts.blocked > 0) return `${counts.blocked} weighted task${counts.blocked === 1 ? " needs" : "s need"} owner action before the remaining plan can advance.`;
  if (counts.active > 0) return `${counts.active} weighted task${counts.active === 1 ? " is" : "s are"} active; readiness advances only when new evidence qualifies.`;
  return "Foundation evidence is recorded; remaining work has not yet earned verified credit.";
}

function titleCase(value) {
  return String(value ?? "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function SegmentedWorkBar({ tasks, score }) {
  const total = tasks.reduce((sum, task) => sum + task.weight, 0) || 100;
  return (
    <div
      className="work-bar"
      role="img"
      aria-label={`${score}% readiness across ${tasks.length} weighted tasks`}
    >
      {tasks.map((task) => {
        const earnedPercent = task.weight > 0 ? Math.max(0, Math.min(100, (task.earnedWeight / task.weight) * 100)) : 0;
        return (
          <span
            className="work-segment"
            data-state={task.status}
            key={task.id}
            style={{ width: `${(task.weight / total) * 100}%` }}
            title={`${task.name}: ${task.earnedWeight}/${task.weight} points · ${task.status.replace("_", " ")}`}
          >
            <span className="work-segment__earned" style={{ width: `${earnedPercent}%` }} />
            <span className="sr-only">{task.name}: {task.earnedWeight} of {task.weight} points, {task.status.replace("_", " ")}</span>
          </span>
        );
      })}
    </div>
  );
}

function ProgressWorkflow({ phase }) {
  const tasks = phase.tasks ?? [];
  const complete = tasks.filter((task) => task.status === "complete").length;
  const state = workflowState(tasks);

  return (
    <article className="progress-workflow" data-state={state}>
      <header className="progress-workflow__header">
        <div className="progress-workflow__title">
          <i aria-hidden="true" />
          <h3>{phase.name}</h3>
        </div>
        <span>{state === "complete" ? "Completed" : titleCase(state)}</span>
      </header>
      <dl className="progress-workflow__meta">
        <div><dt>Workflow</dt><dd>{state === "complete" ? "Completed" : "Current snapshot"}</dd></div>
        <div><dt>{tasks.length} tasks</dt><dd>{phase.weight} weighted points</dd></div>
      </dl>
      <p className="progress-workflow__summary">{phase.summary ?? phase.description}</p>
      <h4>Phases</h4>
      <details className="progress-phase" open>
        <summary>
          <span>Tasks</span>
          <span>{complete}/{tasks.length} <CaretDown size={20} aria-hidden="true" /></span>
        </summary>
        <div className="progress-phase__segments" role="list" aria-label={`${complete} of ${tasks.length} tasks complete`}>
          {tasks.map((task) => <i role="listitem" aria-label={`${task.name}: ${titleCase(task.status)}`} key={task.id} data-state={task.status} />)}
        </div>
        <div className="progress-task-table" role="table" aria-label={`${phase.name} tasks`}>
          <div className="progress-task-table__head" role="row">
            <span role="columnheader">Task</span><span role="columnheader">Owner</span><span role="columnheader">Points</span>
          </div>
          {tasks.map((task) => (
            <div className="progress-task-table__row" role="row" key={task.id} data-state={task.status}>
              <span className="progress-task-name" role="cell" title={task.name}><span>{task.name}</span><small>{titleCase(task.status)}</small></span>
              <span role="cell">{task.owner?.label ?? task.owner?.id ?? "Unassigned"}</span>
              <span role="cell">{task.earnedWeight}/{task.weight}</span>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

function activityStateLabel(state) {
  if (state === "completed") return "Completed";
  if (state === "running") return "Running";
  if (state === "ready") return "Ready";
  return titleCase(state);
}

function ActivityProgress({ progress, label }) {
  if (progress?.mode !== "determinate" || !Number.isFinite(progress.percent)) {
    return <span className="activity-progress activity-progress--indeterminate">{progress?.mode === "indeterminate" ? "In progress" : "Progress —"}</span>;
  }
  const value = Math.round(progress.percent);
  return (
    <div className="activity-progress" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={value}>
      <span style={{ width: `${value}%` }} />
      <small>{value}%</small>
    </div>
  );
}

function ActivityWorkCard({ item }) {
  return (
    <article className="activity-work-card" data-state={item.state} data-kind={item.kind}>
      <header>
        <span className="activity-work-card__state"><i aria-hidden="true" /> {activityStateLabel(item.state)}</span>
        <small>{titleCase(item.kind)}</small>
      </header>
      <h4>{item.name}</h4>
      {item.summary ? <p>{item.summary}</p> : null}
      <ActivityProgress progress={item.progress} label={`${item.name} progress`} />
      <dl>
        {item.owner ? <div><dt>Owner</dt><dd>{item.owner}</dd></div> : null}
        {item.durationSeconds !== null ? <div><dt>Elapsed</dt><dd>{formatDuration(item.durationSeconds)}</dd></div> : null}
        {item.tokens !== null ? <div><dt>Tokens</dt><dd>{item.tokens.toLocaleString()}</dd></div> : null}
        {item.toolUses !== null ? <div><dt>Tool uses</dt><dd>{item.toolUses}</dd></div> : null}
      </dl>
    </article>
  );
}

function AgentSwarm({ agents }) {
  if (!agents.length) return null;
  return (
    <section className="activity-swarm" aria-labelledby="activity-swarm-title">
      <header><h4 id="activity-swarm-title">Agent swarm</h4><span>{agents.length} accounted for</span></header>
      <ul>
        {agents.map((agent) => (
          <li key={agent.id} data-state={agent.state}>
            <i aria-hidden="true" />
            <span><strong>{agent.name}</strong><small>{agent.summary ?? activityStateLabel(agent.state)}</small></span>
            <span>{agent.progress.mode === "determinate" ? `${Math.round(agent.progress.percent)}%` : activityStateLabel(agent.state)}</span>
            <time>{agent.durationSeconds === null ? "—" : formatDuration(agent.durationSeconds)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LiveActivitySummary({ activity, onOpen }) {
  if (!activity.available) {
    return (
      <section className="live-summary live-summary--unavailable" aria-labelledby="live-summary-title">
        <div>
          <span className="panel-label">RunGlance HUD</span>
          <h2 id="live-summary-title">RunGlance unavailable</h2>
          <p>No RunGlance adapter is connected. The readiness manifest below remains available and is not being presented as live work.</p>
        </div>
        <button className="secondary-button" type="button" onClick={onOpen}>View RunGlance details <CaretRight size={17} aria-hidden="true" /></button>
      </section>
    );
  }

  const context = metricLabel(activity.usage.contextRemainingPercent);
  const freshness = activity.freshness.ageSeconds === null ? "—" : `${activity.freshness.ageSeconds}s ago`;
  return (
    <section className="live-summary" aria-labelledby="live-summary-title">
      <div className="live-summary__lead">
        <span className="panel-label">RunGlance HUD</span>
        <h2 id="live-summary-title"><i data-state={activity.thread.state} aria-hidden="true" /> {activityStateLabel(activity.thread.state)}</h2>
        <ActivityProgress progress={activity.progress} label="Current run progress" />
      </div>
      <dl className="live-summary__metrics">
        <div><dt>Workflows</dt><dd>{countLabel(activity.counts.workflows)}</dd></div>
        <div><dt>Skills</dt><dd>{countLabel(activity.counts.skills)}</dd></div>
        <div><dt>Agents</dt><dd>{countLabel(activity.counts.agents)}</dd></div>
        <div><dt>Context</dt><dd>{context}</dd></div>
        <div><dt>Lock</dt><dd>{titleCase(activity.lock.state)}</dd></div>
        <div><dt>Updated</dt><dd>{freshness}</dd></div>
      </dl>
      <button className="secondary-button" type="button" onClick={onOpen}>Open RunGlance HUD <CaretRight size={17} aria-hidden="true" /></button>
    </section>
  );
}

function VerificationReceipt({ receipt }) {
  const [mode, setMode] = useState(receipt?.mode ?? "off");

  useEffect(() => {
    setMode(receipt?.mode ?? "off");
  }, [receipt?.id, receipt?.mode]);

  const showReceipt = Boolean(receipt) && mode !== "off";
  return (
    <section className="verification-receipt" aria-labelledby="verification-receipt-heading">
      <header className="verification-receipt__settings">
        <div><span className="progress-eyebrow">End of run</span><h3 id="verification-receipt-heading">Final status summary</h3></div>
        <div className="receipt-modes" role="group" aria-label="Final summary preview mode">
          {["off", "concise", "verified"].map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={mode === option}
              disabled={!receipt && option !== "off"}
              onClick={() => setMode(option)}
            >
              {titleCase(option)}
            </button>
          ))}
        </div>
      </header>

      {!receipt ? <p className="verification-receipt__empty">No run receipt has been recorded. Final summaries default to off.</p> : null}
      {receipt && mode === "off" ? <p className="verification-receipt__empty">A receipt is available, but its preview is off.</p> : null}
      {showReceipt ? (
        <article className="receipt-card" data-mode={mode}>
          <header>
            <CheckCircle size={27} weight="fill" aria-hidden="true" />
            <div><span>Run receipt</span><h4>{receipt.title}</h4></div>
          </header>
          {receipt.summary ? <p className="receipt-card__summary">{receipt.summary}</p> : null}
          {receipt.fixes.length ? (
            <section className="receipt-card__section" aria-labelledby="receipt-fixes-title">
              <h5 id="receipt-fixes-title">Fixed</h5>
              <ul>{receipt.fixes.map((fix, index) => <li key={`${index}-${fix}`}>{fix}</li>)}</ul>
            </section>
          ) : null}
          <dl className="receipt-card__results">
            <div><dt>Task result</dt><dd>{receipt.taskResult}</dd></div>
            <div><dt>Project readiness</dt><dd>{receipt.readiness}</dd></div>
            {receipt.durationSeconds !== null || receipt.durationLabel ? <div><dt>Elapsed</dt><dd>{receipt.durationLabel ?? formatDuration(receipt.durationSeconds)}</dd></div> : null}
          </dl>
          {mode === "verified" && receipt.verifications.length ? (
            <section className="receipt-card__section" aria-labelledby="receipt-verification-title">
              <h5 id="receipt-verification-title">Verification</h5>
              <div className="verification-table" role="table" aria-label="Verification results">
                <div className="verification-table__head" role="row"><span role="columnheader">Check</span><span role="columnheader">Result</span><span role="columnheader">Details</span></div>
                {receipt.verifications.map((check) => (
                  <div className="verification-table__row" role="row" data-state={check.status} key={check.id}>
                    <span role="cell">{check.name}</span>
                    <strong role="cell">{check.status.toUpperCase()}</strong>
                    <span role="cell">{[check.exitCode === null ? null : `exit ${check.exitCode}`, check.durationSeconds === null ? null : formatDuration(check.durationSeconds), check.detail].filter(Boolean).join(" · ") || "—"}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {mode === "verified" && receipt.rerunCommands.length ? (
            <section className="receipt-card__section" aria-labelledby="receipt-rerun-title">
              <h5 id="receipt-rerun-title">Re-run</h5>
              <div className="receipt-commands">
                {receipt.rerunCommands.map((command) => <div className="receipt-command" key={command}><code>$ {command}</code><CopyButton value={command} /></div>)}
              </div>
            </section>
          ) : null}
          {receipt.remainingWork.length ? (
            <section className="receipt-card__section receipt-card__remaining" aria-labelledby="receipt-remaining-title">
              <h5 id="receipt-remaining-title">Remaining</h5>
              <ul>{receipt.remainingWork.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
            </section>
          ) : null}
        </article>
      ) : null}
    </section>
  );
}

function ProgressDialog({ open, status, onClose }) {
  const ref = useRef(null);
  const phases = status.phases ?? [];
  const { running: openReadiness, finished: finishedReadiness } = groupProgressPhases(phases);
  const activity = status.liveActivity;
  const activeAgents = activity.activeWork.filter((item) => item.kind === "agent");
  const activeNonAgents = activity.activeWork.filter((item) => item.kind !== "agent");

  useEffect(() => {
    if (open && ref.current && !ref.current.open) ref.current.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className="progress-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onKeyDown={(event) => keepFocusInsideDialog(event, ref.current)}
      aria-labelledby="progress-dialog-title"
    >
      <section className="progress-sheet">
        <header className="progress-sheet__header">
          <span className="progress-sheet__handle" aria-hidden="true" />
          <button type="button" onClick={onClose} aria-label="Close RunGlance HUD"><X size={30} aria-hidden="true" /></button>
          <h2 id="progress-dialog-title">RunGlance HUD</h2>
        </header>
        <div className="progress-sheet__body">
          {activity.available ? (
            <section className="activity-overview" aria-labelledby="activity-overview-title">
              <header><div><span className="progress-eyebrow">RunGlance</span><h3 id="activity-overview-title">{activityStateLabel(activity.thread.state)}</h3></div><span>Updated {activity.freshness.ageSeconds === null ? "—" : `${activity.freshness.ageSeconds}s ago`}</span></header>
              <ActivityProgress progress={activity.progress} label="Current run progress" />
              <dl>
                <div><dt>Workflows</dt><dd>{countLabel(activity.counts.workflows)}</dd></div>
                <div><dt>Skills</dt><dd>{countLabel(activity.counts.skills)}</dd></div>
                <div><dt>Agents</dt><dd>{countLabel(activity.counts.agents)}</dd></div>
                <div><dt>Context</dt><dd>{metricLabel(activity.usage.contextRemainingPercent)}</dd></div>
                <div><dt>Quota</dt><dd>{metricLabel(activity.usage.quotaRemainingPercent)}</dd></div>
                <div><dt>Lock</dt><dd>{titleCase(activity.lock.state)}</dd></div>
              </dl>
            </section>
          ) : (
            <section className="activity-unavailable" aria-labelledby="activity-unavailable-title">
              <Heartbeat size={24} aria-hidden="true" />
              <div><h3 id="activity-unavailable-title">RunGlance unavailable</h3><p>No RunGlance adapter is connected. Manifest phases remain readiness data and are shown separately below.</p></div>
            </section>
          )}

          {activity.available ? (
            <>
              <details className="progress-group activity-group" open>
                <summary><h3>Running {activity.activeWork.length}</h3><CaretDown size={18} aria-hidden="true" /></summary>
                <div className="progress-group__content">
                  {activeNonAgents.map((item) => <ActivityWorkCard item={item} key={item.id} />)}
                  <AgentSwarm agents={activeAgents} />
                  {!activity.activeWork.length ? <p className="progress-group__empty">No active work details were reported.</p> : null}
                </div>
              </details>
              <details className="progress-group activity-group" open>
                <summary><h3>Finished {activity.finishedWork.length}</h3><CaretDown size={18} aria-hidden="true" /></summary>
                <div className="progress-group__content">
                  {activity.finishedWork.length ? activity.finishedWork.map((item) => <ActivityWorkCard item={item} key={item.id} />) : <p className="progress-group__empty">No finished work has been recorded.</p>}
                </div>
              </details>
            </>
          ) : null}

          <VerificationReceipt receipt={activity.lastReceipt} />

          <details className="readiness-plan">
            <summary><span><strong>Readiness plan</strong><small>Evidence-backed project progress · {status.score.displayPercent}%</small></span><CaretDown size={20} aria-hidden="true" /></summary>
            <div className="readiness-plan__content">
              <p className="readiness-plan__note">This plan is derived from the manifest. It is not a live workflow, agent, or elapsed-time feed.</p>
              <details className="progress-group" open>
                <summary><h3>Open readiness work {openReadiness.length}</h3><CaretDown size={18} aria-hidden="true" /></summary>
                <div className="progress-group__content">
                  {openReadiness.length ? openReadiness.map((phase) => <ProgressWorkflow phase={phase} key={phase.id} />) : <p className="progress-group__empty">No open readiness phases.</p>}
                </div>
              </details>
              <details className="progress-group">
                <summary><h3>Finished readiness work {finishedReadiness.length}</h3><CaretDown size={18} aria-hidden="true" /></summary>
                <div className="progress-group__content">
                  {finishedReadiness.length ? finishedReadiness.map((phase) => <ProgressWorkflow phase={phase} key={phase.id} />) : <p className="progress-group__empty">No readiness phases are fully complete.</p>}
                </div>
              </details>
            </div>
          </details>
        </div>
      </section>
    </dialog>
  );
}

function TruthItem({ label, value, icon: Icon, title }) {
  return (
    <div className="truth-item" title={title ?? value}>
      {Icon ? <Icon size={17} aria-hidden="true" /> : null}
      <span>
        <small>{label}</small>
        <strong>{value}</strong>
      </span>
    </div>
  );
}

function SummaryTile({ icon: Icon, title, metric, description, onOpen, state }) {
  return (
    <button className="summary-tile" type="button" onClick={onOpen} data-state={state}>
      <div className="summary-tile__title">
        <span className="summary-tile__icon"><Icon size={23} aria-hidden="true" /></span>
        <strong>{title}</strong>
      </div>
      <strong className="summary-tile__metric">{metric}</strong>
      <p>{description}</p>
      <span className="summary-tile__open">
        <span className="sr-only">Open {title}</span><CaretRight size={18} aria-hidden="true" />
      </span>
    </button>
  );
}

const dialogFocusableSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function keepFocusInsideDialog(event, dialog) {
  if (event.key !== "Tab" || !dialog?.open) return;
  const focusable = [...dialog.querySelectorAll(dialogFocusableSelector)].filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

function SectionDialog({ section, status, onClose, onOpenSection }) {
  const ref = useRef(null);

  useEffect(() => {
    if (section && ref.current && !ref.current.open) ref.current.showModal();
    if (!section && ref.current?.open) ref.current.close();
  }, [section]);

  if (!section) return null;
  const definition = commandSections.find((item) => item.id === section);

  return (
    <dialog
      ref={ref}
      className="section-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onKeyDown={(event) => keepFocusInsideDialog(event, ref.current)}
      aria-labelledby="section-dialog-title"
    >
      <div className="section-dialog__scrim" onClick={onClose} aria-hidden="true" />
      <section className="section-drawer">
        <header className="section-drawer__header">
          <div>
            <span className="eyebrow">Project status / {definition?.label}</span>
            <h2 id="section-dialog-title">{definition?.label}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={`Close ${definition?.label}`}>
            <X size={22} aria-hidden="true" />
          </button>
        </header>
        <div className="section-drawer__body">
          <SectionContent section={section} status={status} onOpenSection={onOpenSection} />
        </div>
      </section>
    </dialog>
  );
}

function SectionContent({ section, status, onOpenSection }) {
  if (section === "readiness") {
    return (
      <>
        <div className="drawer-lead">
          <span className="drawer-kicker">Exact weighted readiness</span>
          <strong>{status.score.earnedWeight}<small> / {status.score.totalWeight}</small></strong>
          <p>Only outcomes backed by qualifying evidence earn points. Health and activity never alter this score.</p>
        </div>
        <div className="drawer-list">
          {status.phases.map((phase) => (
            <article className="drawer-row" key={phase.id}>
              <div>
                <h3>{phase.name}</h3>
                <p>{phase.description}</p>
              </div>
              <div className="drawer-row__metric">
                <strong>{phase.earnedWeight} / {phase.weight}</strong>
                <MetricBar value={phase.earnedWeight} max={phase.weight} label={`${phase.name} readiness`} />
              </div>
            </article>
          ))}
        </div>
        <Callout icon={Timer} title="Critical path estimate">
          Earliest ready {status.criticalPath.earliestReady}. {status.criticalPath.assumption}
        </Callout>
      </>
    );
  }

  if (section === "evidence") {
    return (
      <>
        <div className="drawer-metrics drawer-metrics--three">
          <DrawerMetric label="Evidence records" value={status.evidenceSummary.total ?? status.evidenceSummary.current} />
          <DrawerMetric label="Current" value={status.evidenceSummary.current} />
          <DrawerMetric label="Stale" value={status.evidenceSummary.stale} tone={status.evidenceSummary.stale ? "warning" : "positive"} />
        </div>
        <h3 className="drawer-section-title">Changed evidence</h3>
        <div className="drawer-list">
          {status.changes.map((change) => (
            <article className="drawer-row drawer-row--event" key={change.id} data-state={change.state}>
              <StateIcon state={change.state} />
              <div>
                <h3>{change.summary}</h3>
                <p>{change.id} · {dateTime(change.at)}</p>
              </div>
            </article>
          ))}
        </div>
        <Callout icon={FileMagnifyingGlass} title="Evidence contract">
          Each earned increment names the assertion, tier, locator, digest or revision, verifier, observation time, and revalidation policy.
        </Callout>
      </>
    );
  }

  if (section === "monitoring") {
    return (
      <>
        <Callout icon={Heartbeat} title="Operational signals do not change readiness">
          Monitoring is a separate state machine. This view reports the latest persisted scheduled observation, not browser polling.
        </Callout>
        <div className="drawer-metrics drawer-metrics--three">
          <DrawerMetric label="Last scheduled" value={timeOnly(status.monitoring.lastScheduledAt)} />
          <DrawerMetric label="Last success" value={timeOnly(status.monitoring.lastSuccessAt)} />
          <DrawerMetric label="Next due" value={timeOnly(status.monitoring.nextDueAt)} />
        </div>
        <div className="drawer-list">
          {status.monitoring.checks.map((check) => (
            <article className="drawer-row drawer-row--check" key={check.id} data-state={check.state}>
              <StateIcon state={check.state} />
              <div>
                <h3>{check.name}</h3>
                <p>{check.detail}</p>
              </div>
              <strong>{check.state}</strong>
            </article>
          ))}
        </div>
      </>
    );
  }

  if (section === "runs") {
    return (
      <>
        <div className="drawer-metrics drawer-metrics--two">
          <DrawerMetric label="Latest verified audit" value={dateTime(status.audit.verifiedAt)} />
          <DrawerMetric label="Next weighted audit" value={dateTime(status.audit.nextDueAt)} />
        </div>
        <Callout icon={PlayCircle} title="Validation is separate from monitoring">
          This command checks the weighted manifest at a point in time. It does not probe services, persist a run, or advance the audit timestamps.
        </Callout>
        <div className="code-panel">
          <span>Read-only validation</span>
          <code>node skill/project-status/scripts/status.mjs validate . --json</code>
          <CopyButton value="node skill/project-status/scripts/status.mjs validate . --json" />
        </div>
        <p className="drawer-note">Scheduling belongs to CI, Codex automation, Claude scheduling, cron, or another host. The skill never starts a daemon by itself.</p>
      </>
    );
  }

  if (section === "blockers") {
    return (
      <>
        {status.blockers.map((blocker) => (
          <article className="blocker-detail" key={blocker.id}>
            <span className="blocker-detail__icon"><Octagon size={28} aria-hidden="true" /></span>
            <div>
              <span className="eyebrow">{blocker.kind} blocker · {blocker.age}</span>
              <h3>{blocker.name}</h3>
              <dl>
                <div><dt>Owner</dt><dd>{blocker.owner}</dd></div>
                <div><dt>Unlocks</dt><dd>{blocker.unlocks}</dd></div>
                <div><dt>Next action</dt><dd>{blocker.nextAction}</dd></div>
              </dl>
            </div>
          </article>
        ))}
        <button className="primary-button" type="button" onClick={() => onOpenSection("install")}>
          Review package requirements <ArrowRight size={18} aria-hidden="true" />
        </button>
      </>
    );
  }

  if (section === "source") {
    return (
      <>
        <div className="provenance-card">
          <TruthItem label="Source state" value={status.source.state ?? "unknown"} icon={ShieldCheck} />
          <TruthItem label="Source commit" value={status.source.commit ?? "Not recorded"} icon={GitCommit} />
          <TruthItem label="Manifest SHA-256" value={status.source.manifestSha256 ?? "Not recorded"} icon={Hash} />
          <TruthItem label="Audit ID" value={status.source.auditId ?? status.audit.auditId ?? "Not recorded"} icon={ClipboardText} />
        </div>
        <h3 className="drawer-section-title">Packages</h3>
        <div className="drawer-list">
          {status.packages.map((item) => (
            <article className="drawer-row drawer-row--check" key={item.id} data-state={item.state}>
              <StateIcon state={item.state} />
              <div><h3>{item.name}</h3><p>{item.target}</p></div>
              <strong>{item.state.replace("_", " ")}</strong>
            </article>
          ))}
        </div>
        <Callout icon={Database} title="Public projection">
          The dashboard serves a sanitized projection. Private notes, local paths, credential-bearing URLs, and internal evidence locators stay out of public output.
        </Callout>
      </>
    );
  }

  return (
    <>
      <Callout icon={Package} title="One portable core, host-specific discovery">
        The skill works from files alone. Claude and Codex use the same SKILL.md and deterministic scripts; wrappers only supply discovery and presentation metadata.
      </Callout>
      <div className="install-grid">
        <InstallCommand
          label="Repository attachment"
          command="node skill/project-status/scripts/attach.mjs apply . --mode symlink"
        />
        <InstallCommand
          label="Codex project discovery"
          command=".agents/skills/project-status/SKILL.md"
        />
        <InstallCommand
          label="Claude Code discovery"
          command=".claude/skills/project-status/SKILL.md"
        />
        <InstallCommand
          label="Claude.ai upload"
          command="artifacts/skills/project-status-portable-claude-skill.zip"
        />
      </div>
      <Callout icon={TerminalWindow} title="Optional MCP companion">
        Add MCP only when an AI client needs structured, read-only status access. Static dashboards, validation, summaries, and repository attachment do not require it.
      </Callout>
    </>
  );
}

function Callout({ icon: Icon, title, children }) {
  return (
    <aside className="callout">
      <Icon size={24} aria-hidden="true" />
      <div><strong>{title}</strong><p>{children}</p></div>
    </aside>
  );
}

function DrawerMetric({ label, value, tone }) {
  return (
    <div className="drawer-metric" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InstallCommand({ label, command }) {
  return (
    <div className="install-command">
      <span>{label}</span>
      <code>{command}</code>
      <CopyButton value={command} />
    </div>
  );
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-button"
      type="button"
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? <Check size={17} aria-hidden="true" /> : <Copy size={17} aria-hidden="true" />}
      <span className="sr-only" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
    </button>
  );
}

function CommandPalette({ open, onClose, onOpenSection }) {
  const ref = useRef(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open && ref.current && !ref.current.open) {
      setQuery("");
      ref.current.showModal();
    }
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);

  const matches = commandSections.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <dialog
      ref={ref}
      className="command-dialog"
      aria-label="Open a project status section"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
      onKeyDown={(event) => keepFocusInsideDialog(event, ref.current)}
    >
      <div className="command-palette">
        <label className="command-search">
          <MagnifyingGlass size={22} aria-hidden="true" />
          <span className="sr-only">Search sections</span>
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Open a project-status section…" />
          <kbd>Esc</kbd>
        </label>
        <div className="command-results">
          {matches.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" onClick={() => { onClose(); onOpenSection(id); }}>
              <Icon size={21} aria-hidden="true" />
              <span>Open {label}</span>
              <small>#{id}</small>
            </button>
          ))}
          {matches.length === 0 ? <p className="command-empty" role="status">No matching sections.</p> : null}
        </div>
        <footer><Command size={16} aria-hidden="true" /> Navigate from any AI wrapper with the same section IDs.</footer>
      </div>
    </dialog>
  );
}

export function App() {
  const { status, loadState } = useStatusData();
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteTriggerRef = useRef(null);
  const sectionTriggerRef = useRef(null);
  const [activeSection, setActiveSection] = useState(() => {
    const id = window.location.hash.slice(1);
    return validSectionIds.has(id) ? id : null;
  });
  const previousSectionRef = useRef(activeSection);
  const [theme, setTheme] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("theme");
    if (["light", "dark"].includes(requested)) return requested;
    const stored = window.localStorage.getItem("project-status-theme");
    if (["light", "dark"].includes(stored)) return stored;
    return "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("project-status-theme", theme);
  }, [theme]);

  useEffect(() => {
    const onHashChange = () => {
      const id = window.location.hash.slice(1);
      setActiveSection(validSectionIds.has(id) ? id : null);
    };
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!paletteOpen) {
          paletteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setPaletteOpen(true);
        }
      }
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [paletteOpen]);

  useEffect(() => {
    const previousSection = previousSectionRef.current;
    previousSectionRef.current = activeSection;
    if (previousSection && !activeSection) {
      const trigger = sectionTriggerRef.current;
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    }
  }, [activeSection]);

  const openPalette = () => {
    const trigger = document.activeElement;
    if (trigger instanceof HTMLElement && !trigger.closest(".command-dialog")) {
      paletteTriggerRef.current = trigger;
    }
    setPaletteOpen(true);
  };

  const closePalette = () => {
    setPaletteOpen(false);
    window.requestAnimationFrame(() => {
      const trigger = paletteTriggerRef.current;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    });
  };

  const openSection = (id, explicitTrigger) => {
    const trigger = explicitTrigger ?? document.activeElement;
    if (trigger instanceof HTMLElement && !trigger.closest(".section-dialog")) {
      sectionTriggerRef.current = trigger;
    }
    window.history.pushState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
    setActiveSection(id);
  };

  const closeSection = () => {
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setActiveSection(null);
  };

  const sourceBound = status.source.state === "bound";
  const primaryAction = status.nextActions[0];
  const tasks = allTasks(status);
  const counts = taskStats(tasks);
  const scoreLabel = overallLabel(status.score.exactPercent ?? status.score.displayPercent);
  const scoreSummary = overallSummary(counts, status.score.exactPercent ?? status.score.displayPercent);
  const latestAudit = status.audit.verifiedAt ?? status.evidenceSummary.latestVerifiedAt;
  const auditVerificationState = status.audit.verificationState ?? status.audit.state ?? "unknown";
  const auditMetric = !latestAudit
    ? "No audit"
    : auditVerificationState === "current" ? "Manifest current"
      : auditVerificationState === "proposal" ? "Proposal snapshot" : "Review needed";
  const hasMonitorRun = Boolean(status.monitoring.lastScheduledAt);
  const monitorMetric = hasMonitorRun ? titleCase(status.monitoring.state) : "Setup needed";
  const monitorTone = !hasMonitorRun
    ? "degraded"
    : status.monitoring.state === "healthy" ? "healthy"
      : status.monitoring.state === "unhealthy" ? "blocked" : "degraded";

  return (
    <div className={`app-shell ${collapsed ? "app-shell--collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to status snapshot</a>
      <aside className="sidebar" aria-label="Project status navigation">
        <div className="brand-mark" role="img" aria-label="Project Status Initiative"><Cube size={31} weight="duotone" aria-hidden="true" /></div>
        <nav>
          <button className={`nav-item ${activeSection ? "" : "nav-item--active"}`} type="button" onClick={closeSection} title="Home" aria-current={activeSection ? undefined : "page"}>
            <House size={22} weight="fill" aria-hidden="true" /><span>Home</span>
          </button>
          {sectionDefinitions.map(({ id, label, icon: Icon }) => (
            <button className={`nav-item ${activeSection === id ? "nav-item--active" : ""}`} type="button" key={id} onClick={() => openSection(id)} title={label} aria-current={activeSection === id ? "page" : undefined}>
              <Icon size={22} aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </nav>
        <button className="collapse-button" type="button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          <SidebarSimple size={21} aria-hidden="true" /><span>Collapse</span>
        </button>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><strong>Project Status Initiative</strong><span>/</span><em>Home</em></div>
          <div className="topbar__actions">
            <button className="environment-button" type="button" onClick={() => openSection("readiness")} title="Open readiness state"><span /> {titleCase(status.initiativeState)} <CaretRight size={15} aria-hidden="true" /></button>
            <button className="search-button" type="button" onClick={openPalette} aria-label="Search or run a command">
              <MagnifyingGlass size={20} aria-hidden="true" /><span>Search or run a command…</span><kbd>⌘ K</kbd>
            </button>
            <button className="theme-button" type="button" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>
              {theme === "light" ? <Sun size={20} aria-hidden="true" /> : <Moon size={20} aria-hidden="true" />} <span>{theme === "light" ? "Light" : "Dark"}</span>
            </button>
            <button className="attach-button" type="button" onClick={() => openSection("install")}><Plus size={18} aria-hidden="true" /> Attach skill</button>
          </div>
        </header>

        <section className="home-truth-line" aria-label="Snapshot freshness">
          <span><CheckCircle size={19} weight="fill" aria-hidden="true" /> Manifest evidence {status.evidenceSummary.stale === 0 ? "current" : "stale"}</span>
          <i />
          <span>{sourceBound ? "source bound" : "source local"}</span>
          <i />
          <span>{latestAudit ? `${auditVerificationState === "current" ? "manifest verified" : "snapshot dated"} ${dateTime(latestAudit)}` : "manifest verification pending"}</span>
          <button type="button" onClick={() => openSection("source")}>View provenance <ArrowSquareOut size={16} aria-hidden="true" /></button>
          <small className={`load-state load-state--${loadState}`}>{loadState === "loaded" ? "served" : loadState === "loading" ? "loading" : "bundled"}</small>
        </section>

        <main id="main-content" className="dashboard">
          <LiveActivitySummary activity={status.liveActivity} onOpen={() => openSection("progress")} />

          <section className="overall-status" aria-labelledby="overall-status-title">
            <div className="overall-status__heading">
              <div>
                <span className="panel-label">Overall status</span>
                <div className="overall-status__number"><strong>{status.score.displayPercent}%</strong><em>{scoreLabel}</em></div>
                <h1 id="overall-status-title">Evidence-backed project progress</h1>
                <p>{scoreSummary}</p>
              </div>
              <button className="overall-next" type="button" onClick={() => openSection("readiness") }>
                <span><ArrowRight size={22} aria-hidden="true" /></span>
                <div><small>Next</small><strong>{primaryAction.name}</strong><em>{primaryAction.owner} · {primaryAction.effort}</em></div>
              </button>
            </div>

            <div className="overall-status__bar">
              <button className="progress-tracker-button" type="button" onClick={() => openSection("progress")} aria-label="Open project activity and readiness details">
                <SegmentedWorkBar tasks={tasks} score={status.score.displayPercent} />
                <span>Open readiness details <CaretRight size={17} aria-hidden="true" /></span>
              </button>
              <div className="work-legend" aria-label="Task state legend">
                <span data-state="complete"><i /> Complete ({counts.complete})</span>
                <span data-state="in_progress"><i /> Active ({counts.active})</span>
                <span data-state="blocked"><i /> Blocked ({counts.blocked})</span>
                <span data-state="not_started"><i /> Remaining ({counts.remaining})</span>
              </div>
            </div>

            <dl className="overall-counts">
              <div><dt>Weighted points</dt><dd>{status.score.earnedWeight} / {status.score.totalWeight}</dd></div>
              <div><dt>Total tasks</dt><dd>{counts.total}</dd></div>
              <div><dt>Complete</dt><dd>{counts.complete}</dd></div>
              <div><dt>Active</dt><dd>{counts.active}</dd></div>
              <div><dt>Blocked</dt><dd>{counts.blocked}</dd></div>
              <div><dt>Remaining</dt><dd>{counts.remaining}</dd></div>
            </dl>
          </section>

          <section className="summary-grid" aria-label="Status sections">
            <SummaryTile icon={ShieldCheck} title="Readiness" metric={`${status.phases.length} phases`} description="Weighted plan and dependencies." onOpen={() => openSection("readiness")} />
            <SummaryTile icon={ClipboardText} title="Evidence" metric={status.evidenceSummary.stale ? "Review needed" : "Fresh"} description={`Verified ${dateTime(status.evidenceSummary.latestVerifiedAt)}.`} onOpen={() => openSection("evidence")} state={status.evidenceSummary.stale ? "stale" : "verified"} />
            <SummaryTile icon={Heartbeat} title="Monitoring" metric={monitorMetric} description="Operational checks and alerting." onOpen={() => openSection("monitoring")} state={monitorTone} />
            <SummaryTile icon={PlayCircle} title="Runs" metric={auditMetric} description={latestAudit ? `Weighted snapshot ${dateTime(latestAudit)}.` : "No weighted audit timestamp."} onOpen={() => openSection("runs")} state={auditVerificationState === "current" ? "verified" : "stale"} />
            <SummaryTile icon={Octagon} title="Blockers" metric={`${status.blockers.length} owner action${status.blockers.length === 1 ? "" : "s"}`} description={status.blockers[0]?.name ?? "No active blocker."} onOpen={() => openSection("blockers")} state={status.blockers.length ? "blocked" : "healthy"} />
            <SummaryTile icon={Database} title="Packages" metric={`${status.packages.filter((item) => item.id !== "mcp").length} targets`} description="Portable skill and host wrappers." onOpen={() => openSection("source")} state={sourceBound ? "verified" : "unknown"} />
          </section>

          <section className="home-next-action" aria-label="Critical next action">
            <span className="home-next-action__icon"><ArrowRight size={23} aria-hidden="true" /></span>
            <div><small>Critical next action</small><strong>{primaryAction.name}</strong></div>
            <span>Owner: <strong>{primaryAction.owner}</strong></span>
            <span>Estimate: <strong>{primaryAction.effort}</strong></span>
            <button className="attach-button" type="button" onClick={() => openSection("readiness")}>Open <ArrowSquareOut size={17} aria-hidden="true" /></button>
          </section>
        </main>

        <footer className="status-footer">
          <span>Schema v{status.schemaVersion} <i /> Skill v{status.release} <i /> Model-agnostic core <i /> MCP optional <i /> All times UTC</span>
        </footer>
      </div>

      <ProgressDialog open={activeSection === "progress"} status={status} onClose={closeSection} />
      <SectionDialog section={activeSection === "progress" ? null : activeSection} status={status} onClose={closeSection} onOpenSection={openSection} />
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onOpenSection={(id) => openSection(id, paletteTriggerRef.current)}
      />
    </div>
  );
}
