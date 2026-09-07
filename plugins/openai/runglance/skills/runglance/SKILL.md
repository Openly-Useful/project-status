---
name: runglance
description: Show truthful, low-overhead live progress for any agent, skill, test, workflow, or automation run. Use for a portable RunGlance HUD, workflow/skill/agent accounting, context and quota visibility when hosts report it, explicit lock state, one-second local status watching, host hook normalization, verification commands, and concise or verified final run receipts. Works without model calls, network access, API keys, or the optional read-only RunGlance MCP companion.
---

# StatusGlance / RunGlance

Give users an immediate, evidence-honest answer to “what is running, is it stuck, and what finished?” Keep the terminal HUD local and dependency-free; use the MCP companion only when a model needs bounded status queries.

## Default invocation: one read-only snapshot

Calling `$runglance` means inspect existing activity once. Use the known task session and runtime, or one bounded MCP query. Do not start a run, install hooks, watch, run tests, update the ledger, or emit a finish receipt merely to answer status. If no telemetry exists, report `not connected / no events observed`; do not manufacture activity.

```sh
node <skill-dir>/scripts/runglance.mjs show --session-id <known-session> --preset swarm
```

An explicit session or isolated runtime prevents cross-project selection. Multiple sessions without a selection are ambiguous. Show each lane's latest concrete result, blocker/next action, and measured progress when its denominator exists; otherwise show unknown. Distinguish implemented, tested, and accepted. Report repeated revision or stale evidence without launching corrective work from a status-only request.

During authorized execution, record meaningful lifecycle/progress deltas and milestone verification, not every message or refresh. Reuse host events and existing task IDs. Use one local deterministic HUD process only when live watching was requested; do not schedule model polling. Loop roles are responsibilities, not mandatory extra agents.

## Preserve the truth boundary

- Report host-provided facts as `exact`, calculated facts as `derived`, opt-in approximations as `estimated`, and unavailable facts as `unknown`.
- Never convert token counts into subscription quota, invent context capacity, or treat silence as a lock.
- Report `locked` only after an explicit lock event with an owner. A missed heartbeat can report `stale`.
- Keep run progress separate from project readiness. A passing check proves only that check.
- Do not persist prompts, responses, transcripts, environment variables, credentials, raw tool arguments, or source files.

Read [the HUD and runtime guide](references/hud.md) before configuring a host, interpreting usage, or exposing a snapshot through MCP.

## Inspect setup before writing

```sh
node <skill-dir>/scripts/runglance.mjs setup plan --json
node <skill-dir>/scripts/runglance.mjs setup instructions --host codex
node <skill-dir>/scripts/runglance.mjs setup instructions --host claude
node <skill-dir>/scripts/runglance.mjs setup instructions --host generic
```

`setup guided` remains read-only. Run `setup apply --project-root <dir> --host <host>` only when the user requests repository-local configuration. It writes only `.runglance/setup.json`; it never edits global Codex, Claude, shell, tmux, or terminal settings.

Configuration metadata is not host installation, connection, or observed telemetry. Verify and report each separately. Existing command names, runtime paths, and the `runglance` plugin ID remain compatible under the StatusGlance family.

## Start and render the RunGlance HUD

```sh
node <skill-dir>/scripts/runglance.mjs start --name "Task name"
node <skill-dir>/scripts/runglance.mjs show --preset compact
node <skill-dir>/scripts/runglance.mjs watch --preset compact --interval 1000
```

Use `compact` by default, `standard` for Running and Finished work, `swarm` for delegated-agent accounting, and `diagnostic` only for troubleshooting. The watcher reads a local snapshot and consumes no model tokens or MCP calls.

Record explicit lifecycle changes:

```sh
node <skill-dir>/scripts/runglance.mjs update --kind workflow --id tests --name "Tests" --state running --completed 3 --total 8
node <skill-dir>/scripts/runglance.mjs update --kind agent --id reviewer --state waiting
node <skill-dir>/scripts/runglance.mjs update --lock-owner primary-agent
node <skill-dir>/scripts/runglance.mjs update --unlock
```

## Normalize host events

```sh
node <skill-dir>/scripts/runglance-adapter.mjs codex-hook --emit
node <skill-dir>/scripts/runglance-adapter.mjs codex-app-server --emit
node <skill-dir>/scripts/runglance-adapter.mjs claude-hook --emit
node <skill-dir>/scripts/runglance-adapter.mjs claude-statusline --emit
node <skill-dir>/scripts/runglance-adapter.mjs generic --emit
```

Adapters accept one host payload on stdin, fail closed on unknown input, and emit lifecycle transitions instead of display-refresh noise.

## Verify and finish

Pass verification arguments directly without a shell:

```sh
node <skill-dir>/scripts/runglance.mjs verify --name "Unit tests" -- npm test
node <skill-dir>/scripts/runglance.mjs finish --outcome complete --final-summary verified --format markdown
```

Use receipt mode `off` for no closing output, `concise` for one result line, and `verified` for fixes, recorded checks, safe reruns, remaining work, duration, and agent count. Report task result separately from project readiness, which remains `not assessed`.

## Use the optional MCP companion correctly

Use `runglance-mcp-server` only for read-only, bounded queries over the latest local snapshot: current activity, active or finished work, usage truth classes, and lock state. Do not use MCP to write events or drive the one-second HUD refresh. If the companion is unavailable, the CLI remains fully functional.

## Handoff

Report the selected HUD preset, live truth classes, active and finished work, explicit lock state, verification outcome, remaining work, and whether any repository-local setup was written. State explicitly when no model call, network request, global configuration, installation, or publication occurred.
