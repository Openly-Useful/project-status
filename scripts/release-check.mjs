#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPackagePlan } from "./package-skill.mjs";
import { inspectReleaseState, releaseRoot } from "./release-sync.mjs";

const ALLOWED_INSTALLATION = new Set(["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]);
const ALLOWED_AUTHENTICATION = new Set(["ON_INSTALL", "ON_USE"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function exactKeys(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${label} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function nonEmptyString(value, label, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} must be a non-empty string`);
}

function validateCodexMarketplace(value, errors) {
  exactKeys(value, ["interface", "name", "plugins"], "Codex marketplace", errors);
  nonEmptyString(value?.name, "Codex marketplace name", errors);
  exactKeys(value?.interface, ["displayName"], "Codex marketplace interface", errors);
  nonEmptyString(value?.interface?.displayName, "Codex marketplace interface.displayName", errors);
  if (!Array.isArray(value?.plugins) || value.plugins.length !== 1) {
    errors.push("Codex marketplace must contain exactly one plugin entry");
    return;
  }
  const plugin = value.plugins[0];
  exactKeys(plugin, ["category", "name", "policy", "source"], "Codex marketplace plugin", errors);
  if (plugin.name !== "project-status") errors.push("Codex marketplace plugin name must be project-status");
  nonEmptyString(plugin.category, "Codex marketplace plugin category", errors);
  exactKeys(plugin.source, ["path", "source"], "Codex marketplace plugin source", errors);
  if (plugin.source?.source !== "local") errors.push("Codex marketplace plugin source.source must be local");
  if (plugin.source?.path !== "./plugins/openai/project-status") errors.push("Codex marketplace plugin source.path must target the OpenAI wrapper");
  exactKeys(plugin.policy, ["authentication", "installation"], "Codex marketplace plugin policy", errors);
  if (!ALLOWED_INSTALLATION.has(plugin.policy?.installation)) errors.push("Codex marketplace installation policy is invalid");
  if (!ALLOWED_AUTHENTICATION.has(plugin.policy?.authentication)) errors.push("Codex marketplace authentication policy is invalid");
}

function validateClaudeMarketplace(value, version, errors) {
  exactKeys(value, ["$schema", "description", "name", "owner", "plugins", "version"], "Claude marketplace", errors);
  if (value?.$schema !== "https://json.schemastore.org/claude-code-marketplace.json") errors.push("Claude marketplace $schema is invalid");
  nonEmptyString(value?.name, "Claude marketplace name", errors);
  nonEmptyString(value?.description, "Claude marketplace description", errors);
  if (value?.version !== version) errors.push("Claude marketplace version differs from VERSION");
  exactKeys(value?.owner, ["name"], "Claude marketplace owner", errors);
  nonEmptyString(value?.owner?.name, "Claude marketplace owner.name", errors);
  if (!Array.isArray(value?.plugins) || value.plugins.length !== 1) {
    errors.push("Claude marketplace must contain exactly one plugin entry");
    return;
  }
  const plugin = value.plugins[0];
  exactKeys(plugin, ["author", "category", "description", "name", "source", "strict", "version"], "Claude marketplace plugin", errors);
  if (plugin.name !== "project-status") errors.push("Claude marketplace plugin name must be project-status");
  if (plugin.source !== "./plugins/claude/project-status") errors.push("Claude marketplace plugin source must target the Claude wrapper");
  if (plugin.strict !== true) errors.push("Claude marketplace plugin must use strict manifest mode");
  if (plugin.version !== version) errors.push("Claude marketplace plugin version differs from VERSION");
  nonEmptyString(plugin.description, "Claude marketplace plugin description", errors);
  nonEmptyString(plugin.category, "Claude marketplace plugin category", errors);
  exactKeys(plugin.author, ["name"], "Claude marketplace plugin author", errors);
  nonEmptyString(plugin.author?.name, "Claude marketplace plugin author.name", errors);
}

function validatePluginManifest(value, host, version, mcpIncluded, errors) {
  const common = ["author", "description", "name", "skills", "version"];
  const keys = host === "openai" ? [...common, "interface"] : common;
  if (mcpIncluded) keys.push("mcpServers");
  exactKeys(value, keys, `${host} plugin manifest`, errors);
  if (value?.name !== "project-status") errors.push(`${host} plugin manifest name must be project-status`);
  if (value?.version !== version || !SEMVER.test(value?.version ?? "")) errors.push(`${host} plugin manifest version differs from VERSION`);
  if (value?.skills !== "./skills/") errors.push(`${host} plugin manifest skills must be ./skills/`);
  nonEmptyString(value?.description, `${host} plugin manifest description`, errors);
  exactKeys(value?.author, ["name"], `${host} plugin manifest author`, errors);
  nonEmptyString(value?.author?.name, `${host} plugin manifest author.name`, errors);
  if (mcpIncluded && value?.mcpServers !== "./.mcp.json") errors.push(`${host} plugin manifest mcpServers must target ./.mcp.json`);
  if (!mcpIncluded && "mcpServers" in (value ?? {})) errors.push(`${host} plugin manifest cannot declare MCP without a built companion`);
  if (host === "openai") {
    const required = ["capabilities", "category", "defaultPrompt", "developerName", "displayName", "longDescription", "shortDescription"];
    exactKeys(value?.interface, required, "OpenAI plugin interface", errors);
    for (const key of required.filter((key) => key !== "capabilities" && key !== "defaultPrompt")) {
      nonEmptyString(value?.interface?.[key], `OpenAI plugin interface.${key}`, errors);
    }
    if (!Array.isArray(value?.interface?.capabilities) || !value.interface.capabilities.every((item) => typeof item === "string" && item.trim())) {
      errors.push("OpenAI plugin interface.capabilities must be an array of strings");
    }
    if (!Array.isArray(value?.interface?.defaultPrompt) || value.interface.defaultPrompt.length < 1 || value.interface.defaultPrompt.length > 3) {
      errors.push("OpenAI plugin interface.defaultPrompt must contain one to three prompts");
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateCompanionVersions(version, errors, root = releaseRoot) {
  const versions = {};
  for (const companion of ["mcp", "monitor"]) {
    const packagePath = join(root, "packages", companion, "package.json");
    if (!existsSync(packagePath)) continue;
    try {
      const packageVersion = readJson(packagePath)?.version;
      versions[companion] = packageVersion ?? null;
      if (packageVersion !== version) {
        errors.push(`packages/${companion}/package.json version ${JSON.stringify(packageVersion)} differs from VERSION ${version}`);
      }
    } catch (error) {
      versions[companion] = null;
      errors.push(`packages/${companion}/package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return versions;
}

function releaseGates(metadata) {
  const licensePath = join(releaseRoot, "LICENSE");
  const licenseSelected = existsSync(licensePath) && statSync(licensePath).isFile() && readFileSync(licensePath, "utf8").trim().length > 0;
  const publisherIdentified = Boolean(
    metadata?.author?.name
    && (metadata.author.url || metadata.homepage || metadata.repository),
  );
  return [
    {
      id: "license-selection",
      status: licenseSelected ? "satisfied" : "pending_owner_decision",
      detail: licenseSelected
        ? "LICENSE is present."
        : "Choose the legal license before public distribution; no license was selected automatically.",
    },
    {
      id: "publisher-metadata",
      status: publisherIdentified ? "satisfied" : "pending_owner_decision",
      detail: publisherIdentified
        ? "Publisher metadata includes a public identity URL."
        : "Confirm the publisher identity and public repository/homepage URLs before publication.",
    },
  ];
}

export function checkRelease() {
  const release = inspectReleaseState();
  const packagePlan = createPackagePlan();
  const errors = [...release.errors, ...packagePlan.errors];
  const companionVersions = validateCompanionVersions(release.version, errors);
  if (release.marketplaces) {
    validateCodexMarketplace(release.marketplaces.openai, errors);
    validateClaudeMarketplace(release.marketplaces.claude, release.version, errors);
  }
  if (release.manifests) {
    validatePluginManifest(release.manifests.openai, "openai", release.version, release.mcpIncluded, errors);
    validatePluginManifest(release.manifests.claude, "claude", release.version, release.mcpIncluded, errors);
  }
  const changelogPath = join(releaseRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) errors.push("CHANGELOG.md is missing");
  else if (!readFileSync(changelogPath, "utf8").includes(`## ${release.version}`)) errors.push(`CHANGELOG.md has no ${release.version} release heading`);
  const readmePath = join(releaseRoot, "README.md");
  if (!existsSync(readmePath)) errors.push("README.md is missing");
  else {
    const readme = readFileSync(readmePath, "utf8");
    if (!readme.includes("skill/project-status")) errors.push("README.md must identify the canonical skill source");
    if (!readme.includes("release-sync.mjs")) errors.push("README.md must document generated-wrapper synchronization");
  }
  const gates = releaseGates(release.metadata);
  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    distributionReady: uniqueErrors.length === 0,
    publishReady: uniqueErrors.length === 0 && gates.every((gate) => gate.status === "satisfied"),
    version: release.version,
    companionVersions,
    mcpIncluded: release.mcpIncluded,
    wrapperFileCount: release.actualFileCount,
    archives: Object.fromEntries(Object.entries(packagePlan.archives).map(([kind, archive]) => [kind, {
      file: archive.name,
      sha256: archive.sha256,
      size: archive.size,
      entryCount: archive.entries.length,
    }])),
    releaseGates: gates,
    errors: uniqueErrors,
  };
}

function format(result) {
  return [
    `RELEASE CHECK ${result.valid ? "OK" : "FAILED"}`,
    `Version: ${result.version ?? "unknown"}`,
    `Distribution packages: ${result.distributionReady ? "ready" : "not ready"}`,
    `Public publication: ${result.publishReady ? "ready" : "waiting on owner decisions"}`,
    `MCP companion: ${result.mcpIncluded ? "included" : "not built; omitted"}`,
    ...result.releaseGates.map((gate) => `- ${gate.id}: ${gate.status} — ${gate.detail}`),
    ...result.errors.map((error) => `ERROR: ${error}`),
    "No files were changed, installed, or published.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== "--json")) throw new Error("Usage: release-check.mjs [--json]");
  const result = checkRelease();
  process.stdout.write(`${argv.includes("--json") ? JSON.stringify(result, null, 2) : format(result)}\n`);
  return result.valid ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
