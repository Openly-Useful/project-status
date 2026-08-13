# `/status` dashboard contract

## Required hierarchy

The first viewport should answer:

1. Which readiness question is measured?
2. What are the exact score and rounded percentage?
3. What is the manifest snapshot's evidence/audit basis, and is that snapshot stale?
4. What is live now versus unfinished?
5. Which owner action or dependency blocks the critical path?

Include manifest-driven phase rows, active and deferred ranges, unknown estimates, blockers, typed gates/waits, live state with observation time, and task details. Treat delivery activity as coordination state, not readiness.

## Data and privacy

- Calculate all totals from task data in one shared model.
- Never duplicate authoritative totals in component code or prose.
- Never let health, workstream completion, or refresh frequency alter readiness credit.
- Serve a sanitized public projection rather than the editable manifest when evidence may contain private locators, notes, credentials, account data, or local paths.
- Display manifest digest, source revision when available, and audit time independently.

## Freshness

Label this state **manifest freshness**, based on `audit.evidenceAsOf`, `audit.verifiedAt`, `audit.nextDueAt`, and `audit.staleAfterSeconds`. Do not say that evidence was freshly checked merely because the manifest validated or rendered. Show manifest freshness separately from live-observation freshness. A page may have green live checks while roadmap evidence is stale. Failed refreshes do not reset either timestamp or replace the last successful observation.

## Accessibility and responsive behavior

- Provide text for every visual bar; do not rely on color alone.
- Use headings, links, buttons, tables, and disclosure controls semantically.
- Give progress bars exact accessible values.
- Keep visible keyboard focus and honor reduced motion.
- Preserve labels and exact values on narrow screens.
- Do not let fixed UI obscure content or focus targets.

## Production verification

After an authorized dashboard change, run manifest validation, calculation tests, the host build, rendered-route checks, JSON-route checks, mobile-width checks, keyboard checks, and an accessibility scan. After an authorized deployment, verify the deployed route and source revision from outside the deployment. Packaging success alone is not route verification.
