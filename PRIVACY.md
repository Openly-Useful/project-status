# Privacy

Effective: August 16, 2026

This policy covers the open-source Project Status and RunGlance software in
this repository. The canonical policy is published at
<https://openlyuseful.org/legal/privacy>.

## Local operation

The repository does not provide a hosted account service. The Project Status
skill reads repository-local status material. RunGlance records bounded,
normalized lifecycle data in a local runtime directory selected by the user or
host. The core tools do not require an API key, analytics service, remote
database, or Openly Useful account.

RunGlance is designed not to store prompts, responses, transcripts,
environment-variable values, credentials, raw tool arguments, or source-file
contents. It may store local identifiers, lifecycle states, timestamps,
progress values, explicit lock observations, bounded verification output, and
final receipts. Local files remain under the user's control and can be removed
with the documented purge command.

The optional MCP companions are local, read-only query surfaces. Their public
projections omit or redact commands, rerun arguments, output, credentials,
environment data, private paths, and other non-public source fields.

## Hosts and external services

Installing a plugin or using an agent host may cause that host to process data
under its own terms and privacy policy. This repository does not control a
host's logging, model processing, retention, or account behavior. Review the
host and plugin permissions before installation.

No hosted RunGlance or Project Status service, paid marketplace offer, or
commercial account operation is active under this repository policy. Openly
Useful LLC is the planned future publisher/operator/licensee, but its formation
is pending. Before commercial or hosted activation, the canonical policy will
identify the active legal operator and any additional processing.

## Questions

Privacy and support questions may be directed through
<https://openlyuseful.org/support> or `hello@openlyuseful.org` with a
`[Privacy]` subject tag.
