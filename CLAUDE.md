# Claude project instructions

Read `AGENTS.md` and `README.md` before changing this repository.

## Repository boundary

- This repository contains only the Project Status product, canonical skill, generated host wrappers, optional read-only MCP companion, dashboard, tests, and release tooling.
- Do not add owner business records, domain inventories, legal identities, addresses, account information, credentials, local home-directory paths, or unpublished portfolio details.
- Public projections must remain allowlisted and sanitized. Raw internal evidence locators must never be returned from the MCP or browser APIs.
- Do not publish, deploy, install a plugin, create a release, change marketplace state, schedule monitoring, commit, or push unless the owner explicitly authorizes that action.

## Canonical paths

- Edit skill behavior only under `skill/project-status`.
- Regenerate host wrappers with `node scripts/release-sync.mjs sync`; do not edit generated wrapper copies directly.
- Treat `.project-status/manifest.json` as the repository-local status source of truth.
- The optional MCP companion must remain read-only, self-contained in release archives, and model/host agnostic.

## Validation

After relevant changes, run:

```sh
node scripts/release-sync.mjs check
node scripts/release-check.mjs --json
npm test
claude plugin validate .claude-plugin/marketplace.json
claude plugin validate plugins/claude/project-status
```

Release checks distinguish local distribution readiness from public publication readiness. Never describe pending license, third-party notice, publisher, deployment, or marketplace gates as complete without direct evidence.

## First-session handoff acceptance

Before continuing work in a newly authenticated Claude session:

1. Read this file, `AGENTS.md`, and `README.md`.
2. Run only read-only orientation checks first: `git status --short`, `git remote -v`, `claude plugin list`, `npm run status:validate`, and `node scripts/release-check.mjs --json`.
3. Confirm the repository is the private `MeekPhills/project-status-initiative` source and that the installed Project Status plugin is enabled.
4. Report any drift or failure before editing.
5. When the adjacent local business-planning directory is explicitly available, read its `PRIVATE_DATA_POLICY.md` and `claude-continuation.md`, but do not open its `private` subdirectory unless the owner directly requests a specific private record.
6. If acceptance passes, summarize the product and privacy state, then continue the guided owner decision queue one question at a time.
