#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPackagePlan as createRunGlancePackagePlan } from "./package-runglance.mjs";
import { createPackagePlan } from "./package-skill.mjs";
import { inspectReleaseState, publisherErrors, releaseRoot } from "./release-sync.mjs";
import { createThirdPartyNoticePlan } from "./third-party-notices.mjs";

const ALLOWED_INSTALLATION = new Set(["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]);
const ALLOWED_AUTHENTICATION = new Set(["ON_INSTALL", "ON_USE"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/;
const APACHE_2_LICENSE_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";
const REQUIRED_POLICY_FILES = ["PRIVACY.md", "TERMS.md", "SECURITY.md", "SUPPORT.md"];

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

function httpsUrl(value, label, errors) {
  if (typeof value !== "string" || !HTTPS_URL.test(value)) errors.push(`${label} must be an HTTPS URL`);
}

function validatePublisherAuthor(value, label, errors) {
  exactKeys(value, ["email", "name", "url"], label, errors);
  if (value?.name !== "Openly Useful") errors.push(`${label}.name must be Openly Useful`);
  if (value?.url !== "https://openlyuseful.org") errors.push(`${label}.url must be https://openlyuseful.org`);
  if (value?.email !== "hello@openlyuseful.org") errors.push(`${label}.email must be hello@openlyuseful.org`);
}

function validateCodexMarketplace(value, errors) {
  exactKeys(value, ["interface", "name", "plugins"], "Codex marketplace", errors);
  nonEmptyString(value?.name, "Codex marketplace name", errors);
  exactKeys(value?.interface, ["displayName"], "Codex marketplace interface", errors);
  if (value?.interface?.displayName !== "Openly Useful") errors.push("Codex marketplace interface.displayName must be Openly Useful");
  if (!Array.isArray(value?.plugins) || value.plugins.length !== 2) {
    errors.push("Codex marketplace must contain Project Status and RunGlance plugin entries");
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
  const runGlance = value.plugins[1];
  exactKeys(runGlance, ["category", "name", "policy", "source"], "Codex RunGlance marketplace plugin", errors);
  if (runGlance?.name !== "runglance") errors.push("Codex RunGlance marketplace plugin name must be runglance");
  if (runGlance?.source?.source !== "local" || runGlance?.source?.path !== "./plugins/openai/runglance") {
    errors.push("Codex RunGlance marketplace plugin source must target the OpenAI RunGlance wrapper");
  }
  if (!ALLOWED_INSTALLATION.has(runGlance?.policy?.installation)) errors.push("Codex RunGlance installation policy is invalid");
  if (!ALLOWED_AUTHENTICATION.has(runGlance?.policy?.authentication)) errors.push("Codex RunGlance authentication policy is invalid");
}

function validateClaudeMarketplace(value, version, errors) {
  exactKeys(value, ["$schema", "description", "name", "owner", "plugins", "version"], "Claude marketplace", errors);
  if (value?.$schema !== "https://json.schemastore.org/claude-code-marketplace.json") errors.push("Claude marketplace $schema is invalid");
  nonEmptyString(value?.name, "Claude marketplace name", errors);
  nonEmptyString(value?.description, "Claude marketplace description", errors);
  if (value?.version !== version) errors.push("Claude marketplace version differs from VERSION");
  validatePublisherAuthor(value?.owner, "Claude marketplace owner", errors);
  if (!Array.isArray(value?.plugins) || value.plugins.length !== 2) {
    errors.push("Claude marketplace must contain Project Status and RunGlance plugin entries");
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
  validatePublisherAuthor(plugin.author, "Claude marketplace plugin author", errors);
  const runGlance = value.plugins[1];
  exactKeys(runGlance, ["author", "category", "description", "name", "source", "strict", "version"], "Claude RunGlance marketplace plugin", errors);
  if (runGlance?.name !== "runglance") errors.push("Claude RunGlance marketplace plugin name must be runglance");
  if (runGlance?.source !== "./plugins/claude/runglance") errors.push("Claude RunGlance marketplace plugin source must target the Claude RunGlance wrapper");
  if (runGlance?.strict !== true) errors.push("Claude RunGlance marketplace plugin must use strict manifest mode");
  if (runGlance?.version !== version) errors.push("Claude RunGlance marketplace plugin version differs from VERSION");
  validatePublisherAuthor(runGlance?.author, "Claude RunGlance marketplace plugin author", errors);
}

function validatePluginManifest(value, host, version, mcpIncluded, errors, metadata) {
  const common = ["author", "description", "homepage", "license", "name", "repository", "skills", "version"];
  const keys = host === "openai" ? [...common, "interface"] : common;
  if (mcpIncluded) keys.push("mcpServers");
  exactKeys(value, keys, `${host} plugin manifest`, errors);
  if (value?.name !== metadata?.name) errors.push(`${host} plugin manifest name must be ${metadata?.name ?? "the canonical product name"}`);
  if (value?.version !== version || !SEMVER.test(value?.version ?? "")) errors.push(`${host} plugin manifest version differs from VERSION`);
  if (value?.skills !== "./skills/") errors.push(`${host} plugin manifest skills must be ./skills/`);
  nonEmptyString(value?.description, `${host} plugin manifest description`, errors);
  validatePublisherAuthor(value?.author, `${host} plugin manifest author`, errors);
  if (value?.homepage !== metadata?.homepage) errors.push(`${host} plugin manifest homepage differs from canonical metadata`);
  if (value?.repository !== metadata?.repository) errors.push(`${host} plugin manifest repository differs from canonical metadata`);
  if (value?.license !== "Apache-2.0") errors.push(`${host} plugin manifest license must be Apache-2.0`);
  httpsUrl(value?.homepage, `${host} plugin manifest homepage`, errors);
  httpsUrl(value?.repository, `${host} plugin manifest repository`, errors);
  if (mcpIncluded && value?.mcpServers !== "./.mcp.json") errors.push(`${host} plugin manifest mcpServers must target ./.mcp.json`);
  if (!mcpIncluded && "mcpServers" in (value ?? {})) errors.push(`${host} plugin manifest cannot declare MCP without a built companion`);
  if (host === "openai") {
    const required = ["capabilities", "category", "defaultPrompt", "developerName", "displayName", "longDescription", "privacyPolicyURL", "shortDescription", "supportURL", "termsOfServiceURL", "websiteURL"];
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
    if (value?.interface?.developerName !== "Openly Useful") errors.push("OpenAI plugin interface.developerName must be Openly Useful");
    const urls = {
      websiteURL: metadata?.homepage,
      privacyPolicyURL: metadata?.privacy,
      termsOfServiceURL: metadata?.terms,
      supportURL: metadata?.support,
    };
    for (const [field, expected] of Object.entries(urls)) {
      if (value?.interface?.[field] !== expected) errors.push(`OpenAI plugin interface.${field} differs from canonical metadata`);
      httpsUrl(value?.interface?.[field], `OpenAI plugin interface.${field}`, errors);
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateCompanionVersions(version, errors, root = releaseRoot) {
  const versions = {};
  for (const companion of ["mcp", "monitor", "runglance-mcp"]) {
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

export function validateMcpDistributionIdentity(version, errors, root = releaseRoot) {
  const repository = "https://github.com/Openly-Useful/project-status";
  const components = {
    projectStatus: {
      packagePath: join(root, "packages", "mcp", "package.json"),
      registryPath: join(root, "mcp-registry", "project-status", "server.json"),
      packageName: "@openly-useful/project-status-mcp",
      mcpName: "org.openlyuseful/project-status",
      bin: {
        "project-status-mcp": "dist/index.js",
        "runglance-mcp": "dist/runglance-index.js",
      },
      files: ["dist/index.js", "dist/runglance-index.js", "README.md", "LICENSE"],
    },
    runGlance: {
      packagePath: join(root, "packages", "runglance-mcp", "package.json"),
      registryPath: join(root, "mcp-registry", "runglance", "server.json"),
      packageName: "@openly-useful/runglance-mcp",
      mcpName: "org.openlyuseful/runglance",
      bin: { "runglance-mcp": "dist/index.js" },
      files: ["dist/index.js", "README.md", "LICENSE"],
    },
  };
  const result = {};
  for (const [key, expected] of Object.entries(components)) {
    let packageManifest;
    let registryManifest;
    try {
      packageManifest = readJson(expected.packagePath);
    } catch (error) {
      errors.push(`${expected.packagePath} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    try {
      registryManifest = readJson(expected.registryPath);
    } catch (error) {
      errors.push(`${expected.registryPath} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (packageManifest.name !== expected.packageName) errors.push(`${key} package name must be ${expected.packageName}`);
    if (packageManifest.mcpName !== expected.mcpName) errors.push(`${key} package mcpName must be ${expected.mcpName}`);
    if (packageManifest.version !== version) errors.push(`${key} package version differs from VERSION`);
    if (packageManifest.license !== "Apache-2.0") errors.push(`${key} package license must be Apache-2.0`);
    if (packageManifest.private === true) errors.push(`${key} package cannot be private`);
    if (packageManifest.publishConfig?.access !== "public") errors.push(`${key} package publishConfig.access must be public`);
    if (JSON.stringify(packageManifest.bin) !== JSON.stringify(expected.bin)) errors.push(`${key} package bin contract is invalid`);
    if (JSON.stringify(packageManifest.files) !== JSON.stringify(expected.files)) errors.push(`${key} package files allowlist is invalid`);
    if (packageManifest.repository?.url !== `git+${repository}.git`) errors.push(`${key} package repository is invalid`);
    if (packageManifest.bugs !== "https://openlyuseful.org/support") errors.push(`${key} package support URL is invalid`);
    if (registryManifest.name !== expected.mcpName) errors.push(`${key} registry name must match package mcpName`);
    if (registryManifest.version !== version) errors.push(`${key} registry version differs from VERSION`);
    if (registryManifest.repository?.url !== repository || registryManifest.repository?.source !== "github") errors.push(`${key} registry repository is invalid`);
    if (!Array.isArray(registryManifest.packages) || registryManifest.packages.length !== 1) {
      errors.push(`${key} registry must expose exactly one package`);
    } else {
      const registryPackage = registryManifest.packages[0];
      if (registryPackage.registryType !== "npm") errors.push(`${key} registry package type must be npm`);
      if (registryPackage.identifier !== expected.packageName) errors.push(`${key} registry package identifier must match the package name`);
      if (registryPackage.version !== version) errors.push(`${key} registry package version differs from VERSION`);
      if (registryPackage.transport?.type !== "stdio") errors.push(`${key} registry transport must be stdio`);
    }
    result[key] = { packageName: packageManifest.name, mcpName: packageManifest.mcpName, version: packageManifest.version };
  }
  return result;
}

export function founderPublicationAuthorizationSatisfied(publisher) {
  return Boolean(
    publisher?.legal?.status === "formation-pending"
    && publisher?.legal?.activeName === null
    && publisher?.legal?.currentOperator?.type === "founder-individual"
    && publisher?.publication?.externalPublicationAllowed === true
    && publisher?.publication?.authorization === "granted"
    && publisher?.publication?.authorizationBasis === "founder-owner-direct"
    && publisher?.publication?.effectiveWhileFormationPending === true
    && Array.isArray(publisher?.publication?.blockingRequirements)
    && !publisher.publication.blockingRequirements.includes("formation-active")
    && !publisher.publication.blockingRequirements.includes("publisher-authorization")
  );
}

// Backwards-compatible export for existing release consumers. External package
// publication is currently authorized by the founder-owner, not by an active LLC.
export const externalActivationSatisfied = founderPublicationAuthorizationSatisfied;

function releaseGates(release, mcpDistributions) {
  const licensePath = join(releaseRoot, "LICENSE");
  const licenseDigest = existsSync(licensePath) && statSync(licensePath).isFile()
    ? createHash("sha256").update(readFileSync(licensePath)).digest("hex")
    : null;
  const licenseExact = licenseDigest === APACHE_2_LICENSE_SHA256;
  const noticePath = join(releaseRoot, "THIRD_PARTY_NOTICES.md");
  let noticesCurrent = false;
  let noticeDetail = "THIRD_PARTY_NOTICES.md is missing.";
  try {
    const noticePlan = createThirdPartyNoticePlan();
    noticesCurrent = existsSync(noticePath)
      && statSync(noticePath).isFile()
      && readFileSync(noticePath, "utf8") === noticePlan.contents;
    noticeDetail = noticesCurrent
      ? `Third-party notices match ${noticePlan.packageCount} pinned runtime dependencies.`
      : "THIRD_PARTY_NOTICES.md differs from the pinned site/MCP runtime dependency graph.";
  } catch (error) {
    noticeDetail = `Third-party notice verification could not run: ${error instanceof Error ? error.message : String(error)}`;
  }
  const policyFileProblems = [];
  const expectedPolicyUrls = {
    "PRIVACY.md": release.publisher?.policies?.privacy,
    "TERMS.md": release.publisher?.policies?.terms,
    "SECURITY.md": release.publisher?.policies?.security,
    "SUPPORT.md": release.publisher?.policies?.support,
  };
  for (const name of REQUIRED_POLICY_FILES) {
    const path = join(releaseRoot, name);
    if (!existsSync(path) || !statSync(path).isFile()) policyFileProblems.push(`${name} is missing`);
    else if (!readFileSync(path, "utf8").includes(expectedPolicyUrls[name] ?? "__missing_policy_url__")) {
      policyFileProblems.push(`${name} does not reference its canonical Openly Useful URL`);
    }
  }
  const publisherConfigured = Boolean(
    publisherErrors(release.publisher).length === 0
    && release.publisher?.displayName === "Openly Useful"
    && release.metadata?.author?.name === "Openly Useful"
    && release.runGlanceMetadata?.author?.name === "Openly Useful",
  );
  const founderRecordConfirmed = Boolean(
    release.publisher?.repositoryContext?.runGlanceCopyright?.authorshipStatus === "sole-author-confirmed"
    && release.publisher?.repositoryContext?.runGlanceCopyright?.ownerType === "individual-founder"
    && release.publisher?.repositoryContext?.runGlanceCopyright?.ownershipStatus === "personal"
    && release.publisher?.repositoryContext?.runGlanceCopyright?.transferRequired === false
    && release.publisher?.repositoryContext?.currentOpenSourcePublication === "founder-authorized",
  );
  const packageNamespaceContractsValid = Boolean(
    mcpDistributions?.projectStatus?.packageName === `${release.publisher?.namespaces?.npm}/project-status-mcp`
    && mcpDistributions?.runGlance?.packageName === `${release.publisher?.namespaces?.npm}/runglance-mcp`
    && mcpDistributions?.projectStatus?.mcpName === `${release.publisher?.namespaces?.openSourceMcp}/project-status`
    && mcpDistributions?.runGlance?.mcpName === `${release.publisher?.namespaces?.openSourceMcp}/runglance`
  );
  const founderPublicationAuthorized = founderPublicationAuthorizationSatisfied(release.publisher);
  return [
    {
      id: "apache-2.0-license",
      status: licenseExact ? "satisfied" : "pending_implementation",
      detail: licenseExact
        ? "LICENSE exactly matches the Apache License 2.0 reference text."
        : "LICENSE is missing or does not exactly match the Apache License 2.0 reference text.",
    },
    {
      id: "third-party-notices",
      status: noticesCurrent ? "satisfied" : "pending_implementation",
      detail: noticeDetail,
    },
    {
      id: "public-policy-files",
      status: policyFileProblems.length === 0 ? "satisfied" : "pending_implementation",
      detail: policyFileProblems.length === 0
        ? "Privacy, terms, security, and support files reference their canonical Openly Useful URLs."
        : policyFileProblems.join("; "),
    },
    {
      id: "publisher-contract",
      status: publisherConfigured ? "satisfied" : "pending_implementation",
      detail: publisherConfigured
        ? "Both products use Openly Useful as the publisher/developer brand and reference the canonical publisher mirror."
        : "Publisher metadata is incomplete or inconsistent across Project Status and RunGlance.",
    },
    {
      id: "package-and-namespace-contracts",
      status: packageNamespaceContractsValid ? "satisfied" : "pending_implementation",
      detail: packageNamespaceContractsValid
        ? "Both npm package names and MCP identities match the canonical Openly Useful namespaces."
        : "The publishable package or MCP identities do not match the canonical Openly Useful namespaces.",
    },
    {
      id: "founder-record-and-open-source-authorization",
      status: founderRecordConfirmed ? "satisfied" : "pending_implementation",
      detail: founderRecordConfirmed
        ? "RunGlance sole authorship and personal ownership are owner-confirmed; current open-source publication is founder-authorized and no ownership transfer is required."
        : "The owner-confirmed founder record or current open-source publication authorization is not encoded correctly.",
    },
    {
      id: "founder-authorized-package-publication",
      status: founderPublicationAuthorized ? "satisfied" : "pending_authorization",
      detail: founderPublicationAuthorized
        ? "The founder-owner directly authorizes package publication while LLC formation remains pending; provider review is a separate workflow and does not block npm."
        : "Package publication requires direct founder-owner authorization that remains effective while LLC formation is pending.",
    },
  ];
}

export function checkRelease() {
  const release = inspectReleaseState();
  const packagePlan = createPackagePlan();
  const runGlancePackagePlan = createRunGlancePackagePlan();
  const errors = [...release.errors, ...packagePlan.errors, ...runGlancePackagePlan.errors];
  const companionVersions = validateCompanionVersions(release.version, errors);
  const mcpDistributions = validateMcpDistributionIdentity(release.version, errors);
  if (release.marketplaces) {
    validateCodexMarketplace(release.marketplaces.openai, errors);
    validateClaudeMarketplace(release.marketplaces.claude, release.version, errors);
  }
  if (release.manifests) {
    validatePluginManifest(release.manifests.openai, "openai", release.version, release.mcpIncluded, errors, release.metadata);
    validatePluginManifest(release.manifests.claude, "claude", release.version, release.mcpIncluded, errors, release.metadata);
  }
  if (release.runGlanceManifests) {
    validatePluginManifest(release.runGlanceManifests.openai, "openai", release.version, release.runGlanceMcpIncluded, errors, release.runGlanceMetadata);
    validatePluginManifest(release.runGlanceManifests.claude, "claude", release.version, release.runGlanceMcpIncluded, errors, release.runGlanceMetadata);
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
  const gates = releaseGates(release, mcpDistributions);
  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    distributionReady: uniqueErrors.length === 0,
    publishReady: uniqueErrors.length === 0 && gates.every((gate) => gate.status === "satisfied"),
    version: release.version,
    companionVersions,
    mcpDistributions,
    mcpIncluded: release.mcpIncluded,
    wrapperFileCount: release.actualFileCount,
    archives: Object.fromEntries(Object.entries(packagePlan.archives).map(([kind, archive]) => [kind, {
      file: archive.name,
      sha256: archive.sha256,
      size: archive.size,
      entryCount: archive.entries.length,
    }])),
    runGlanceArchives: Object.fromEntries(Object.entries(runGlancePackagePlan.archives).map(([kind, archive]) => [kind, {
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
    `npm package publication: ${result.publishReady ? "ready" : "waiting on package, namespace, policy, or founder-authorization validation"}`,
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
