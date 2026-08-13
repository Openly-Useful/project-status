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
