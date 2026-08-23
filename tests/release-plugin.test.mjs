import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRelease, externalActivationSatisfied, validateCompanionVersions, validateMcpDistributionIdentity } from "../scripts/release-check.mjs";
import { bundledEntrypointErrors, inspectReleaseState, publisherErrors } from "../scripts/release-sync.mjs";

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
  assert.equal(codex.interface.displayName, "Openly Useful");
  assert.deepEqual(codex.plugins.map((plugin) => plugin.name), ["project-status", "runglance"]);
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
  assert.deepEqual(claude.owner, {
    email: "hello@openlyuseful.org",
    name: "Openly Useful",
    url: "https://openlyuseful.org",
  });
  assert.deepEqual(claude.plugins.map((plugin) => plugin.name), ["project-status", "runglance"]);
  assert.equal(claude.plugins[0].source, "./plugins/claude/project-status");
  assert.equal(claude.plugins[0].strict, true);
  assert.equal(claude.plugins[0].version, version);
});

test("both products agree on publisher, policy URLs, version, and real MCP companions", () => {
  const builtMcp = existsSync(join(root, "packages", "mcp", "dist", "index.js"));

  for (const product of ["project-status", "runglance"]) {
    const openaiRoot = join(root, "plugins", "openai", product);
    const claudeRoot = join(root, "plugins", "claude", product);
    const openai = json(join(openaiRoot, ".codex-plugin", "plugin.json"));
    const claude = json(join(claudeRoot, ".claude-plugin", "plugin.json"));
    const productMcp = product === "project-status"
      ? builtMcp
      : existsSync(join(root, "packages", "mcp", "dist", "runglance-index.js"));

    for (const manifest of [openai, claude]) {
      assert.equal(manifest.version, version);
      assert.equal(manifest.skills, "./skills/");
      assert.equal(manifest.author.name, "Openly Useful");
      assert.equal(manifest.author.email, "hello@openlyuseful.org");
      assert.equal(manifest.homepage, "https://github.com/Openly-Useful/project-status");
      assert.equal(manifest.repository, "https://github.com/Openly-Useful/project-status");
      assert.equal(manifest.license, "Apache-2.0");
      assert.equal("mcpServers" in manifest, productMcp);
    }
    assert.equal(openai.interface.developerName, "Openly Useful");
    assert.equal(openai.interface.privacyPolicyURL, "https://openlyuseful.org/legal/privacy");
    assert.equal(openai.interface.termsOfServiceURL, "https://openlyuseful.org/legal/terms");
    assert.equal(openai.interface.securityURL, undefined);
    assert.equal(openai.interface.supportURL, "https://openlyuseful.org/support");

    for (const pluginRoot of [openaiRoot, claudeRoot]) {
      walk(pluginRoot);
      assert.equal(statSync(join(pluginRoot, "skills", product, "SKILL.md")).isFile(), true);
      if (productMcp) {
        assert.equal(statSync(join(pluginRoot, ".mcp.json")).isFile(), true);
        assert.equal(statSync(join(pluginRoot, "mcp", "dist", "index.js")).isFile(), true);
        assert.equal(existsSync(join(pluginRoot, "package.json")), false);
        assert.equal(existsSync(join(pluginRoot, "package-lock.json")), false);
        assert.deepEqual(readdirSync(join(pluginRoot, "mcp", "dist")), ["index.js"]);
        if (product === "project-status") assert.equal(statSync(join(pluginRoot, "core", "index.mjs")).isFile(), true);
      } else {
        assert.equal(existsSync(join(pluginRoot, ".mcp.json")), false);
        assert.equal(existsSync(join(pluginRoot, "mcp")), false);
      }
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

test("release check separates local distribution readiness from external activation", () => {
  const result = checkRelease();
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.distributionReady, true);
  assert.equal(result.version, version);
  assert.deepEqual(result.companionVersions, {
    mcp: version,
    monitor: version,
    "runglance-mcp": version,
  });
  assert.deepEqual(result.mcpDistributions, {
    projectStatus: {
      mcpName: "org.openlyuseful/project-status",
      packageName: "@openly-useful/project-status-mcp",
      version,
    },
    runGlance: {
      mcpName: "org.openlyuseful/runglance",
      packageName: "@openly-useful/runglance-mcp",
      version,
    },
  });
  assert.deepEqual(Object.keys(result.archives).sort(), ["claude", "openai", "portable"]);
  assert.deepEqual(Object.keys(result.runGlanceArchives).sort(), ["claude", "openai", "portable"]);
  const licenseGate = result.releaseGates.find((gate) => gate.id === "apache-2.0-license");
  const noticesGate = result.releaseGates.find((gate) => gate.id === "third-party-notices");
  const policyGate = result.releaseGates.find((gate) => gate.id === "public-policy-files");
  const publisherGate = result.releaseGates.find((gate) => gate.id === "publisher-contract");
  const founderGate = result.releaseGates.find((gate) => gate.id === "founder-record-and-open-source-authorization");
  const externalGate = result.releaseGates.find((gate) => gate.id === "entity-and-external-verification");
  for (const gate of [licenseGate, noticesGate, policyGate, publisherGate, founderGate]) {
    assert.equal(gate?.status, "satisfied", JSON.stringify(gate));
  }
  assert.equal(externalGate?.status, "pending_external_verification");
  assert.match(externalGate.detail, /IP assignment, ownership transfer, and ownership verification are not required/);
  assert.equal(result.publishReady, false);
});

test("publisher activation is fail-closed until every blocker is cleared", () => {
  const pending = json(join(root, "publisher", "publisher.json"));
  assert.equal(externalActivationSatisfied(pending), false);
  assert.deepEqual(publisherErrors(pending), []);

  const active = structuredClone(pending);
  active.legal.status = "active";
  active.legal.activeName = active.legal.plannedName;
  active.repositoryContext.futureEntityPublishing = "documented";
  active.publication.externalPublicationAllowed = true;
  active.publication.authorization = "authorized";
  active.publication.blockingRequirements = [];
  assert.deepEqual(publisherErrors(active), []);
  assert.equal(externalActivationSatisfied(active), true);

  active.publication.blockingRequirements = ["namespace-verification"];
  assert.equal(externalActivationSatisfied(active), false);
  assert.match(publisherErrors(active).join("\n"), /requires all blocking requirements to be cleared/);
});

test("npm publication entry points invoke the canonical fail-closed release assertion", () => {
  for (const packagePath of ["packages/mcp/package.json", "packages/runglance-mcp/package.json"]) {
    assert.equal(json(join(root, packagePath)).scripts.prepublishOnly, "node ../../scripts/assert-publish-ready.mjs");
  }
  const result = spawnSync(process.execPath, [join(root, "scripts", "assert-publish-ready.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PUBLICATION BLOCKED/);
  assert.match(result.stderr, /entity-and-external-verification: pending_external_verification/);
});

test("release check rejects companion package version drift", (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "project-status-release-versions-"));
  context.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  for (const [companion, packageVersion] of [["mcp", version], ["monitor", "0.0.0"], ["runglance-mcp", version]]) {
    const packageRoot = join(fixtureRoot, "packages", companion);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ version: packageVersion })}\n`, "utf8");
  }

  const errors = [];
  assert.deepEqual(validateCompanionVersions(version, errors, fixtureRoot), {
    mcp: version,
    monitor: "0.0.0",
    "runglance-mcp": version,
  });
  assert.deepEqual(errors, [
    `packages/monitor/package.json version "0.0.0" differs from VERSION ${version}`,
  ]);
});

test("MCP package and registry sources agree on Openly Useful identities and release version", () => {
  const errors = [];
  assert.deepEqual(validateMcpDistributionIdentity(version, errors), {
    projectStatus: {
      packageName: "@openly-useful/project-status-mcp",
      mcpName: "org.openlyuseful/project-status",
      version,
    },
    runGlance: {
      packageName: "@openly-useful/runglance-mcp",
      mcpName: "org.openlyuseful/runglance",
      version,
    },
  });
  assert.deepEqual(errors, []);
});

test("release validation rejects MCP package and registry identity drift", (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "project-status-mcp-identity-"));
  context.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  for (const [component, packageDirectory, packageName, mcpName] of [
    ["project-status", "mcp", "@openly-useful/project-status-mcp", "org.openlyuseful/project-status"],
    ["runglance", "runglance-mcp", "@openly-useful/runglance-mcp", "org.openlyuseful/runglance"],
  ]) {
    mkdirSync(join(fixtureRoot, "packages", packageDirectory), { recursive: true });
    mkdirSync(join(fixtureRoot, "mcp-registry", component), { recursive: true });
    writeFileSync(join(fixtureRoot, "packages", packageDirectory, "package.json"), `${JSON.stringify({
      name: packageName,
      version,
      mcpName,
      license: "Apache-2.0",
      repository: { url: "git+https://github.com/Openly-Useful/project-status.git" },
      bugs: "https://openlyuseful.org/support",
    })}\n`);
    writeFileSync(join(fixtureRoot, "mcp-registry", component, "server.json"), `${JSON.stringify({
      name: mcpName,
      version,
      repository: { url: "https://github.com/Openly-Useful/project-status", source: "github" },
      packages: [{ registryType: "npm", identifier: packageName, version, transport: { type: "stdio" } }],
    })}\n`);
  }
  const runglanceRegistry = join(fixtureRoot, "mcp-registry", "runglance", "server.json");
  const drifted = JSON.parse(readFileSync(runglanceRegistry, "utf8"));
  drifted.packages[0].identifier = "@wrong/runglance";
  writeFileSync(runglanceRegistry, `${JSON.stringify(drifted)}\n`);

  const errors = [];
  const identities = validateMcpDistributionIdentity(version, errors, fixtureRoot);
  assert.equal(identities.projectStatus.mcpName, "org.openlyuseful/project-status");
  assert.equal(identities.runGlance.packageName, "@openly-useful/runglance-mcp");
  assert.deepEqual(errors, ["runGlance registry package identifier must match the package name"]);
});

test("release sync rejects MCP entrypoints with post-install runtime imports", () => {
  const unsafe = `#!/usr/bin/env node\nimport "@modelcontextprotocol/server";\nconst core = new URL("../../core/index.mjs", import.meta.url);\n`;
  assert.deepEqual(bundledEntrypointErrors(unsafe), [
    "MCP dist/index.js has an unbundled runtime import: @modelcontextprotocol/server",
  ]);
});
