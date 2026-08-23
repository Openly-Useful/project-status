# Project Status and RunGlance MCP servers

<!-- mcp-name: org.openlyuseful/project-status -->

Optional local, read-only companions for Project Status readiness and standalone RunGlance activity. Static, filesystem, and direct RunGlance HUD consumers do not require MCP.

The publishable Project Status package identity is `@openly-useful/project-status-mcp`, with official MCP Registry name `org.openlyuseful/project-status`. This source package deliberately retains both the `project-status-mcp` and `runglance-mcp` local bins so existing plugin builds and tests keep working. Public RunGlance packaging is owned by the sibling `packages/runglance-mcp` bundle and uses its independent package and registry identity.

Neither package nor either MCP Registry record is published by this repository. External publication remains gated on formation of the planned publisher, explicit authorization, namespace verification, and public policy verification.

This subpackage targets Node.js 20+, the stable MCP TypeScript SDK v2 split packages,
the 2026-07-28 protocol, and Zod v4 Standard Schemas. It serves stdio only and never
logs to stdout.

## Tools and resource

The dedicated RunGlance entrypoint exposes:

- `runglance_get_status`
- `runglance_list_work` (active/finished/all, filtered and paginated)
- `runglance_get_usage`
- `runglance_get_locks`
- `runglance://status` bounded public JSON resource

The Project Status entrypoint exposes readiness tools plus legacy activity compatibility aliases:

- `project_status_get_summary`
- `project_status_validate_manifest`
- `project_status_list_tasks` (filtered and paginated)
- `project_status_get_dependencies` (filtered and paginated)
- `project_status_get_activity`
- `project_status_list_active_work` (active/finished/all, filtered and paginated)
- `project_status_get_usage`
- `project_status_get_locks`
- `project-status://manifest` public JSON resource
- `project-status://activity` bounded public JSON resource

Every tool is annotated read-only, non-destructive, idempotent, and closed-world. The
server exposes no monitoring run, activity-write, verification-execution, or remote-fetch tool. Successful tool calls return
both text and `structuredContent`; failures return a stable code, safe explanation,
and next action.

## Configure and run

Install and build inside this directory; no root or global package is changed:

```sh
npm install
npm run build
node dist/index.js
node dist/runglance-index.js --help
```

The server reads `.project-status/manifest.json` under the current directory by
default. Configure an installation without exposing paths as tool arguments:

- `PROJECT_STATUS_ROOT=/absolute/workspace/root`
- `PROJECT_STATUS_MANIFEST=/absolute/path/to/manifest.json`
- `PROJECT_STATUS_ACTIVITY_FILE=/absolute/path/to/activity-snapshot.json`
- `PROJECT_STATUS_RUNTIME_DIR=/absolute/path/to/activity-runtime`
- `node dist/index.js --manifest /absolute/path/to/manifest.json`

RunGlance uses its own namespaced configuration:

- `RUNGLANCE_ACTIVITY_FILE=/absolute/path/to/activity-snapshot.json`
- `RUNGLANCE_RUNTIME_DIR=/absolute/path/to/runglance-runtime`
- `node dist/runglance-index.js --snapshot /absolute/path/to/activity-snapshot.json`

All paths are process configuration, never returned by a tool or resource. Manifest
validation, status calculation, and public projection delegate directly to
`packages/core/index.mjs`, keeping the MCP adapter isolated from schema evolution.
Activity is independent of manifest readiness: missing activity returns
`activity_unavailable`, never a fabricated zero. The activity projection removes
commands, rerun arguments, output, prompts, transcripts, tool arguments, environment
data, credentials, and local paths.
