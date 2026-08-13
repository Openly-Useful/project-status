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

const METADATA_PATH = join(canonicalSkillRoot, "assets", "package-metadata.json");
const VERSION_PATH = join(releaseRoot, "VERSION");
const MCP_ROOT = join(releaseRoot, "packages", "mcp");
const MCP_DIST_ROOT = join(MCP_ROOT, "dist");
const MCP_ENTRYPOINT = join(MCP_DIST_ROOT, "index.js");
const CORE_ROOT = join(releaseRoot, "packages", "core");
const MCP_BUNDLER_VERSION = "0.25.12";
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.startsWith("node:") ? name.slice(5) : `node:${name}`]));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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

function metadataErrors(metadata, version) {
  const errors = [];
  if (!metadata) return errors;
  if (metadata.name !== "project-status") errors.push("package metadata name must be project-status");
  if (!SEMVER.test(metadata.version ?? "")) errors.push("package metadata version must be strict semver");
  if (version && metadata.version !== version) errors.push(`VERSION (${version}) differs from package metadata (${metadata.version ?? "missing"})`);
  if (typeof metadata.description !== "string" || !metadata.description.trim()) errors.push("package metadata description is required");
  if (typeof metadata.author?.name !== "string" || !metadata.author.name.trim()) errors.push("package metadata author.name is required");
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
  return {
    openai: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author,
      skills: "./skills/",
      ...mcp,
      interface: metadata.openai.interface,
    },
    claude: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.claude.description,
      author: metadata.author,
      skills: "./skills/",
      ...mcp,
    },
  };
}

export function expectedMarketplaces(metadata) {
  return {
    openai: {
      name: "project-status-initiative",
      interface: { displayName: "Project Status Initiative" },
      plugins: [
        {
          name: metadata.name,
          source: { source: "local", path: "./plugins/openai/project-status" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: metadata.openai.interface.category,
        },
      ],
    },
    claude: {
      $schema: "https://json.schemastore.org/claude-code-marketplace.json",
      name: "project-status-initiative",
      version: metadata.version,
      description: "Portable Project Status skills and optional read-only MCP tooling.",
      owner: metadata.author,
      plugins: [
        {
          name: metadata.name,
          source: "./plugins/claude/project-status",
          description: metadata.claude.description,
          version: metadata.version,
          author: metadata.author,
          category: "productivity",
          strict: true,
        },
      ],
    },
  };
}

function addExpected(files, relativePath, contents) {
  files.set(relativePath, Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8"));
}

function createExpectedModel() {
  const errors = [];
  const version = readVersion(errors);
  const metadata = jsonFile(METADATA_PATH, "package metadata", errors);
  errors.push(...metadataErrors(metadata, version));
  const mcp = mcpRuntimeModel(version, errors);
  const files = new Map();

  if (!metadata) return { valid: false, errors, version, metadata, mcp, files, manifests: null, marketplaces: null };

  const manifests = expectedPluginManifests(metadata, { mcpEnabled: mcp.enabled });
  const marketplaces = expectedMarketplaces(metadata);
  addExpected(files, ".agents/plugins/marketplace.json", stableJson(marketplaces.openai));
  addExpected(files, ".claude-plugin/marketplace.json", stableJson(marketplaces.claude));
  addExpected(files, "plugins/openai/project-status/.codex-plugin/plugin.json", stableJson(manifests.openai));
  addExpected(files, "plugins/claude/project-status/.claude-plugin/plugin.json", stableJson(manifests.claude));

  try {
    for (const source of walkFiles(canonicalSkillRoot)) {
      for (const host of ["openai", "claude"]) {
        addExpected(files, `plugins/${host}/project-status/skills/project-status/${source.relativePath}`, source.contents);
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

  return {
    valid: errors.length === 0,
    errors,
    version,
    metadata,
    mcp,
    files,
    manifests,
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
    expectedFileCount: expected.files.size,
    actualFileCount: actual.size,
    errors,
    metadata: expected.metadata,
    manifests: expected.manifests,
    marketplaces: expected.marketplaces,
    expectedFiles: expected.files,
  };
}

function writeExpectedFiles(model) {
  if (!model.valid) return;
  for (const root of [openAiPluginRoot, claudePluginRoot]) {
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
