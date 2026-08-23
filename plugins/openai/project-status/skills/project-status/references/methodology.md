# Evidence-backed status methodology

## Denominator and credit

- Keep one editable manifest as the weighted source of truth.
- Require phase weights to total 100 and task weights to total each phase weight.
- Bind the initiative identity and release in `initiative`; reports derive the readiness question from that release-scoped contract.
- Change weights only for material scope changes and disclose the denominator change.
- Give `complete` tasks full credit, `blocked` and `not_started` tasks zero credit, and `in_progress` tasks only explicit evidence-backed earned weight.
- Give incomplete external-approval tasks zero credit. Prepared submission work may be a separate task; it is not accepted approval.

Prefer evidence in this order:

1. Accepted approval, signed or immutable release, independent assessment, real-device end-to-end result, or measured production outcome.
2. Reproducible artifact digest, registry record, CI result, or externally observed endpoint.
3. Validated local build/test result plus reviewed implementation.
4. Prepared script, metadata, mock, or submission package.
5. Intent, activity, elapsed time, or assumption.

Never award a higher state from a lower evidence tier when a task requires the higher tier.

## Canonical records

- `phases[].tasks[]` owns status, weight, `earnedWeight`, nullable `remainingHours`, owner, next action, evidence requirements, and evidence/gate references.
- Global `evidence[]` owns typed evidence tier, state, visibility, assertion/public summary, timestamps, locator, integrity, and verifier. Credit-bearing task references must meet the declared tier/count and freshness requirement.
- Global `gates[]` owns typed satisfaction state, owner, next action, optional typed wait, and reciprocal task references. Uncleared referenced gates prohibit earned credit.
- `dependencies[]` is a typed edge list; referenced task IDs must exist and the graph must be acyclic.
- `source` records repository/build/deployment provenance. `audit` records the snapshot's evidence and verification basis.

## Time separation

- `remainingHours`: active hands-on range; `null` means unknown and must be reported as unknown, never converted to zero.
- `deferred`: separates that task's known range from active effort.
- `recurring`: operational work reported separately from one-time completion.
- `gates[].wait`: typed unknown, business-day, or duration-hour wait; never silently convert external/calendar wait to hands-on hours.
- Live observation duration or soak time belongs to monitoring state outside the 100-point manifest denominator.

## Freshness and timestamps

- `audit.evidenceAsOf` is the cutoff for evidence used by the manifest snapshot.
- `audit.verifiedAt` means a real weighted audit completed; it may be `null` for a proposal.
- `audit.nextDueAt` is an explicit next audit deadline; otherwise `audit.staleAfterSeconds` applies to the latest audit/evidence baseline.
- Evidence `capturedAt` and `verifiedAt` describe that evidence record; `expiresAt` makes evidence time-bounded when non-null.
- A monitor observation time describes only that one live check.
- When an audit finds no material evidence or status change, leave tracked files, commits, and deployments untouched.
- Never create or publish a status-only change whose sole material effect is advancing an audit or evidence timestamp.

Call the derived state **manifest freshness**. It does not prove that locators or services were checked at render time. Do not advance any timestamp merely because a dashboard rendered, a CLI validated JSON, a package built, or a browser refreshed.

## Confidence

Report uncertainty explicitly. Missing evidence, private evidence unavailable to the current agent, stale observations, unverified URLs, and unknown approval waits are limitations. A valid manifest is not proof that every evidence locator remains true.
