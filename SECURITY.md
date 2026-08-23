# Security policy

The canonical security page is <https://openlyuseful.org/security>.

## Report a vulnerability

Please report suspected vulnerabilities privately to
`hello@openlyuseful.org` with a `[Security]` subject tag. Include the affected component and version, a
minimal reproduction, impact, and any known mitigations. Do not include
credentials, private user data, or unrelated source material.

Please avoid public disclosure until the report has been acknowledged and a
reasonable remediation or coordinated-disclosure plan has been discussed.
Openly Useful does not currently offer a bug bounty or guaranteed response
time.

## Supported scope

Security fixes target the latest published release. Unreleased branches,
modified distributions, third-party hosts, global shell configuration, and
external MCP or marketplace infrastructure are outside this repository's
support boundary.

The bundled MCP companions are intended to remain local, read-only, bounded,
and closed-world. Reports involving unexpected writes, network access, secret
exposure, path disclosure, unsafe archive entries, or command execution are
especially useful.

Openly Useful LLC is the planned future publisher/operator/licensee, but its
formation is pending. No commercial security service or contractual response
commitment is currently active.
