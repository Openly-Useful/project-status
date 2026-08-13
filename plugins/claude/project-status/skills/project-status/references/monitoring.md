# One-shot monitoring

The skill implements a bounded `monitor once`, not a daemon or scheduler.

- Validate the manifest before probing.
- Probe only checks supplied by the separately authorized monitoring configuration/runtime; live checks are not manifest schema fields.
- Apply the same URL credential, DNS, private-address, redirect, timeout, and concurrency protections as provenance verification.
- Return `operational`, `degraded`, `unavailable`, or `unknown` with an observation time and latency.
- Do not write observations unless a future command introduces a separately authorized recording operation.
- Do not retry indefinitely, fix code, restart services, deploy, notify people, or publish results.
- Keep live health and observation records outside the strict manifest and its 100-point readiness denominator.

Scheduling belongs to the host product, companion service, or CI. Configure it separately, with explicit frequency, duration, notification, and stop conditions. A browser refresh is not monitoring, and manifest freshness is not a live-health result.
