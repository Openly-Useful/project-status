# Local compliance packet

Status: identity, licensing, policy, runtime-notice, package, namespace, and
founder-authorization inputs are implemented for release `1.2.1`. npm package
publication is authorized but has not been performed. Marketplace submission,
MCP Registry submission, hosted operation, and provider review remain separate
external actions. This packet is not legal advice.

## Publisher and ownership record

The repository mirrors the canonical Openly Useful publisher manifest in
`publisher/publisher.json`.

- Public publisher/developer brand: **Openly Useful**.
- Planned legal entity: **Openly Useful LLC**.
- Entity status: **formation-pending**.
- Current operator: **individual founder**, operating as Openly Useful.
- Planned entity roles: publisher, operator, and licensee.
- RunGlance authorship: **sole-author-confirmed**.
- RunGlance copyright: personally owned by the individual founder.
- Ownership transfer: **not required and not planned**.
- Current open-source publication: founder-authorized.
- Current npm package publication: directly founder-owner authorized while
  formation remains pending.
- Future LLC publication: authorization documentation pending until after
  formation.

Openly Useful LLC must not be described as already formed, as the current
operator, or as the RunGlance copyright owner. Its eventual
publisher/operator/licensee role does not depend on an assignment of ownership.
Sole authorship, personal ownership, and direct founder publication
authorization are owner-confirmed and do not depend on LLC formation.

## License and notices

The repository `LICENSE` is the unmodified Apache License 2.0 reference text.
The deterministic generator at `scripts/third-party-notices.mjs` covers the
pinned site and MCP runtime dependency graphs and emits
`THIRD_PARTY_NOTICES.md`.

| Area | Current local disposition |
| --- | --- |
| First-party source | Apache-2.0 reference text present and digest-checked. |
| Shipped site runtime | Six pinned runtime packages covered by generated MIT and OFL-1.1 notices. |
| Bundled MCP runtime | Three pinned runtime packages covered by generated notices. |
| Public policies | Privacy, terms, security, and support repository files link their canonical `.org` pages. |

Every deterministic archive must include `LICENSE`, `PRIVACY.md`, `TERMS.md`,
`SECURITY.md`, `SUPPORT.md`, and `THIRD_PARTY_NOTICES.md`.

## Canonical public metadata

Both component metadata files derive publisher fields from the Openly Useful
record while keeping Project Status and RunGlance as product names. Required
public endpoints are:

- publisher manifest: <https://openlyuseful.org/publisher/manifest.json>
- privacy: <https://openlyuseful.org/legal/privacy>
- terms: <https://openlyuseful.org/legal/terms>
- security: <https://openlyuseful.org/security>
- support: <https://openlyuseful.org/support>

Generated OpenAI manifests carry the product homepage, repository, license,
website, privacy, terms, and support values. Claude manifests carry the common
publisher, homepage, repository, and license values; their physical skill copy
also contains the canonical component metadata.

## npm publication gate

The fail-closed npm gate requires:

1. Direct founder-owner authorization effective during formation.
2. Exact `@openly-useful` package and `org.openlyuseful` MCP contracts.
3. Canonical public policy files and authority metadata.
4. Current license, notices, generated wrappers, tests, and deterministic plans.

npm account authentication is not part of the static readiness claim. The
registry enforces it separately at the actual publish request.

Provider review does not block npm. Marketplace, MCP Registry, deployment, and
future LLC operation each remain separately controlled. No IP assignment,
ownership transfer, or ownership verification appears in the npm gate.

## Completion criteria

`node scripts/release-check.mjs --json` must report `valid: true`,
`distributionReady: true`, and `publishReady: true`; both package
`prepublishOnly` scripts must pass without publishing. No local check creates or
authenticates an npm account, files an entity, submits a registry or marketplace
listing, or deploys a service.
