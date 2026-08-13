# Project Status MCP server

Optional local, read-only companion for the portable Project Status manifest. Static
and filesystem consumers do not require MCP.

This subpackage targets Node.js 20+, the stable MCP TypeScript SDK v2 split packages,
the 2026-07-28 protocol, and Zod v4 Standard Schemas. It serves stdio only and never
logs to stdout.

## Tools and resource

- `project_status_get_summary`
- `project_status_validate_manifest`
- `project_status_list_tasks` (filtered and paginated)
- `project_status_get_dependencies` (filtered and paginated)
- `project-status://manifest` public JSON resource

Every tool is annotated read-only, non-destructive, idempotent, and closed-world. The
server exposes no monitoring run or remote-fetch tool. Successful tool calls return
both text and `structuredContent`; failures return a stable code, safe explanation,
and next action.

## Configure and run

Install and build inside this directory; no root or global package is changed:

```sh
npm install
npm run build
node dist/index.js
```

The server reads `.project-status/manifest.json` under the current directory by
default. Configure an installation without exposing paths as tool arguments:

- `PROJECT_STATUS_ROOT=/absolute/workspace/root`
- `PROJECT_STATUS_MANIFEST=/absolute/path/to/manifest.json`
- `node dist/index.js --manifest /absolute/path/to/manifest.json`

All paths are process configuration, never returned by a tool or resource. Manifest
validation, status calculation, and public projection delegate directly to
`packages/core/index.mjs`, keeping the MCP adapter isolated from schema evolution.
