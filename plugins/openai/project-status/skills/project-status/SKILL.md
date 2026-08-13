---
name: project-status
description: Inspect, validate, generate, and maintain an evidence-backed project /status dashboard. Use for weighted readiness, blockers, active/deferred effort and unknown estimates, provenance checks, one-shot live monitoring, dashboard plan/apply/check workflows, repository attachment for Codex and Claude, or local plugin packaging and verification.
---

# Project Status

Maintain one conservative source of truth for project readiness. Keep weighted scope, evidence validity, live service health, external wait, and delivery activity separate.

## Preserve the safety boundary

- Default to read-only inspection. `plan`, `check`, `find`, `validate`, `summary`, `verify`, and `monitor once` do not edit project files.
- Run `apply`, `init`, or `package build` only when the user explicitly asks for the corresponding write.
- Refuse ambiguous tracker, route, output, or attachment conflicts. Never overwrite without the explicit overwrite flag shown by the relevant command.
- Treat commit, push, deployment, global installation, scheduling, marketplace registration, submission, and public posting as separate actions. Never infer them from audit, attach, package, or monitor requests.
- Never award readiness credit from agent activity, elapsed time, a green endpoint, packaging success, or a fresh browser reload.

## Locate and validate the tracker

Use the dependency-free CLI:

```sh
node <skill-dir>/scripts/status.mjs find <project-root>
node <skill-dir>/scripts/status.mjs validate <project-root> --json
node <skill-dir>/scripts/status.mjs summary <project-root> --markdown
```

Prefer `.project-status/manifest.json`. If discovery finds multiple candidates, stop and ask which is canonical. Initialize only when requested:

```sh
node <skill-dir>/scripts/status.mjs init <project-root> --project "Project name"
```

Read [the methodology](references/methodology.md) before changing weights, earned credit, evidence, task state, or estimates. The strict v1 manifest uses `route`, `initiative`, `source`, `audit`, `totalWeight`, `phases`, global `evidence`, `gates`, and a dependency-edge array. Treat the bundled schema as authoritative; unknown properties and schema versions are errors. Advance `audit.evidenceAsOf` when the evidence set used for scoring changes, and `audit.verifiedAt` only after a real weighted audit. Validation, rendering, packaging, and browser refreshes do not advance either timestamp.

## Generate or maintain `/status`

Read [the dashboard contract](references/dashboard.md), then inspect the host application and run a read-only plan:

```sh
node <skill-dir>/scripts/dashboard.mjs plan <project-root> --json
```

The bundled adapter emits a framework-neutral static dashboard. Its recommended output is `public/status` for detected web applications and `status` otherwise. Supply `--output <relative-dir>` when project routing requires another location.

Apply only when requested:

```sh
node <skill-dir>/scripts/dashboard.mjs apply <project-root> --output public/status
node <skill-dir>/scripts/dashboard.mjs check <project-root> --output public/status --json
```

Use `--replace` only after inspecting reported conflicts and receiving authorization to replace those exact generated files. The public projection is allowlist-built: it omits internal/restricted locators, private assertions, internal IDs, and non-public integrity metadata. Integrate the generated static route with the host framework when its routing model does not serve directory indexes automatically; do not claim route readiness until the project's build and route checks pass.

## Verify provenance

Read [the provenance guide](references/provenance.md). Plan first, then verify offline evidence:

```sh
node <skill-dir>/scripts/provenance.mjs plan <project-root> --json
node <skill-dir>/scripts/provenance.mjs verify <project-root> --json
```

Network verification requires explicit `--network`. Localhost requires the additional `--allow-localhost` flag. The verifier never edits the manifest or advances timestamps. Do not expose query secrets, credentials, private paths, or raw private evidence in a report.

## Run one live observation

Read [the monitoring guide](references/monitoring.md), then run only a bounded one-shot observation:

```sh
node <skill-dir>/scripts/monitor.mjs once <project-root> --json
```

Use `--allow-localhost` only for an intentional local fixture. The command does not cache, record, schedule, retry indefinitely, fix, deploy, or publish. Report its observation time separately from manifest freshness. Manifest freshness describes the timestamped snapshot and never implies that evidence locators or live services were just checked.

## Attach across Codex and Claude

Read [the platform guide](references/platforms.md). Inspect before writing:

```sh
node <skill-dir>/scripts/attach.mjs plan <project-root> --mode symlink --json
node <skill-dir>/scripts/attach.mjs apply <project-root> --mode symlink --json
node <skill-dir>/scripts/attach.mjs verify <project-root> --json
```

The canonical repository copy is `.agent-skills/project-status`. Discovery paths are `.agents/skills/project-status` and `.claude/skills/project-status`. Use `--mode copy` where repository-relative symlinks are unreliable. Attachment refuses existing targets and never installs globally.

## Package locally

Read [the packaging guide](references/packaging.md). From the source initiative, plan or verify without writing:

```sh
node scripts/package-skill.mjs plan
node scripts/package-skill.mjs verify
```

Build local archives only when requested:

```sh
node scripts/package-skill.mjs build
```

The deterministic builder produces a portable skill ZIP, an OpenAI plugin ZIP, a Claude plugin ZIP, and SHA-256 inventories. It does not install or publish them.

## Handoff

Report the exact and rounded readiness; phase denominators; active and deferred effort, unknown estimates, recurring work, and typed gate waits; blockers; changed evidence; provenance limitations; live health and observation time; manifest freshness timestamps; and verified `/status` route. State which operations wrote files and explicitly say when no commit, deploy, installation, schedule, or publication occurred.
