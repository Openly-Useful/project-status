# Local packaging

The package builder stages three deterministic archives:

- `project-status-portable-claude-skill.zip`: portable `project-status/` skill folder for direct Claude attachment or upload and host-neutral repository use.
- `project-status-openai-plugin.zip`: OpenAI plugin with `.codex-plugin/plugin.json` and `skills/project-status/`.
- `project-status-claude-plugin.zip`: Claude plugin with `.claude-plugin/plugin.json` and `skills/project-status/`.

The runtime allowlist includes `SKILL.md`, `agents/`, `assets/`, `references/`, and `scripts/`. It rejects symlinks, traversal, absolute archive paths, user-home paths embedded in text, tests, temporary files, and unexpected top-level entries.

Every archive contains `MANIFEST.sha256`, and the output directory contains `checksums.json`. File ordering, timestamps, modes, JSON formatting, and ZIP encoding are deterministic. `plan` and `verify` are read-only. `build` writes only the requested output directory and refuses existing artifacts unless `--replace` is explicit.

Building an archive does not install it, add a marketplace entry, register it with a host, upload it, or publish it.
