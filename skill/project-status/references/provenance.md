# Provenance verification

Use canonical global evidence records and reference them from tasks with `evidenceRefs`:

```json
{
  "id": "release-artifact",
  "kind": "artifact",
  "tier": "validated_local",
  "state": "current",
  "visibility": "internal",
  "assertion": "The release artifact passed the declared local verification.",
  "publicSummary": "A release artifact was locally validated.",
  "capturedAt": "2026-08-12T14:00:00.000Z",
  "verifiedAt": "2026-08-12T14:05:00.000Z",
  "expiresAt": null,
  "locator": {
    "type": "file",
    "path": "/absolute/path/to/release.json"
  },
  "integrity": {
    "algorithm": "sha256",
    "digest": "64-lowercase-hex-characters"
  },
  "verifier": {
    "type": "automation",
    "id": "release-checker",
    "label": "Release checker"
  }
}
```

Supported verification behavior:

- `file`: treat the absolute locator as private local evidence; verify existence/integrity only in an explicitly requested provenance operation and never expose the path publicly.
- `url`: validate safely offline; fetch only with explicit `--network`.
- `commit` and `artifact`: compare immutable identifiers or digests where the selected verifier supports them.
- `conversation`: report the declaration and limitations without inventing independent verification.

Network rules:

- Require HTTPS except intentional localhost fixtures with `--allow-localhost`.
- Reject URL credentials and secret-like query parameters.
- Block loopback, private, link-local, multicast, and unspecified addresses unless localhost was explicitly allowed.
- Resolve DNS before fetching and reject targets that resolve to blocked addresses.
- Bound timeout, redirects, response body use, and concurrency.
- Redact query strings from output.

`verify` is read-only. It never advances evidence timestamps or `audit.evidenceAsOf`/`audit.verifiedAt`. Treat stale, unverified, mismatched, missing, unsafe, and unreachable as distinct outcomes. Only an authorized manifest update after review may record new evidence or audit timestamps.
