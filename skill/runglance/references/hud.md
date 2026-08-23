# RunGlance HUD, runtime, and verification receipts

RunGlance reports what a task is doing now across agents, skills, tests, workflows, and tools. It does **not** assess project readiness, award delivery credit, or modify another tracker.

It requires Node.js 20 or newer and uses no dependencies, model calls, API keys, network connections, shell evaluation, or remote storage.

## Truth boundary

Every usage value carries one of four truth classes:

- `exact`: directly observed from the host or supplied by an authoritative adapter;
- `derived`: calculated from an exact value, such as remaining context from exact used context;
- `estimated`: an explicitly enabled approximation, displayed with `~`;
- `unknown`: unavailable; its value must be `null` and displays as `—`.

Context capacity, provider quota, task budget, monetary cost, and rate limits are different measurements. Never substitute one for another. A percentage is determinate only when a trusted numerator and denominator are both present. A missed heartbeat can produce `stale`; it cannot prove that a task is locked. `locked` requires an explicit lock event and owner.

## Setup modes

Inspect the storage, retention, and permission contract without writing:

```sh
node <skill-dir>/scripts/runglance.mjs setup plan --json
```

`setup instructions` prints host-specific commands without writing. `setup guided` adds the exact repository-local apply command and remains read-only. `setup apply --project-root <dir> --host codex|claude|generic|all` writes only `.runglance/setup.json` inside that project; it never edits Codex, Claude, shell, tmux, or user-level configuration. Host configuration requires a separate, explicit permission step by the host or user. Pass `--replace` only after reviewing an existing repository-local setup file.

Set `RUNGLANCE_RUNTIME_DIR` to place ephemeral state somewhere else. Runtime directories use mode `0700` and files use `0600` where the filesystem supports POSIX modes. The runtime stores normalized lifecycle metadata, a bounded JSONL event tail, an atomic reducer state, bounded verification output, and snapshots. A short-lived local writer lock prevents parallel agent hooks from reusing sequence numbers or dropping each other's events. It does not store prompts, responses, transcripts, environment variables, credentials, raw tool arguments, or source files.

The default retention is the current session: `finish` removes that session's event files after printing the optional receipt. The runtime atomically maintains `activity-snapshot.json` at the runtime root as the latest safe, redacted snapshot for a local dashboard or read-only MCP adapter, and `last-receipt.json` as the latest final receipt. A new session replaces the snapshot; `purge` removes both aliases. `--retention-days 7` additionally retains redacted receipts for seven days.

## Start and update a session

```sh
node <skill-dir>/scripts/runglance.mjs start --name "Release verification"
node <skill-dir>/scripts/runglance.mjs update \
  --kind workflow --id tests --name "Test suite" --state running \
  --completed 3 --total 8 \
  --context-used 41
node <skill-dir>/scripts/runglance.mjs update --kind agent --id reviewer --state waiting
node <skill-dir>/scripts/runglance.mjs update --kind workflow --id tests --heartbeat
node <skill-dir>/scripts/runglance.mjs update --lock-owner primary-agent
node <skill-dir>/scripts/runglance.mjs update --unlock
```

`start` prints the new session ID and records it as the active local session. Pass `--session-id` to address another session explicitly.

Adapters can append the strict version-1 event object directly:

```sh
node <skill-dir>/scripts/runglance.mjs emit --event '{
  "type":"entity.started",
  "source":"host-adapter",
  "entity":{"kind":"agent","id":"reviewer","name":"Independent review"},
  "state":"running"
}'
```

Supported entity kinds are `thread`, `workflow`, `skill`, `agent`, and `tool`. Lifecycle events are `entity.started`, `entity.updated`, `entity.heartbeat`, `entity.completed`, `entity.failed`, and `entity.stopped`. The runtime also accepts explicit lock, verification, and run-outcome events. Unknown fields and invalid enum values are rejected.

## Render or watch locally

```sh
node <skill-dir>/scripts/runglance.mjs show --preset compact
node <skill-dir>/scripts/runglance.mjs show --preset standard
node <skill-dir>/scripts/runglance.mjs show --preset swarm
node <skill-dir>/scripts/runglance.mjs show --preset diagnostic
node <skill-dir>/scripts/runglance.mjs snapshot --json
node <skill-dir>/scripts/runglance.mjs watch --preset compact --interval 1000
```

The renderer formats the materialized local snapshot; it does not poll a model or MCP server. A one-second watch refresh therefore consumes no model tokens. It adapts at 60 and 100 columns, falls back to ASCII for `TERM=dumb` or `NO_COLOR`, and emits a static line instead of terminal redraw sequences when stdout is not a TTY. `watch --once` is useful for smoke tests and scripts.

The snapshot includes bounded `activeWork` and `finishedWork` arrays so Running and Finished views use the same facts. `finishedWork` retains the newest 200 completed, failed, or stopped entities. Live counts include active entities only; final receipt counts cover every observed workflow, skill, and delegated agent.

## Host adapters

The dependency-free adapter accepts one host payload on stdin and can either print normalized event JSON or append it with `--emit`:

```sh
node <skill-dir>/scripts/runglance-adapter.mjs codex-hook --emit
node <skill-dir>/scripts/runglance-adapter.mjs codex-app-server --emit
node <skill-dir>/scripts/runglance-adapter.mjs claude-hook --emit
node <skill-dir>/scripts/runglance-adapter.mjs claude-statusline --emit
node <skill-dir>/scripts/runglance-adapter.mjs generic --emit
```

The Codex adapter maps App Server thread, turn, and item lifecycle notifications plus SessionStart/SubagentStart/SubagentStop/Stop hooks. It uses rate-limit values only when an `account/rateLimits/read` payload actually contains them. The Claude adapter maps its corresponding session and subagent hooks; its status-line mapper uses exact `context_window.remaining_percentage` and reported `rate_limits.*.used_percentage` fields only when present. Selecting the most constrained reported rate-limit window is labeled `derived`. Generic input supplies strict lifecycle events and does not gain context or quota merely by using the adapter.

Unknown host events fail closed. Adapters do not parse transcripts or infer completion, locks, usage, or quotas from descriptive text.

## Run and record verification

Arguments after `--` are passed directly to the child process without a shell:

```sh
node <skill-dir>/scripts/runglance.mjs verify --name "Unit tests" -- npm test
node <skill-dir>/scripts/runglance.mjs verify --name "Focused tests" -- \
  node --test tests/focused.test.mjs
```

The command's stdout and stderr remain visible. The activity runtime records a bounded, redacted tail, duration, and exit code. It reports `PASS` only for exit code `0`, preserves non-zero child exit codes as its own, forwards termination signals, and never reruns a check implicitly.

Avoid passing secrets on command lines because operating-system process listings may expose them even though persistence is redacted. Prefer the child tool's native secret store or protected environment configuration.

## Finish and print an optional receipt

```sh
node <skill-dir>/scripts/runglance.mjs finish \
  --outcome complete \
  --summary "Boundary fixed; status check working" \
  --fix "Replaced the placeholder with the working runtime" \
  --remaining "External review remains" \
  --final-summary verified \
  --format markdown
```

Receipt modes:

- `off` (default): record the outcome and print nothing;
- `concise`: one outcome line with check count and elapsed time;
- `verified`: fixed items, recorded verification results, safe rerun commands, remaining work, duration, and agent count.

Receipt formats are `text`, `markdown`, and `json`. A completed task, a passing check, and project readiness remain separate claims. When no verification completed, the receipt says `UNKNOWN`; it never implies success.

Every receipt labels `Task result` separately and sets `Project readiness` to `not assessed`. The activity runtime never imports the readiness calculator or infers readiness from checks. A higher-level manifest-aware renderer may add an exact readiness result as a separate source-backed field.

Finishing terminalizes the primary thread, stops every child entity that is still active, releases an explicit session lock, and only then records the outcome. The final snapshot therefore has no Running work and preserves every completed, failed, or stopped item under Finished.

Retained receipts are available with `history --json`. `doctor --json` checks the local runtime contract without making network requests. `purge` removes the exact configured runtime directory and nothing outside it; it refuses filesystem roots, the home directory, the working project, the system temporary root, and their ancestors.

## Adapter guidance

Host adapters should:

1. emit lifecycle transitions rather than one event per display refresh;
2. heartbeat only while work is active;
3. use stable entity IDs and monotonically increasing session sequences;
4. label unavailable host metrics `unknown` instead of synthesizing zero;
5. label opt-in approximations `estimated`;
6. record explicit lock acquisition/release rather than inferring locks from silence;
7. use the JSON snapshot for MCP, dashboards, and other renderers instead of scraping terminal text;
8. keep subscription quota support capability-dependent because many hosts do not expose it.

The optional MCP companion may read snapshots and receipts. It should not drive the one-second refresh, collect arbitrary host telemetry, or write activity events through a model-mediated call.
