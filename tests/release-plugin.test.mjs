import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRelease, validateCompanionVersions } from "../scripts/release-check.mjs";
import { bundledEntrypointErrors, inspectReleaseState } from "../scripts/release-sync.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = readFileSync(join(root, "VERSION"), "utf8").trim();

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(rootPath) {
  const files = [];
  for (const entry of readdirSync(rootPath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(rootPath, entry.name);
    assert.equal(lstatSync(path).isSymbolicLink(), false, `generated wrapper contains a symlink: ${path}`);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("Codex and Claude marketplaces use distinct current host schemas", () => {
  const codex = json(join(root, ".agents", "plugins", "marketplace.json"));
  const claude = json(join(root, ".claude-plugin", "marketplace.json"));

  assert.deepEqual(Object.keys(codex).sort(), ["interface", "name", "plugins"]);
  assert.equal(codex.name, "project-status-initiative");
  assert.deepEqual(codex.plugins[0].source, {
    path: "./plugins/openai/project-status",
    source: "local",
  });
  assert.deepEqual(codex.plugins[0].policy, {
    authentication: "ON_INSTALL",
    installation: "AVAILABLE",
  });

  assert.equal(claude.$schema, "https://json.schemastore.org/claude-code-marketplace.json");
  assert.equal(claude.name, "project-status-initiative");
  assert.equal(claude.owner.name, "Project Status Initiative");
  assert.equal(claude.plugins[0].source, "./plugins/claude/project-status");
  assert.equal(claude.plugins[0].strict, true);
  assert.equal(claude.plugins[0].version, version);
});

test("plugin manifests agree on version and only declare a real MCP companion", () => {
  const openaiRoot = join(root, "plugins", "openai", "project-status");
  const claudeRoot = join(root, "plugins", "claude", "project-status");
  const openai = json(join(openaiRoot, ".codex-plugin", "plugin.json"));
  const claude = json(join(claudeRoot, ".claude-plugin", "plugin.json"));
  const builtMcp = existsSync(join(root, "packages", "mcp", "dist", "index.js"));

  assert.equal(openai.version, version);
  assert.equal(claude.version, version);
  assert.equal(openai.skills, "./skills/");
  assert.equal(claude.skills, "./skills/");
  assert.equal("mcpServers" in openai, builtMcp);
  assert.equal("mcpServers" in claude, builtMcp);

  for (const pluginRoot of [openaiRoot, claudeRoot]) {
    walk(pluginRoot);
    assert.equal(statSync(join(pluginRoot, "skills", "project-status", "SKILL.md")).isFile(), true);
    if (builtMcp) {
      assert.equal(statSync(join(pluginRoot, ".mcp.json")).isFile(), true);
      assert.equal(statSync(join(pluginRoot, "mcp", "dist", "index.js")).isFile(), true);
      assert.equal(statSync(join(pluginRoot, "core", "index.mjs")).isFile(), true);
      assert.equal(existsSync(join(pluginRoot, "package.json")), false);
      assert.equal(existsSync(join(pluginRoot, "package-lock.json")), false);
      assert.deepEqual(readdirSync(join(pluginRoot, "mcp", "dist")), ["index.js"]);
    } else {
      assert.equal(existsSync(join(pluginRoot, ".mcp.json")), false);
      assert.equal(existsSync(join(pluginRoot, "mcp")), false);
    }
  }
});

test("release sync check is read-only and clean", () => {
  const before = inspectReleaseState();
  assert.equal(before.valid, true, before.errors.join("\n"));
  const checked = spawnSync(process.execPath, [join(root, "scripts", "release-sync.mjs"), "check", "--json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.written, []);
  const after = inspectReleaseState();
  assert.equal(after.actualFileCount, before.actualFileCount);
  assert.equal(after.valid, true, after.errors.join("\n"));
});

test("release check separates distributable packages from owner publication decisions", () => {
  const result = checkRelease();
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.distributionReady, true);
  assert.equal(result.version, version);
  assert.deepEqual(result.companionVersions, {
    mcp: version,
    monitor: version,
  });
  assert.deepEqual(Object.keys(result.archives).sort(), ["claude", "openai", "portable"]);
  const licenseGate = result.releaseGates.find((gate) => gate.id === "license-selection");
  const publisherGate = result.releaseGates.find((gate) => gate.id === "publisher-metadata");
  assert.ok(licenseGate);
  assert.ok(publisherGate);
  if (!existsSync(join(root, "LICENSE"))) assert.equal(licenseGate.status, "pending_owner_decision");
  assert.equal(publisherGate.status, "pending_owner_decision");
  assert.equal(result.publishReady, false);
});

test("release check rejects companion package version drift", (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "project-status-release-versions-"));
  context.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  for (const [companion, packageVersion] of [["mcp", version], ["monitor", "0.0.0"]]) {
    const packageRoot = join(fixtureRoot, "packages", companion);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ version: packageVersion })}\n`, "utf8");
  }

  const errors = [];
  assert.deepEqual(validateCompanionVersions(version, errors, fixtureRoot), {
    mcp: version,
    monitor: "0.0.0",
  });
  assert.deepEqual(errors, [
    `packages/monitor/package.json version "0.0.0" differs from VERSION ${version}`,
  ]);
});

test("release sync rejects MCP entrypoints with post-install runtime imports", () => {
  const unsafe = `#!/usr/bin/env node\nimport "@modelcontextprotocol/server";\nconst core = new URL("../../core/index.mjs", import.meta.url);\n`;
  assert.deepEqual(bundledEntrypointErrors(unsafe), [
    "MCP dist/index.js has an unbundled runtime import: @modelcontextprotocol/server",
  ]);
});
