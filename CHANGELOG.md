# Changelog

All notable distribution changes are documented here. This project follows semantic versioning for skill and plugin artifacts.

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
