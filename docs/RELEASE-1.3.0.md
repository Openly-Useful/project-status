# StatusGlance 1.3.0

Compatibility-first visibility family: StatusGlance / Readiness and StatusGlance / RunGlance. Existing plugin IDs, npm/MCP names, repository URL, runtime paths, and Apache-2.0 licensing are retained. No legal-entity or ownership change is part of this release.

## Delivered

- Optional cumulative Alpha/Beta/Live stage scopes in one manifest, with acceptance-only percentages, remaining tasks/milestones, next integrated milestone, and owner/action gaps. No duplicate tracker, inferred denominator, or rounding to 100 before acceptance.
- Read-only, bounded default status invocation and cached activity reads. Multiple sessions require explicit selection in both CLI and MCP; configured metadata is not observed telemetry.
- Correct message-versus-agent accounting, failed-command state, non-interactive swarm rows, and unknown zero-denominator progress.
- Updated dashboard branding, evidence freshness/empty-state labels, setup guidance, and portable stage presentation.
- Integration guidance for the bounded parallel Agent Workflow Swarms delivery loop.

## Verification

The release verification set covers application/core/CLI/MCP/packaging behavior, companion identity/bundles, the production build and Sites worker checks, generated-wrapper validation, supported plugin manifests, and six deterministic ZIP archives. It includes an isolated npm executable test with no sibling core files. Focused regressions were observed failing before their fixes. Desktop browser readback covered the unknown-stage home view, evidence labels, and setup handoff. Consult CI for the final source revision's results.

These checks do not prove fresh-agent behavior, an installed host's event connection, full accessibility conformance, or any real product's Alpha/Beta/Live readiness. Swarm phrase checks are static instruction tests, not agent trials. The bundled historical manifest remains a demonstration.

## Distribution and rollback

GitHub source/archives, npm packages, MCP Registry records, marketplace snapshots, and host installs are separate publication surfaces. Consult each surface for the version actually available; a prepared 1.3.0 metadata record does not prove registry publication. Restore the preceding v1.2.1 package or plugin if needed; prior releases and runtime identities are unchanged. Do not delete user telemetry or project manifests to roll back.
