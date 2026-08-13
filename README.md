# Project Status Initiative

Project Status turns a repository-local manifest into an evidence-backed readiness model, a static `/status` experience, provenance checks, and bounded monitoring workflows. The core skill is portable across Claude and OpenAI/Codex; an optional MCP companion exposes the same read-only status model when its server has been built.

This repository contains four related deliverables:

- the canonical portable skill at `skill/project-status`;
- generated OpenAI/Codex and Claude plugin wrappers under `plugins/`;
- three deterministic ZIP distributions produced by `scripts/package-skill.mjs`;
- the React/Vite status prototype and its OpenAI Sites worker build.

## Trust and safety model

Readiness, evidence validity, live health, and delivery activity remain separate signals. Browser refreshes do not count as monitoring. Read-only inspection is the default; manifest edits, scheduling, installation, publishing, deployment, commits, and remote writes require separate explicit actions.

Release tooling stays repository-local. It does not install a plugin, change a personal marketplace, publish an archive, create a release, deploy Sites, or write outside its selected artifact directory.

## Canonical skill and generated wrappers

`skill/project-status` is the only source that should be edited for skill behavior. The two plugin wrappers contain physical copies at `skills/project-status` because marketplace installers copy plugin directories and cannot safely depend on paths outside the plugin root.

Synchronize the wrappers after changing the canonical skill or after building the optional MCP server:

```sh
node scripts/release-sync.mjs sync
```

CI and local preflight use the read-only drift check:

```sh
node scripts/release-sync.mjs check
```

The sync operation deterministically owns the wrapper manifests, wrapper skill trees, optional bundled MCP runtime, and both repository marketplace catalogs. Do not edit generated wrapper files by hand.

The marketplace catalogs use distinct host schemas:

- `.agents/plugins/marketplace.json` is the OpenAI/Codex repository marketplace.
- `.claude-plugin/marketplace.json` is the Claude Code marketplace.

The OpenAI plugin always includes `.codex-plugin/plugin.json`. Both plugin manifests declare `mcpServers` only when `packages/mcp/dist/index.js` is a validated self-contained bundle and its locked build metadata exists; otherwise the MCP component is omitted rather than pointing at a broken path. Generated wrappers package that single bundled entrypoint plus the shared core runtime, with no `node_modules`, package-install step, source maps, or declarations.

## Development and validation

Node.js 22 is used in CI. Install the root application dependencies, build the optional MCP package when it exists, synchronize generated wrappers, build the Sites output, and run the full suite:

```sh
npm ci
npm ci --prefix packages/mcp
npm run build --prefix packages/mcp
node scripts/release-sync.mjs sync
npm run build
node --test tests/*.test.mjs
node scripts/release-check.mjs
```

The `packages/mcp` commands apply only when that optional package is present. `npm run build` produces the Sites handoff at:

- `dist/client/index.html`
- `dist/server/index.js`
- `dist/.openai/hosting.json`

`scripts/release-check.mjs` validates wrapper drift, version agreement, host-specific marketplace and manifest shapes, the MCP bundle boundary, package safety, changelog coverage, and deterministic archive plans. It reports public-publication gates separately from repository distribution readiness. The test suite also extracts both plugin archives into isolated temporary directories and performs a pinned MCP handshake, tool listing, validation call, and summary call without installing dependencies.

## Build deterministic distributions

Inspect the package plan without writing files:

```sh
node scripts/package-skill.mjs plan
```

Build into the default ignored/local artifact directory, or select another directory:

```sh
node scripts/package-skill.mjs build
node scripts/package-skill.mjs build --output /tmp/project-status-artifacts
```

Existing outputs are never replaced implicitly. Use `--replace` only when replacement is intentional. Verify previously built bytes against a fresh deterministic plan with:

```sh
node scripts/package-skill.mjs verify --output /tmp/project-status-artifacts
```

The output set is:

- `project-status-portable-claude-skill.zip`
- `project-status-openai-plugin.zip`
- `project-status-claude-plugin.zip`
- `checksums.json`

Every ZIP contains `MANIFEST.sha256`. The builder rejects symlinks, traversal, absolute paths, tests, dependency trees, `.env` files, embedded user-home paths, and common secret formats. Archive entry order, metadata, modes, JSON formatting, and bytes are deterministic.

## Local marketplace installation

Installation changes host state and is intentionally separate from building or validating this repository. From a trusted checkout, a user can opt in with the host CLI.

For Codex:

```sh
codex plugin marketplace add .
codex plugin add project-status@project-status-initiative
```

For Claude Code:

```sh
claude plugin marketplace add .
claude plugin install project-status@project-status-initiative
```

Review the generated manifests and skill contents before installing. Marketplace plugins are trusted code, especially when the optional local MCP server is included.

## Versioning and release gates

The distribution version is recorded in `VERSION`, `skill/project-status/assets/package-metadata.json`, both plugin manifests, the Claude marketplace entry, MCP and monitor companion packages, and archive checksums. `node scripts/release-check.mjs` requires them to agree.

Version `1.0.0` is package-ready but not automatically publication-ready. Before any public release, the owner must still:

1. implement the selected Apache License 2.0 `LICENSE` with the confirmed copyright holder and ship the complete third-party notice set;
2. confirm the real publisher identity and public repository/homepage URLs;
3. review the generated archives and checksums;
4. explicitly authorize publishing or deployment.

Apache License 2.0 is the selected project license, but no final copyright holder, license file, third-party notice bundle, public publisher URL, release upload, marketplace submission, or deployment is inferred by this repository.

See [CHANGELOG.md](./CHANGELOG.md) for release history.
