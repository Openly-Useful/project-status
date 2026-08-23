import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalSkillRoot,
  expectedPluginManifests,
  inspectReleaseState,
} from "../scripts/release-sync.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = join(root, "skill", "project-status");

function walk(directory) {
  const output = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) output.push(...walk(path));
    else output.push(path);
  }
  return output;
}

function projectStatusSkillRoots(directory, relativeDirectory = "") {
  const ignoredDirectories = new Set([".git", "artifacts", "dist", "node_modules"]);
  const roots = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) roots.push(...projectStatusSkillRoots(path, relativePath));
    else if (entry.isFile() && entry.name === "SKILL.md" && /^name: project-status$/m.test(readFileSync(path, "utf8"))) {
      roots.push(relativePath.split(sep).join("/"));
    }
  }
  return roots.sort();
}

test("the repository has one editable canonical Project Status skill and two generated host wrappers", () => {
  assert.equal(resolve(canonicalSkillRoot), resolve(skillRoot));
  assert.deepEqual(projectStatusSkillRoots(root), [
    "plugins/claude/project-status/skills/project-status/SKILL.md",
    "plugins/openai/project-status/skills/project-status/SKILL.md",
    "skill/project-status/SKILL.md",
  ]);
  assert.equal(existsSync(join(root, ".agent-skills", "project-status", "SKILL.md")), false);
  assert.equal(existsSync(join(root, ".agents", "skills", "project-status", "SKILL.md")), false);
  assert.equal(existsSync(join(root, ".claude", "skills", "project-status", "SKILL.md")), false);
});

test("portable SKILL frontmatter has only name and description", () => {
  const contents = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md must start with closed YAML frontmatter");
  const keys = match[1].split("\n").filter(Boolean).map((line) => line.match(/^([a-z-]+):/)?.[1]);
  assert.deepEqual(keys, ["name", "description"]);
  assert.match(match[1], /^name: project-status$/m);
  assert.match(match[1], /description: .*dashboard/i);
});

test("OpenAI metadata stays outside portable frontmatter and preserves safety wording", () => {
  const yaml = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");
  assert.match(yaml, /display_name: "Project Status"/);
  assert.match(yaml, /\$project-status/);
  assert.doesNotMatch(yaml, /publish/i);
  assert.match(yaml, /allow_implicit_invocation: true/);
});

test("both source wrapper manifests derive from one package metadata document", () => {
  const metadata = JSON.parse(readFileSync(join(skillRoot, "assets", "package-metadata.json"), "utf8"));
  const state = inspectReleaseState();
  assert.equal(state.valid, true, state.errors.join("\n"));
  const expected = expectedPluginManifests(metadata, { mcpEnabled: state.mcpIncluded });
  const openai = JSON.parse(readFileSync(join(root, "plugins", "openai", "project-status", ".codex-plugin", "plugin.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(root, "plugins", "claude", "project-status", ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(openai, expected.openai);
  assert.deepEqual(claude, expected.claude);
  assert.equal(openai.version, claude.version);
  assert.equal(openai.skills, "./skills/");
  assert.equal(claude.skills, "./skills/");
  assert.equal("mcpServers" in openai, state.mcpIncluded);
  assert.equal("mcpServers" in claude, state.mcpIncluded);
});

test("generated wrapper skills are physical byte-for-byte canonical copies", () => {
  const canonicalFiles = walk(skillRoot).map((path) => path.slice(skillRoot.length + 1)).sort();
  for (const host of ["openai", "claude"]) {
    const wrapperRoot = join(root, "plugins", host, "project-status", "skills", "project-status");
    assert.equal(statSync(wrapperRoot).isDirectory(), true);
    const wrapperFiles = walk(wrapperRoot).map((path) => path.slice(wrapperRoot.length + 1)).sort();
    assert.deepEqual(wrapperFiles, canonicalFiles);
    for (const relativePath of canonicalFiles) {
      assert.equal(
        readFileSync(join(wrapperRoot, relativePath)).equals(readFileSync(join(skillRoot, relativePath))),
        true,
        `${host} wrapper drifted at ${relativePath}`,
      );
    }
  }
});

test("skill runtime has required commands and no embedded user-home paths or tests", () => {
  const expectedScripts = ["attach.mjs", "dashboard.mjs", "monitor.mjs", "package.mjs", "provenance.mjs", "status.mjs"];
  for (const script of expectedScripts) assert.equal(statSync(join(skillRoot, "scripts", script)).isFile(), true);
  const forbidden = [`/${"Users"}/`, `/${"home"}/`, `${"C:"}\\${"Users"}\\`];
  for (const path of walk(skillRoot)) {
    const relativePath = path.slice(skillRoot.length + 1);
    assert.doesNotMatch(relativePath, /(?:^|\/)tests?(?:\/|$)|\.test\./);
    const contents = readFileSync(path, "utf8");
    for (const prefix of forbidden) assert.equal(contents.includes(prefix), false, `${relativePath} embeds ${prefix}`);
  }
});

test("skill contract makes publishing and scheduling separate actions", () => {
  const contents = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
  assert.match(contents, /Default to read-only inspection/);
  assert.match(contents, /commit, push, deployment, global installation, scheduling, marketplace registration/);
  assert.match(contents, /never edits the manifest or advances timestamps/i);
  assert.match(contents, /does not cache, record, schedule, retry indefinitely, fix, deploy, or publish/i);
});
