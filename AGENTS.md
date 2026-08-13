# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product direction

- Visual source of truth: the owner-approved “Design 2” project-status mock at 1440 × 1024. Keep the local source asset outside public artifacts and do not record owner home-directory paths here.
- Build a light-first project-status home with a token-driven dark theme; both themes share one component and semantic-color system.
- Keep one concise home snapshot, then open Readiness, Evidence, Monitoring, Runs, Blockers, Source, and Install in accessible drawers with stable deep links.
- Support mouse, keyboard, command palette, URL/hash navigation, and AI wrappers without model-specific behavior in the core.
- Keep weighted readiness, evidence validity, live health, and delivery activity as separate state models.
- Show source commit, manifest digest, audit ID, and timestamps prominently. Browser refresh is not monitoring.
- Use Grafana-style overview-to-drilldown and context-preserving links plus Linear-style command navigation, without copying either product's visual identity or dense panel chrome.
- The canonical portable skill is required; MCP is an optional read-only/live-data companion and must not be required for static or filesystem use.
- Keep the home intentionally sparse. Lead with one visually dominant overall percentage and one wide weighted-work bar directly beneath it.
- Build the overall bar automatically from manifest tasks: each task is a proportional segment, boundaries remain visible, and status uses semantic fill/pattern plus accessible labels.
- Show only the task totals and a few assessment signals under the bar (complete, active, blocked, remaining, freshness). Keep detailed phases, evidence, monitoring, runs, provenance, and critical path inside drilldowns.
- Put subsection summaries in a quiet second tier with strong hover/focus elevation and one decisive metric each. Avoid logs, tables, dense provenance strips, and multi-panel telemetry on Home.
