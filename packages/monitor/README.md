# Project Status monitor

A dependency-free, viewer-independent HTTP monitor for Node.js 20 or newer.

The module deliberately separates operations:

- `probeHttpTarget` performs one bounded network probe and never writes.
- `executeMonitorRun` probes and derives transitions without reading or writing a store.
- `recordRun` explicitly appends an existing record.
- `runAndRecord` is the explicit scheduler/CLI operation that probes and appends once.
- `readLatestRun` only reads persisted state and cannot trigger probes.

Targets use `{ id, name, url, method?, expectedStatus? }`. The default policy allows
only HTTP(S), resolves hostnames before fetch, pins the connection to an approved
DNS address, denies local/private/link-local/
multicast/reserved addresses, rejects credentials and redirects, aborts after five
seconds including DNS preflight, and reads at most 64 KiB. Controlled adapters and tests may explicitly inject
DNS, fetch, timers, clock, policy overrides, and a store.

The durable `JsonlRunStore` opens history in append mode, writes one JSON object per
line, and calls `fsync` before returning. The CLI never writes for `latest`; only the
explicit `run` and `record` commands append:

```sh
node packages/monitor/cli.mjs run --config monitor.json --history .project-status/monitor-runs.jsonl
node packages/monitor/cli.mjs latest --history .project-status/monitor-runs.jsonl
```

A production scheduler should invoke `run` on its own cadence. Serving a dashboard or
status API should call only the read side.
