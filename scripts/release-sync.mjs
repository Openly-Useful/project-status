#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const releaseRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const canonicalSkillRoot = join(releaseRoot, "skill", "project-status");
export const openAiPluginRoot = join(releaseRoot, "plugins", "openai", "project-status");
export const claudePluginRoot = join(releaseRoot, "plugins", "claude", "project-status");
export const runGlanceSkillRoot = join(releaseRoot, "skill", "runglance");
export const runGlanceOpenAiPluginRoot = join(releaseRoot, "plugins", "openai", "runglance");
export const runGlanceClaudePluginRoot = join(releaseRoot, "plugins", "claude", "runglance");

const METADATA_PATH = join(canonicalSkillRoot, "assets", "package-metadata.json");
const RUNGLANCE_METADATA_PATH = join(runGlanceSkillRoot, "assets", "package-metadata.json");
const PUBLISHER_PATH = join(releaseRoot, "publisher", "publisher.json");
const VERSION_PATH = join(releaseRoot, "VERSION");
const MCP_ROOT = join(releaseRoot, "packages", "mcp");
const MCP_DIST_ROOT = join(MCP_ROOT, "dist");
const MCP_ENTRYPOINT = join(MCP_DIST_ROOT, "index.js");
const RUNGLANCE_MCP_ENTRYPOINT = join(releaseRoot, "packages", "runglance-mcp", "dist", "index.js");
const CORE_ROOT = join(releaseRoot, "packages", "core");
const MCP_BUNDLER_VERSION = "0.25.12";
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name.slice(5) : `node:${name}`]));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(?:\/[^\s]*)?$/;

function toPosix(path) {
  return path.split(sep).join("/");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function jsonFile(path, label, errors) {
  if (!existsSync(path)) {
    errors.push(`${label} is missing: ${toPosix(relative(releaseRoot, path))}`);
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${label} must contain a JSON object`);
      return null;
    }
    return value;
  } catch {
    errors.push(`${label} must contain valid JSON`);
    return null;
  }
}

function readVersion(errors) {
  if (!existsSync(VERSION_PATH)) {
    errors.push("VERSION is missing");
    return null;
  }
  const version = readFileSync(VERSION_PATH, "utf8").trim();
  if (!SEMVER.test(version)) errors.push("VERSION must contain one strict semantic version");
  return version;
}

function walkFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) {
        throw new Error(`Generated release inputs cannot contain symlinks: ${toPosix(relative(releaseRoot, path))}`);
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const relativePath = toPosix(relative(root, path));
        files.push({ relativePath, path, contents: readFileSync(path) });
      } else {
        throw new Error(`Unsupported release input: ${toPosix(relative(releaseRoot, path))}`);
      }
    }
  }

  visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function bundledEntrypointErrors(contents) {
  const source = Buffer.isBuffer(contents) ? contents.toString("utf8") : String(contents);
  const errors = [];
  if (!source.startsWith("#!/usr/bin/env node\n")) errors.push("MCP dist/index.js must retain its Node executable shebang");
  if (!source.includes("../../core/index.mjs")) errors.push("MCP dist/index.js must resolve the packaged ../../core/index.mjs runtime");
  if (/sourceMappingURL=/.test(source)) errors.push("MCP dist/index.js cannot reference a source map");

  const specifiers = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  for (const specifier of [...new Set(specifiers)].sort()) {
    if (!NODE_BUILTINS.has(specifier)) errors.push(`MCP dist/index.js has an unbundled runtime import: ${specifier}`);
  }
  return errors;
}

function validHttpsUrl(value) {
  return typeof value === "string" && HTTPS_URL.test(value);
}

export function publisherErrors(publisher) {
  const errors = [];
  if (!publisher) return errors;
  if (publisher.schemaVersion !== 1) errors.push("publisher schemaVersion must be 1");
  if (publisher.id !== "openly-useful") errors.push("publisher id must be openly-useful");
  if (publisher.authorityManifest !== "https://openlyuseful.org/publisher/manifest.json") {
    errors.push("publisher authorityManifest must target the Openly Useful publisher manifest");
  }
  if (publisher.mirrorRole !== "repository-consumer") errors.push("publisher mirrorRole must be repository-consumer");
  if (publisher.displayName !== "Openly Useful") errors.push("publisher displayName must be Openly Useful");
  const expectedDomains = {
    studio: "https://openlyuseful.com",
    openSource: "https://openlyuseful.org",
    publicAuthority: "openlyuseful.org",
  };
  for (const [field, expected] of Object.entries(expectedDomains)) {
    if (publisher.domains?.[field] !== expected) errors.push(`publisher domains.${field} must be ${expected}`);
  }
  if (publisher.organization?.github !== "https://github.com/Openly-Useful") errors.push("publisher organization GitHub URL is invalid");
  if (publisher.legal?.plannedName !== "Openly Useful LLC") errors.push("publisher planned legal entity must be Openly Useful LLC");
  if (publisher.legal?.status !== "formation-pending") errors.push("publisher legal entity status must remain formation-pending until formation is accepted");
  if (publisher.legal?.activeName !== null) errors.push("formation-pending publisher cannot have an active legal name");
  const currentOperator = publisher.legal?.currentOperator;
  if (currentOperator?.type !== "founder-individual") errors.push("publisher current operator must be founder-individual");
  if (currentOperator?.displayName !== "Founder of Openly Useful") errors.push("publisher current operator display name is invalid");
  if (currentOperator?.operatingAs !== "Openly Useful") errors.push("publisher current operator must operate as Openly Useful");
  const plannedRoles = publisher.legal?.plannedRoles;
  if (!Array.isArray(plannedRoles) || JSON.stringify([...plannedRoles].sort()) !== JSON.stringify(["licensee", "operator", "publisher"])) {
    errors.push("publisher planned roles must be licensee, operator, and publisher");
  }
  const runGlance = publisher.repositoryContext?.runGlanceCopyright;
  if (runGlance?.authorshipStatus !== "sole-author-confirmed") errors.push("RunGlance authorship must be sole-author-confirmed");
  if (runGlance?.ownerType !== "individual-founder") errors.push("RunGlance copyright ownerType must be individual-founder");
  if (runGlance?.ownershipStatus !== "personal") errors.push("RunGlance copyright ownership must remain personal");
  if (runGlance?.transferRequired !== false) errors.push("RunGlance transferRequired must be false");
  if (publisher.repositoryContext?.currentOpenSourcePublication !== "founder-authorized") {
    errors.push("current open-source publication must be founder-authorized");
  }
  if (!["documentation-pending-after-formation", "documented"].includes(publisher.repositoryContext?.futureEntityPublishing)) {
    errors.push("future entity publishing authorization must be pending documentation or documented");
  }
  const expectedPolicies = {
    privacy: "https://openlyuseful.org/legal/privacy",
    terms: "https://openlyuseful.org/legal/terms",
    security: "https://openlyuseful.org/security",
    support: "https://openlyuseful.org/support",
  };
  for (const [field, expected] of Object.entries(expectedPolicies)) {
    if (publisher.policies?.[field] !== expected) errors.push(`publisher policies.${field} must be ${expected}`);
  }
  const expectedPolicyMirrors = {
    privacy: "https://github.com/Openly-Useful/openlyuseful.org/blob/main/legal/privacy.html",
    terms: "https://github.com/Openly-Useful/openlyuseful.org/blob/main/legal/terms.html",
    security: "https://github.com/Openly-Useful/openlyuseful.org/blob/main/security.html",
    support: "https://github.com/Openly-Useful/openlyuseful.org/blob/main/support.html",
  };
  for (const [field, expected] of Object.entries(expectedPolicyMirrors)) {
    if (publisher.policyMirrors?.[field] !== expected) errors.push(`publisher policyMirrors.${field} must be ${expected}`);
  }
  if (publisher.authorityManifestMirror !== "https://github.com/Openly-Useful/openlyuseful.org/blob/main/publisher/manifest.json") {
    errors.push("publisher authorityManifestMirror is invalid");
  }
  if (publisher.contacts?.public !== "hello@openlyuseful.org") errors.push("publisher public contact is invalid");
  if (publisher.contacts?.routing !== "Use the email subject to route publishing, security, legal, and support requests.") errors.push("publisher contact routing is invalid");
  if (publisher.namespaces?.openSourceMcp !== "org.openlyuseful") errors.push("publisher open-source MCP namespace must be org.openlyuseful");
  if (publisher.namespaces?.reservedStudioMcp !== "com.openlyuseful") errors.push("publisher Studio MCP namespace must be com.openlyuseful");
  if (publisher.namespaces?.npm !== "@openly-useful") errors.push("publisher npm namespace must be @openly-useful");
  const repository = "https://github.com/Openly-Useful/project-status";
  if (publisher.repositoryContext?.repositories?.projectStatus !== repository) errors.push("publisher Project Status repository is invalid");
  if (publisher.repositoryContext?.repositories?.runGlance !== repository) errors.push("publisher RunGlance repository is invalid");
  if (publisher.publication?.localGenerationAllowed !== true) errors.push("publisher must allow local generation");
  if (publisher.publication?.localTestingAllowed !== true) errors.push("publisher must allow local testing");
  if (publisher.publication?.externalPublicationAllowed !== true) errors.push("publisher external publication must be founder-authorized");
  if (publisher.publication?.authorization !== "granted") errors.push("publisher publication authorization must be granted");
  if (publisher.publication?.authorizationBasis !== "founder-owner-direct") errors.push("publisher authorization basis must be founder-owner-direct");
  if (publisher.publication?.effectiveWhileFormationPending !== true) errors.push("founder publication authorization must remain effective while formation is pending");
  const blockers = publisher.publication?.blockingRequirements;
  const allowedBlockers = ["namespace-verification", "provider-account-authentication", "provider-review"];
  if (!Array.isArray(blockers)) {
    errors.push("publisher blockingRequirements must be an array");
  } else {
    const uniqueBlockers = [...new Set(blockers)];
    if (uniqueBlockers.length !== blockers.length) errors.push("publisher blockingRequirements cannot contain duplicates");
    for (const blocker of uniqueBlockers) {
      if (!allowedBlockers.includes(blocker)) errors.push(`publisher blockingRequirements contains an unknown requirement: ${blocker}`);
    }
    if (uniqueBlockers.includes("formation-active") || uniqueBlockers.includes("publisher-authorization")) {
      errors.push("LLC formation and separate publisher authorization cannot block founder-authorized publication");
    }
  }
  for (const field of ["authorityEndpoint", "derivation", "activation"]) {
    if (typeof publisher.artifactPolicy?.[field] !== "string" || !publisher.artifactPolicy[field].trim()) {
      errors.push(`publisher artifactPolicy.${field} is required`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publisher.lastUpdated ?? "")) errors.push("publisher lastUpdated must be an ISO date");
  return errors;
}

function metadataErrors(metadata, version, expectedName = "project-status", publisher = null) {
  const errors = [];
  if (!metadata) return errors;
  if (metadata.name !== expectedName) errors.push(`package metadata name must be ${expectedName}`);
  if (!SEMVER.test(metadata.version ?? "")) errors.push("package metadata version must be strict semver");
  if (version && metadata.version !== version) errors.push(`VERSION (${version}) differs from package metadata (${metadata.version ?? "missing"})`);
  if (typeof metadata.description !== "string" || !metadata.description.trim()) errors.push("package metadata description is required");
  if (metadata.author?.name !== publisher?.displayName) errors.push("package metadata author.name must match the Openly Useful publisher display name");
  if (metadata.author?.url !== publisher?.domains?.openSource) errors.push("package metadata author.url must match the publisher open-source domain");
  if (metadata.author?.email !== publisher?.contacts?.public) errors.push("package metadata author.email must match the publisher public contact");
  const expectedRepository = expectedName === "runglance" ? publisher?.repositoryContext?.repositories?.runGlance : publisher?.repositoryContext?.repositories?.projectStatus;
  const expectedHomepage = expectedRepository;
  const publicFields = {
    homepage: expectedHomepage,
    repository: expectedRepository,
    license: "Apache-2.0",
    support: publisher?.policies?.support,
    privacy: publisher?.policies?.privacy,
    terms: publisher?.policies?.terms,
    security: publisher?.policies?.security,
    publisherManifest: publisher?.authorityManifest,
  };
  for (const [field, expected] of Object.entries(publicFields)) {
    if (metadata[field] !== expected) errors.push(`package metadata ${field} must be ${expected}`);
    if (field !== "license" && !validHttpsUrl(metadata[field])) errors.push(`package metadata ${field} must be an HTTPS URL`);
  }
  const interfaceValue = metadata.openai?.interface;
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    if (typeof interfaceValue?.[field] !== "string" || !interfaceValue[field].trim()) errors.push(`package metadata openai.interface.${field} is required`);
  }
  if (!Array.isArray(interfaceValue?.capabilities) || !interfaceValue.capabilities.every((value) => typeof value === "string" && value.trim())) {
    errors.push("package metadata openai.interface.capabilities must be an array of strings");
  }
  if (!Array.isArray(interfaceValue?.defaultPrompt) || interfaceValue.defaultPrompt.length < 1 || interfaceValue.defaultPrompt.length > 3) {
    errors.push("package metadata openai.interface.defaultPrompt must contain one to three prompts");
  }
  if (interfaceValue?.developerName !== publisher?.displayName) errors.push("package metadata openai.interface.developerName must be Openly Useful");
  if (typeof metadata.claude?.description !== "string" || !metadata.claude.description.trim()) errors.push("package metadata claude.description is required");
  return errors;
}

function mcpRuntimeModel(version, errors) {
  if (!existsSync(MCP_ENTRYPOINT)) return { enabled: false, files: [] };

  const sourcePackage = jsonFile(join(MCP_ROOT, "package.json"), "MCP package.json", errors);
  const sourceLock = jsonFile(join(MCP_ROOT, "package-lock.json"), "MCP package-lock.json", errors);
  const contents = readFileSync(MCP_ENTRYPOINT);
  const files = [{ relativePath: "index.js", path: MCP_ENTRYPOINT, contents }];
  errors.push(...bundledEntrypointErrors(contents));

  if (sourcePackage && version) {
    if (sourcePackage.version !== version) errors.push(`MCP package version (${sourcePackage.version ?? "missing"}) differs from VERSION (${version})`);
    if (sourcePackage.devDependencies?.esbuild !== MCP_BUNDLER_VERSION) {
      errors.push(`MCP package must pin esbuild devDependency to ${MCP_BUNDLER_VERSION}`);
    }
  }
  if (sourceLock) {
    if (sourceLock.packages?.[""]?.devDependencies?.esbuild !== MCP_BUNDLER_VERSION) {
      errors.push(`MCP package-lock root must pin esbuild to ${MCP_BUNDLER_VERSION}`);
    }
    if (sourceLock.packages?.["node_modules/esbuild"]?.version !== MCP_BUNDLER_VERSION) {
      errors.push(`MCP package-lock must resolve esbuild ${MCP_BUNDLER_VERSION}`);
    }
  }
  return { enabled: true, files };
}

export function expectedPluginManifests(metadata, { mcpEnabled = false } = {}) {
  const mcp = mcpEnabled ? { mcpServers: "./.mcp.json" } : {};
  const publication = {
    author: metadata.author,
    homepage: metadata.homepage,
    repository: metadata.repository,
    license: metadata.license,
  };
  return {
    openai: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      ...publication,
      skills: "./skills/",
      ...mcp,
      interface: {
        ...metadata.openai.interface,
        websiteURL: metadata.homepage,
        privacyPolicyURL: metadata.privacy,
        termsOfServiceURL: metadata.terms,
        supportURL: metadata.support,
      },
    },
    claude: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.claude.description,
      ...publication,
      skills: "./skills/",
      ...mcp,
    },
  };
}

export function expectedMarketplaces(metadata, runGlanceMetadata = null) {
  const openAiPlugins = [
    {
      name: metadata.name,
      source: { source: "local", path: "./plugins/openai/project-status" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: metadata.openai.interface.category,
    },
  ];
  const claudePlugins = [
    {
      name: metadata.name,
      source: "./plugins/claude/project-status",
      description: metadata.claude.description,
      version: metadata.version,
      author: metadata.author,
      category: "productivity",
      strict: true,
    },
  ];
  if (runGlanceMetadata) {
    openAiPlugins.push({
      name: runGlanceMetadata.name,
      source: { source: "local", path: "./plugins/openai/runglance" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: runGlanceMetadata.openai.interface.category,
    });
    claudePlugins.push({
      name: runGlanceMetadata.name,
      source: "./plugins/claude/runglance",
      description: runGlanceMetadata.claude.description,
      version: runGlanceMetadata.version,
      author: runGlanceMetadata.author,
      category: "productivity",
      strict: true,
    });
  }
  return {
    openai: {
      name: "project-status-initiative",
      interface: { displayName: "Openly Useful" },
      plugins: openAiPlugins,
    },
    claude: {
      $schema: "https://json.schemastore.org/claude-code-marketplace.json",
      name: "project-status-initiative",
      version: metadata.version,
      description: "Portable Project Status and RunGlance skills with optional read-only MCP tooling.",
      owner: metadata.author,
      plugins: claudePlugins,
    },
  };
}

function addExpected(files, relativePath, contents) {
  files.set(relativePath, Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8"));
}

function createExpectedModel() {
  const errors = [];
  const version = readVersion(errors);
  const publisher = jsonFile(PUBLISHER_PATH, "publisher manifest mirror", errors);
  const metadata = jsonFile(METADATA_PATH, "package metadata", errors);
  const runGlanceMetadata = jsonFile(RUNGLANCE_METADATA_PATH, "RunGlance package metadata", errors);
  errors.push(...publisherErrors(publisher));
  errors.push(...metadataErrors(metadata, version, "project-status", publisher));
  errors.push(...metadataErrors(runGlanceMetadata, version, "runglance", publisher));
  const mcp = mcpRuntimeModel(version, errors);
  const files = new Map();

  if (!publisher || !metadata || !runGlanceMetadata) return { valid: false, errors, version, publisher, metadata, runGlanceMetadata, mcp, files, manifests: null, marketplaces: null };

  const manifests = expectedPluginManifests(metadata, { mcpEnabled: mcp.enabled });
  const runGlanceMcpEnabled = existsSync(RUNGLANCE_MCP_ENTRYPOINT);
  const runGlanceManifests = expectedPluginManifests(runGlanceMetadata, { mcpEnabled: runGlanceMcpEnabled });
  const marketplaces = expectedMarketplaces(metadata, runGlanceMetadata);
  addExpected(files, ".agents/plugins/marketplace.json", stableJson(marketplaces.openai));
  addExpected(files, ".claude-plugin/marketplace.json", stableJson(marketplaces.claude));
  addExpected(files, "plugins/openai/project-status/.codex-plugin/plugin.json", stableJson(manifests.openai));
  addExpected(files, "plugins/claude/project-status/.claude-plugin/plugin.json", stableJson(manifests.claude));
  addExpected(files, "plugins/openai/runglance/.codex-plugin/plugin.json", stableJson(runGlanceManifests.openai));
  addExpected(files, "plugins/claude/runglance/.claude-plugin/plugin.json", stableJson(runGlanceManifests.claude));

  try {
    for (const source of walkFiles(canonicalSkillRoot)) {
      for (const host of ["openai", "claude"]) {
        addExpected(files, `plugins/${host}/project-status/skills/project-status/${source.relativePath}`, source.contents);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    for (const source of walkFiles(runGlanceSkillRoot)) {
      for (const host of ["openai", "claude"]) {
        addExpected(files, `plugins/${host}/runglance/skills/runglance/${source.relativePath}`, source.contents);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (mcp.enabled) {
    let coreFiles = [];
    try {
      coreFiles = walkFiles(CORE_ROOT).filter((file) => file.relativePath.endsWith(".mjs"));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (!coreFiles.some((file) => file.relativePath === "index.mjs")) {
      errors.push("packages/core/index.mjs is required by the packaged MCP runtime");
    }
    const configs = {
      openai: {
        mcpServers: {
          "project-status": {
            command: "node",
            args: ["./mcp/dist/index.js"],
            cwd: ".",
          },
        },
      },
      claude: {
        mcpServers: {
          "project-status": {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/mcp/dist/index.js"],
            cwd: "${CLAUDE_PROJECT_DIR}",
          },
        },
      },
    };
    for (const host of ["openai", "claude"]) {
      const prefix = `plugins/${host}/project-status`;
      addExpected(files, `${prefix}/.mcp.json`, stableJson(configs[host]));
      for (const runtime of mcp.files) addExpected(files, `${prefix}/mcp/dist/${runtime.relativePath}`, runtime.contents);
      for (const coreFile of coreFiles) addExpected(files, `${prefix}/core/${coreFile.relativePath}`, coreFile.contents);
    }
  }
  if (runGlanceMcpEnabled) {
    const runtime = readFileSync(RUNGLANCE_MCP_ENTRYPOINT);
    if (!runtime.toString("utf8").startsWith("#!/usr/bin/env node\n")) errors.push("RunGlance MCP bundle must retain its Node executable shebang");
    if (/sourceMappingURL=/.test(runtime.toString("utf8"))) errors.push("RunGlance MCP bundle cannot reference a source map");
    const configs = {
      openai: {
        mcpServers: {
          runglance: {
            command: "node",
            args: ["./mcp/dist/index.js"],
            cwd: ".",
          },
        },
      },
      claude: {
        mcpServers: {
          runglance: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/mcp/dist/index.js"],
            cwd: "${CLAUDE_PROJECT_DIR}",
          },
        },
      },
    };
    for (const host of ["openai", "claude"]) {
      const prefix = `plugins/${host}/runglance`;
      addExpected(files, `${prefix}/.mcp.json`, stableJson(configs[host]));
      addExpected(files, `${prefix}/mcp/dist/index.js`, runtime);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    version,
    publisher,
    metadata,
    runGlanceMetadata,
    mcp,
    runGlanceMcpIncluded: runGlanceMcpEnabled,
    files,
    manifests,
    runGlanceManifests,
    marketplaces,
  };
}

function actualWrapperFiles() {
  const files = new Map();
  for (const marketplacePath of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
    const path = join(releaseRoot, marketplacePath);
    if (existsSync(path) && statSync(path).isFile()) files.set(marketplacePath, readFileSync(path));
  }
  for (const [prefix, root] of [
    ["plugins/openai/project-status", openAiPluginRoot],
    ["plugins/claude/project-status", claudePluginRoot],
    ["plugins/openai/runglance", runGlanceOpenAiPluginRoot],
    ["plugins/claude/runglance", runGlanceClaudePluginRoot],
  ]) {
    for (const file of walkFiles(root)) files.set(`${prefix}/${file.relativePath}`, file.contents);
  }
  return files;
}

function compareFiles(expected, actual) {
  const errors = [];
  for (const [path, contents] of expected) {
    const candidate = actual.get(path);
    if (!candidate) errors.push(`generated release file is missing: ${path}`);
    else if (!candidate.equals(contents)) errors.push(`generated release file is stale: ${path}`);
  }
  for (const path of actual.keys()) {
    if (!expected.has(path)) errors.push(`unexpected file in generated release wrapper: ${path}`);
  }
  return errors;
}

export function inspectReleaseState() {
  const expected = createExpectedModel();
  let actual = new Map();
  const errors = [...expected.errors];
  try {
    actual = actualWrapperFiles();
    errors.push(...compareFiles(expected.files, actual));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    valid: errors.length === 0,
    version: expected.version,
    mcpIncluded: expected.mcp.enabled,
    runGlanceMcpIncluded: expected.runGlanceMcpIncluded,
    expectedFileCount: expected.files.size,
    actualFileCount: actual.size,
    errors,
    metadata: expected.metadata,
    runGlanceMetadata: expected.runGlanceMetadata,
    publisher: expected.publisher,
    manifests: expected.manifests,
    runGlanceManifests: expected.runGlanceManifests,
    marketplaces: expected.marketplaces,
    expectedFiles: expected.files,
  };
}

function writeExpectedFiles(model) {
  if (!model.valid) return;
  for (const root of [openAiPluginRoot, claudePluginRoot, runGlanceOpenAiPluginRoot, runGlanceClaudePluginRoot]) {
    if (existsSync(root)) rmSync(root, { recursive: true });
  }
  for (const [relativePath, contents] of model.files) {
    const path = resolve(releaseRoot, relativePath);
    if (!path.startsWith(`${releaseRoot}${sep}`)) throw new Error(`Refusing release path outside repository: ${relativePath}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { mode: relativePath.endsWith(".mjs") ? 0o755 : 0o644 });
    if (relativePath.endsWith(".mjs")) chmodSync(path, 0o755);
  }
}

function parseArgs(argv) {
  const command = argv[0] ?? "check";
  const json = argv.slice(1).includes("--json");
  if (!["check", "sync"].includes(command) || argv.slice(1).some((arg) => arg !== "--json")) {
    throw new Error("Usage: release-sync.mjs <check|sync> [--json]");
  }
  return { command, json };
}

function visibleResult(state, operation, written = []) {
  return {
    valid: state.valid,
    operation,
    readOnly: operation === "check",
    version: state.version,
    mcpIncluded: state.mcpIncluded,
    expectedFileCount: state.expectedFileCount,
    actualFileCount: state.actualFileCount,
    written,
    errors: state.errors,
  };
}

function formatResult(result) {
  const lines = [
    `RELEASE ${result.operation.toUpperCase()} ${result.valid ? "OK" : "FAILED"}`,
    `Version: ${result.version ?? "unknown"}`,
    `Generated files: ${result.expectedFileCount}`,
    `MCP companion: ${result.mcpIncluded ? "included" : "not built; omitted"}`,
    ...result.errors.map((error) => `ERROR: ${error}`),
  ];
  if (result.operation === "check") lines.push("No files were changed.");
  else if (result.valid) lines.push("Repository-local wrapper files were synchronized; nothing was installed or published.");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let result;
  if (options.command === "sync") {
    const expected = createExpectedModel();
    if (!expected.valid) {
      result = visibleResult({ ...expected, expectedFileCount: expected.files.size, actualFileCount: 0 }, "sync");
    } else {
      writeExpectedFiles(expected);
      const checked = inspectReleaseState();
      result = visibleResult(checked, "sync", [...expected.files.keys()].sort());
    }
  } else {
    result = visibleResult(inspectReleaseState(), "check");
  }
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : formatResult(result)}\n`);
  return result.valid ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
