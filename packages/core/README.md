# Project Status core

Dependency-free, pure ESM utilities for the initiative manifest.

```js
import {
  validateManifest,
  calculateStatus,
  createPublicProjection,
  canonicalize,
  sha256,
  criticalPath,
} from "./packages/core/index.mjs";
```

- `validateManifest(manifest, { throwOnError?, now?, clock? })` returns `{ valid, errors }` and rejects unknown fields. With `throwOnError`, it throws `ManifestValidationError`.
- `calculateStatus(manifest, { now?, clock? })` derives score and independent evidence/audit freshness without changing earned historical credit.
- `createPublicProjection(manifest, { now?, clock? })` constructs an allowlisted public view; filesystem and conversation locators and internal IDs are omitted.
- `canonicalize(value)` emits deterministic JSON for a strict JSON value.
- `sha256(value)` hashes the canonical JSON bytes using a browser-compatible implementation.
- `criticalPath(manifest)` returns an explicit indeterminate result while any active task lacks an estimate.

No function reads the filesystem, network, environment, or wall clock. Consumers inject `now` or `clock`; otherwise the audit evidence timestamp is the deterministic reference instant.
