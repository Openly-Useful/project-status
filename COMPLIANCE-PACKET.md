# Local compliance packet

Status: local identity, licensing, policy, and runtime-notice inputs are
implemented for release `1.2.0`. Public marketplace submission, package
publication, hosted operation, and business verification remain external
actions. This packet is not legal advice or publication authorization.

## Publisher and ownership record

The repository mirrors the canonical Openly Useful publisher manifest in
`publisher/publisher.json`.

- Public publisher/developer brand: **Openly Useful**.
- Planned legal entity: **Openly Useful LLC**.
- Entity status: **formation-pending**.
- Planned entity roles: publisher, operator, and licensee.
- RunGlance authorship: **sole-author-confirmed**.
- RunGlance copyright: personally owned by the individual founder.
- Ownership transfer: **not required and not planned**.
- Current open-source publication: founder-authorized.
- Future LLC publication: authorization documentation pending until after
  formation.

Openly Useful LLC must not be described as already formed or as the RunGlance
copyright owner. Its eventual publisher/operator/licensee role does not depend
on an assignment of ownership. Sole authorship and personal ownership are
owner-confirmed and are not public-activation gates.

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

## External gates

The release may be locally distribution-ready while public publication remains
blocked by external state:

1. Complete and verify Openly Useful LLC formation before identifying it as the
   active legal operator.
2. After formation, document the founder's authorization for LLC publication,
   and verify the public repository and every policy/support URL anonymously.
3. Complete provider business/developer verification and domain-namespace
   authentication.
4. Review the generated archives and checksums from the exact release commit.
5. Authorize each package publication, MCP Registry entry, marketplace
   submission, and deployment separately.

No IP assignment, ownership transfer, or ownership verification appears in
this gate list. The founder's personal ownership and sole authorship are already
confirmed, and transfer is neither required nor planned.

## Completion criteria

`node scripts/release-check.mjs --json` must report valid local inputs and
`distributionReady: true`. While the publisher manifest records
`formation-pending`, it must continue to report `publishReady: false` and an
`entity-and-external-verification` gate. No local check creates or verifies an
external account, entity filing, registry entry, marketplace listing, or
deployment.
