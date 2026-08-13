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
  ...sectionDefinitions,
  { id: "install", label: "Attach skill", icon: Package },
];

const validSectionIds = new Set(commandSections.map((item) => item.id));

function useStatusData() {
  const [status, setStatus] = useState(bundledStatus);
  const [loadState, setLoadState] = useState("loading");

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([
      fetch("/status/manifest", { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error(`Manifest ${response.status}`);
        return response.json();
      }),
      fetch("/api/status", { signal: controller.signal }).then((response) => {
        if (!response.ok) throw new Error(`Monitor ${response.status}`);
        return response.json();
      }),
    ]).then(([manifestResult, monitorResult]) => {
      if (controller.signal.aborted) return;
      const manifest = manifestResult.status === "fulfilled" ? manifestResult.value : null;
      const monitor = monitorResult.status === "fulfilled" ? monitorResult.value : null;
      setStatus(mergeStatus(manifest ?? __PROJECT_STATUS_FALLBACK__, monitor));
      setLoadState(manifest ? "loaded" : "fallback");
    });

    return () => controller.abort();
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
              <SegmentedWorkBar tasks={tasks} score={status.score.displayPercent} />
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

      <SectionDialog section={activeSection} status={status} onClose={closeSection} onOpenSection={openSection} />
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        onOpenSection={(id) => openSection(id, paletteTriggerRef.current)}
      />
    </div>
  );
}
