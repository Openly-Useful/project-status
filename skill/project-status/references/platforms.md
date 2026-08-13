# Codex and Claude attachment

Repository attachment uses one canonical runtime copy:

```text
.agent-skills/project-status/
.agents/skills/project-status
.claude/skills/project-status
```

Use repository-relative symlinks when supported. Use copy mode for Windows, archives, or tools that do not preserve symlinks. `verify` compares deterministic runtime-tree digests so copied discovery folders cannot drift silently.

Attachment never writes personal/global skill directories, marketplace files, product settings, hooks, schedules, commits, or remote services. Existing targets are conflicts, not overwrite invitations.

Plugin archives contain copied runtime files and no external symlinks. The OpenAI plugin uses `.codex-plugin/plugin.json`; the Claude plugin uses `.claude-plugin/plugin.json`. Both contain `skills/project-status/SKILL.md` and derive their version from the same package metadata.
