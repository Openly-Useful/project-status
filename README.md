# Project Status Initiative

Project Status turns a repository-local manifest into an evidence-backed readiness model. RunGlance is the separate, zero-model-call live-run companion: **RunGlance** names the portable skill/runtime, while **RunGlance HUD** names its compact terminal and dashboard surface. Both skills are portable across Claude, OpenAI/Codex, and generic CLIs; each has an optional, bounded, read-only MCP entrypoint.

This repository contains eight related deliverables:

- the canonical portable skill at `skill/project-status`;
- the standalone RunGlance skill at `skill/runglance`;
- the dependency-free RunGlance runtime, host adapters, HUD presets, verification runner, and final receipts;
- optional read-only Project Status and RunGlance MCP entrypoints under `packages/mcp`;
- generated OpenAI/Codex and Claude plugin wrappers under `plugins/`;
- deterministic Project Status and RunGlance ZIP distributions produced by `scripts/package-skill.mjs` and `scripts/package-runglance.mjs`;
- the React/Vite status prototype and its OpenAI Sites worker build.

## Trust and safety model

Readiness, evidence validity, live health, and delivery activity remain separate signals. Browser refreshes do not count as monitoring. Read-only inspection is the default; manifest edits, scheduling, installation, publishing, deployment, commits, and remote writes require separate explicit actions.

Activity also separates context-window capacity, provider quota, task budget, monetary cost, progress, heartbeat freshness, and explicit lock ownership. Missing host data stays `unknown`; it is never displayed as zero or guessed from another metric. Passing verification proves the check and task result recorded by the receipt, not overall project readiness.

Release tooling stays repository-local. It does not install a plugin, change a personal marketplace, publish an archive, create a release, deploy Sites, or write outside its selected artifact directory.

## Canonical skill and generated wrappers

`skill/project-status` is the only source that should be edited for skill behavior. The two plugin wrappers contain physical copies at `skills/project-status` because marketplace installers copy plugin directories and cannot safely depend on paths outside the plugin root.

`skill/runglance` is the corresponding canonical source for RunGlance. Its generated wrappers contain `skills/runglance`, the RunGlance-only MCP entrypoint, and no readiness-manifest runtime. Do not put RunGlance lifecycle or HUD behavior back into the Project Status skill.

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

## RunGlance and RunGlance HUD

RunGlance requires Node.js 20+ and uses no runtime dependencies, network calls, model calls, API keys, remote storage, or shell evaluation. Setup is inspectable and repository-local:

```sh
node skill/runglance/scripts/runglance.mjs setup plan --json
node skill/runglance/scripts/runglance.mjs setup instructions --host codex
node skill/runglance/scripts/runglance.mjs setup instructions --host claude
node skill/runglance/scripts/runglance.mjs setup instructions --host generic
```

`setup guided` remains read-only. `setup apply --project-root <dir> --host <host>` writes only `.runglance/setup.json` in that repository; host-level hooks or status-line settings still require a separate user-authorized action.

A direct run can start, render, verify, and finish without involving MCP:

```sh
node skill/runglance/scripts/runglance.mjs start --name "Release verification"
node skill/runglance/scripts/runglance.mjs watch --preset compact --interval 1000
node skill/runglance/scripts/runglance.mjs verify --name "Unit tests" -- npm run test:unit
node skill/runglance/scripts/runglance.mjs finish \
  --outcome complete \
  --summary "Activity stream verified" \
  --final-summary verified
```

The default `compact` RunGlance HUD shows the fastest useful context. `standard` expands Running and Finished work, `swarm` accounts for delegated agents, and `diagnostic` exposes troubleshooting detail. `watch` refreshes the local snapshot once per second only while useful and consumes no model tokens or MCP calls. The renderer degrades to ASCII for simple terminals and emits static output when stdout is not interactive.

Adapters accept normalized events from Codex hooks/App Server, Claude hooks/status line, or any strict generic producer. Every metric retains its `exact`, `derived`, `estimated`, or `unknown` truth class. Runtime state is permission-restricted, bounded, redacted, and excludes prompts, transcripts, environment variables, raw tool arguments, credentials, and source files.

Final summaries are configurable as `off`, `concise`, or `verified`. A verified receipt includes fixes, recorded checks, safe local rerun commands, remaining work, elapsed time, and agent count. The public activity API and MCP projection omit rerun arguments and command output; those remain a trusted local CLI surface.

The optional `runglance-mcp` entrypoint exposes only `runglance_get_status`, `runglance_list_work`, `runglance_get_usage`, `runglance_get_locks`, and `runglance://status`. It is a query companion, not the HUD refresh engine:

```sh
npm run build --prefix packages/mcp
RUNGLANCE_RUNTIME_DIR=/absolute/runtime/path node packages/mcp/dist/runglance-index.js
```

Generated OpenAI and Claude RunGlance plugins include standard `.mcp.json` descriptors. Installation can therefore use each host's normal connection-consent UI; no API key, subscription, remote account, or paid service is required.

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

`scripts/release-check.mjs` validates wrapper drift, version agreement, host-specific marketplace and manifest shapes, the MCP bundle boundary, package safety, changelog coverage, deterministic archive plans, package identities, namespaces, public-policy files, and founder publication authorization. Both publishable MCP packages run `scripts/assert-publish-ready.mjs` at the `prepublishOnly` boundary. npm publication is founder-authorized while LLC formation remains pending; the registry still enforces account authentication at the actual publish request, and provider marketplace review is a separate workflow that does not block npm. The test suite also extracts both plugin archives into isolated temporary directories and performs a pinned MCP handshake plus readiness and activity tool calls without installing dependencies.

Third-party notices are generated from the pinned runtime dependency graphs rather than the full development toolchain:

```sh
npm run notices:plan
node scripts/third-party-notices.mjs build
npm run notices:verify
```

The generator covers the site runtime and bundled MCP runtime, retains each distinct upstream license text, and produces `THIRD_PARTY_NOTICES.md` deterministically. Packaging refuses to produce release archives without the repository `LICENSE`, privacy, terms, security, support, and notice files, and includes all of them in every ZIP.

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

RunGlance has the same plan/build/verify contract:

```sh
node scripts/package-runglance.mjs plan
node scripts/package-runglance.mjs build
node scripts/package-runglance.mjs verify
```

Its output set is `runglance-portable-claude-skill.zip`, `runglance-openai-plugin.zip`, `runglance-claude-plugin.zip`, and `checksums.json`.

## Local marketplace installation

Installation changes host state and is intentionally separate from building or validating this repository. From a trusted checkout, a user can opt in with the host CLI.

For Codex:

```sh
codex plugin marketplace add .
codex plugin add project-status@project-status-initiative
codex plugin add runglance@project-status-initiative
```

For Claude Code:

```sh
claude plugin marketplace add .
claude plugin install project-status@project-status-initiative
claude plugin install runglance@project-status-initiative
```

Review the generated manifests and skill contents before installing. Marketplace plugins are trusted code, especially when the optional local MCP server is included.

## Versioning and release gates

The distribution version is recorded in `VERSION`, both canonical component metadata files, generated plugin manifests, the Claude marketplace entry, MCP and monitor companion packages, and archive checksums. `node scripts/release-check.mjs` requires them to agree. Release `1.2.0` supersedes the unpublished `1.1.0` source identifier because that identifier collides with a materially different cached Project Status distribution.

`publisher/publisher.json` is the repository mirror/consumer of <https://openlyuseful.org/publisher/manifest.json>. Openly Useful is the publisher/developer brand. Openly Useful LLC is the planned publisher, operator, and licensee, but remains formation-pending and must not be described as already formed. The `.org` identity is the canonical open-source, publisher, policy, security, and support surface; `.com` is the studio/commercial identity. Component metadata points to the canonical public <https://github.com/Openly-Useful/project-status> repository and <https://openlyuseful.org/support>.

RunGlance was solely authored by and remains personally owned by the founder. Openly Useful is currently operated by the individual founder, who directly authorizes open-source and npm package publication while LLC formation remains pending. No IP assignment, ownership transfer, or ownership verification is required; a future LLC can later publish, operate, and license RunGlance under documented founder authorization without becoming the copyright owner.

Local distribution readiness and npm package readiness remain separate signals. `distributionReady` covers source, generated wrappers, license/notices, policies, metadata, and deterministic packages. `publishReady` additionally requires:

1. direct founder-owner authorization effective while LLC formation is pending;
2. exact npm package and MCP namespace contracts;
3. the canonical privacy, terms, security, and support policy files;
4. current license, notices, generated wrappers, tests, and deterministic package plans.

Account authentication is not fabricated by the static readiness result. npm
enforces it separately when an actual registry request is made.

OpenAI/Claude provider review, marketplace submission, MCP Registry submission, deployment, and future LLC operation remain separate workflows. None is inferred from npm readiness, and provider review does not block npm publication.

The repository contains the unmodified Apache License 2.0 text and a deterministic third-party notice bundle. Apache-2.0 does not require a project-specific copyright-holder/year placeholder in the license text.

See [CHANGELOG.md](./CHANGELOG.md) for release history and
[PROVENANCE.md](./PROVENANCE.md) for the preserved source and ownership record.
