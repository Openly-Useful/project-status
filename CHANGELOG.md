# Changelog

All notable distribution changes are documented here. This project follows semantic versioning for skill and plugin artifacts.

## 1.3.0 - 2026-09-07

- Introduce the StatusGlance family with Readiness and RunGlance display labels; preserve all package IDs, commands, paths, repository URLs, and Apache-2.0 terms.
- Add optional cumulative delivery stages in the existing manifest, with acceptance-only weighted readiness, remaining task/milestone counts, next milestone, and actionable gaps. Unknown scope stays unknown; expired evidence reduces current readiness without changing historical task state.
- Make status skill invocation read-only and bounded by default. Do not start, verify, watch, or finish work merely to report status.
- Bundle the readiness core into the npm executable so it runs without sibling source files; verify both isolated npm and plugin layouts.
- Fix App Server message/tool agent miscounts, failed-command reporting, non-interactive swarm output, and zero-denominator progress.
- Read saved activity state without replaying the event log; require explicit selection when multiple sessions exist.
- Distinguish local setup metadata from host connection or observed telemetry. Correct bundled, empty, and stale snapshot labels; add stage views to the web and portable dashboards.
- Align generated plugin interfaces with supported fields; support remains available through package metadata and the publisher support page.
- Document integration with the bounded parallel swarm delivery loop. This release does not certify live host telemetry, fresh-agent workflow behavior, or product acceptance.

## 1.2.1 - 2026-08-23

### Changed

- Advanced Project Status, RunGlance, both npm package contracts, both MCP Registry records, and both provider marketplaces to `1.2.1` so every future npm/MCP publication can resolve to the same released source commit.
- Aligned the repository publisher mirror with the live founder-operated Openly Useful authority while Openly Useful LLC remains formation-pending.
- Made npm package readiness depend on direct founder-owner authorization, exact package/MCP namespaces, public-policy files, and deterministic release validation instead of LLC formation or provider marketplace review.
- Normalized both npm CLI `bin` maps and made the combined MCP build mark its bundled commands executable so npm preserves every published command without manifest correction.
- Kept npm account authentication at the actual registry boundary and retained marketplace, MCP Registry, deployment, and future LLC operation as separate workflows.

### Release gates

- The `v1.2.1` GitHub tag and all six deterministic release archives must resolve to the same reviewed merge commit.
- npm package publication and MCP Registry submission remain separate actions and are not performed by this GitHub patch release.

## 1.2.0 - 2026-08-16

### Added

- Canonical repository mirror of the Openly Useful publisher contract, including the planned `Openly Useful LLC` publisher/operator/licensee role, `.org` and `.com` identities, policy endpoints, provider namespaces, and explicit formation status.
- Unmodified Apache License 2.0 text plus repository privacy, terms, security, support, and contribution documents linked to their canonical Openly Useful `.org` pages.
- Release validation for both Project Status and RunGlance publisher metadata, exact license bytes, public policy files, generated provider fields, current founder-authorized open-source publication, and external-activation state.

### Changed

- Fail closed at each MCP package's `npm publish` boundary and require explicit release-blocker clearance before external activation.
- Evaluate Project Status evidence freshness against the real current clock unless a caller supplies an explicit deterministic clock.
- Advanced the repository, both products, and companion package contract to `1.2.0`; the prior `1.1.0` identifier collides with a different cached Project Status distribution and is not reused.
- Standardized Openly Useful as the publisher/developer brand while retaining Project Status and RunGlance as product names.
- Recorded the owner's correction that RunGlance was solely authored by and remains personally owned by the founder. No copyright assignment or ownership transfer is required or planned; the future LLC may publish, operate, and license the product under founder authorization.
- Required all deterministic distributions to include the license, privacy, terms, security, support, and third-party-notice files.

### Release gates

- Local distribution readiness is independent from external publication readiness.
- Sole authorship and personal ownership are confirmed facts, not activation gates.
- Public marketplace and commercial activation remain pending entity formation, documentation of founder authorization for future LLC publication, provider/business verification, public URL reachability, and explicit publication authorization.
- No marketplace submission, package publication, registry registration, release upload, installation, or external deployment has been performed.

## 1.1.0 - 2026-08-15

### Added

- Standalone `runglance` skill with a dependency-free live-run runtime, strict event contract, permission-restricted local state, atomic snapshots, bounded Running and Finished work, and exact/derived/estimated/unknown truth classes.
- RunGlance HUD compact, standard, swarm, diagnostic, JSON, Unicode, and ASCII renderers with one-second local refresh that makes no model or MCP calls.
- Repository-local setup planner plus Codex hooks/App Server, Claude hooks/status-line, and strict generic host adapters that fail closed on unknown input.
- Shell-free verification execution and configurable off/concise/verified final receipts that separate task result from project readiness.
- Dedicated read-only `runglance_*` MCP status, work-list, usage, and lock tools plus `runglance://status`; legacy Project Status activity queries remain compatibility aliases.
- Public `/api/activity` projection and branded RunGlance HUD Running/Finished/swarm views with context, quota, lock, freshness, progress, and final receipt presentation.
- Deterministic portable-skill, OpenAI-plugin, and Claude-plugin RunGlance archives with generated host manifests and standard optional MCP connection descriptors.
- Concurrency coverage for simultaneous adapter writers, canonical snapshot/receipt cross-contract tests, privacy boundaries, responsive activity UI, and extracted plugin smoke coverage.

### Changed

- Moved live-run instructions and runtime files out of the Project Status skill so RunGlance is their single canonical skill boundary.
- Kept the portable local runtime free and open-source-oriented while retaining MCP as an optional companion rather than a requirement.

### Release gates

- Local deterministic packaging is supported for 1.1.0.
- This historical source state was superseded by 1.2.0 before publication because the version identifier collided with a materially different cached distribution.
- No marketplace submission, release upload, plugin installation, external deployment, or public publication has been performed.

## 1.0.0 - 2026-08-12

### Added

- Strict canonical v1 manifest and shared core runtime for weighted readiness, evidence freshness, provenance, gates, dependencies, public projection, and deterministic validation.
- Canonical portable `project-status` skill with readiness, evidence, provenance, monitoring, dashboard, attachment, and packaging workflows.
- Sparse, responsive light/dark status dashboard with phase and task drilldowns, provenance views, and explicit manifest-freshness language.
- Separate read-only `/status/manifest` projection and persisted `/api/status` monitor-state endpoint so dashboard reads never execute probes or conflate live health with canonical readiness.
- Hardened durable monitor with bounded targets and concurrency, network and redirect policy, timeouts, response-size limits, append-only snapshots, explicit private-network override, and stable recovery history.
- Read-only MCP v2 companion pinned and tested against protocol `2026-07-28`, including workspace-root discovery, summary, validation, task and dependency tools, public manifest resources, and actionable error codes.
- Repository-local OpenAI/Codex and Claude marketplace catalogs using their host-specific schemas.
- Deterministically generated plugin wrappers containing physical copies of the canonical skill.
- Conditional packaging for a self-contained MCP companion bundle and its required core runtime, with no post-extraction dependency installation, `node_modules`, source maps, or declarations.
- Reproducible portable-skill, OpenAI-plugin, and Claude-plugin ZIPs with SHA-256 inventories and a checksums document.
- Release validation for wrapper drift, manifest schemas, version agreement, unsafe paths, embedded home paths, likely secrets, tests, archive reproducibility, and extracted OpenAI/Claude MCP handshake-list-call smoke coverage.
- CI coverage for dependency installation, MCP build/test when present, wrapper validation, Sites build, the full Node test suite, and package verification.

### Release gates

- Public publication remains pending an owner-selected license.
- Public publication remains pending confirmed publisher identity and repository/homepage URLs.
- No marketplace submission, release upload, plugin installation, or deployment has been performed.
