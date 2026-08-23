#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectRuntimeFiles,
  createDeterministicZip,
} from "../skill/project-status/scripts/package.mjs";
import {
  runGlanceSkillRoot,
  runGlanceClaudePluginRoot,
  inspectReleaseState,
  runGlanceOpenAiPluginRoot,
  releaseRoot,
  stableJson,
} from "./release-sync.mjs";

const ARCHIVE_NAMES = {
  portable: "runglance-portable-claude-skill.zip",
  openai: "runglance-openai-plugin.zip",
  claude: "runglance-claude-plugin.zip",
};
const CHECKSUM_NAME = "checksums.json";
const LEGAL_FILES = [
  "LICENSE",
  "PRIVACY.md",
  "TERMS.md",
  "SECURITY.md",
  "SUPPORT.md",
  "THIRD_PARTY_NOTICES.md",
];
const DEFAULT_OUTPUT_ROOT = join(releaseRoot, "artifacts", "runglance");
const HOME_PREFIXES = [`/${"Users"}/`, `/${"home"}/`, `${"C:"}\\${"Users"}\\`];
const SECRET_PATTERNS = [
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[oprsu]_[A-Za-z0-9_]{24,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["'][^"'\n]{8,}["']/i,
];

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function safeArchivePath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || path.includes("\\")) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function forbiddenRuntimePath(path) {
  return /(?:^|\/)(?:\.git|node_modules|tests?|__[^/]*)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.test\./.test(path);
}

export function scanPackagedContents(path, contents) {
  const errors = [];
  if (!safeArchivePath(path)) errors.push(`unsafe archive path: ${path}`);
  if (forbiddenRuntimePath(path)) errors.push(`test, secret, dependency, or temporary path is not packageable: ${path}`);
  if (!contents.includes(0)) {
    const text = contents.toString("utf8");
    for (const prefix of HOME_PREFIXES) if (text.includes(prefix)) errors.push(`user-home path (${prefix}) is embedded in ${path}`);
    for (const pattern of SECRET_PATTERNS) if (pattern.test(text)) errors.push(`probable secret is embedded in ${path}`);
  }
  return errors;
}

function collectPluginFiles(pluginRoot) {
  const root = resolve(pluginRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Plugin root is not a directory: ${root}`);
  const files = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = toPosix(relative(root, path));
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error(`Symlinks are forbidden in plugin packages: ${relativePath}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const contents = readFileSync(path);
        const errors = scanPackagedContents(relativePath, contents);
        if (errors.length > 0) throw new Error(errors.join("\n"));
        const executable = relativePath.endsWith(".mjs") || relativePath.endsWith(".cjs") && contents.subarray(0, 2).toString() === "#!";
        files.push({ path: relativePath, contents, mode: executable ? 0o100755 : 0o100644 });
      } else throw new Error(`Unsupported plugin entry: ${relativePath}`);
    }
  }

  visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function addInventory(entries) {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const inventory = `${sorted.map((entry) => `${digest(entry.contents)}  ${entry.path}`).join("\n")}\n`;
  const inventoryBytes = Buffer.from(inventory, "utf8");
  return {
    entries: [...sorted, { path: "MANIFEST.sha256", contents: inventoryBytes, mode: 0o100644 }]
      .sort((left, right) => left.path.localeCompare(right.path)),
    contentDigest: digest(inventoryBytes),
  };
}

function legalEntries(prefix = "") {
  const entries = [];
  for (const name of LEGAL_FILES) {
    const path = join(releaseRoot, name);
    if (!existsSync(path)) throw new Error(`${name} is required in every distribution archive`);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const contents = readFileSync(path);
    const errors = scanPackagedContents(archivePath, contents);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    entries.push({ path: archivePath, contents, mode: 0o100644 });
  }
  return entries;
}

function portableEntries() {
  const runtime = collectRuntimeFiles(runGlanceSkillRoot).map((file) => ({
    ...file,
    path: `runglance/${file.path}`,
  }));
  for (const entry of runtime) {
    const errors = scanPackagedContents(entry.path, entry.contents);
    if (errors.length > 0) throw new Error(errors.join("\n"));
  }
  return { runtimeFileCount: runtime.length, ...addInventory([...runtime, ...legalEntries("runglance")]) };
}

function pluginEntries(kind) {
  const pluginRoot = kind === "openai" ? runGlanceOpenAiPluginRoot : runGlanceClaudePluginRoot;
  const entries = [...collectPluginFiles(pluginRoot), ...legalEntries()];
  const requiredManifest = kind === "openai" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
  if (!entries.some((entry) => entry.path === requiredManifest)) throw new Error(`${kind} plugin is missing ${requiredManifest}`);
  if (!entries.some((entry) => entry.path === "skills/runglance/SKILL.md")) throw new Error(`${kind} plugin is missing a physical skills/runglance/SKILL.md`);
  return addInventory(entries);
}

function archive(kind, packaged) {
  const bytes = createDeterministicZip(packaged.entries);
  return {
    name: ARCHIVE_NAMES[kind],
    bytes,
    sha256: digest(bytes),
    size: bytes.length,
    contentDigest: packaged.contentDigest,
    entries: packaged.entries.map((entry) => entry.path),
  };
}

export function createPackagePlan() {
  const release = inspectReleaseState();
  const errors = [...release.errors];
  const archives = {};
  let runtimeFileCount = 0;
  if (errors.length === 0) {
    try {
      const portable = portableEntries();
      runtimeFileCount = portable.runtimeFileCount;
      archives.portable = archive("portable", portable);
      archives.openai = archive("openai", pluginEntries("openai"));
      archives.claude = archive("claude", pluginEntries("claude"));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const checksumPayload = {
    schemaVersion: 1,
    name: "runglance",
    version: release.version,
    archives: Object.fromEntries(Object.entries(archives).map(([kind, value]) => [kind, {
      file: value.name,
      sha256: value.sha256,
      size: value.size,
      contentDigest: value.contentDigest,
    }])),
  };
  const checksumBytes = Buffer.from(stableJson(checksumPayload), "utf8");
  return {
    valid: errors.length === 0,
    errors,
    version: release.version,
    mcpIncluded: release.mcpIncluded,
    runtimeFileCount,
    archives,
    checksumPayload,
    checksumBytes,
  };
}

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = { command, outputRoot: DEFAULT_OUTPUT_ROOT, replace: false, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--output") options.outputRoot = rest[++index] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["plan", "build", "verify"].includes(command) || !options.outputRoot) {
    throw new Error("Usage: package-runglance.mjs <plan|build|verify> [--output dir] [--replace] [--json]");
  }
  options.outputRoot = resolve(options.outputRoot);
  if (options.outputRoot === resolve("/") || options.outputRoot === resolve(homedir())) {
    throw new Error("Refusing a broad filesystem or home-directory output root");
  }
  return options;
}

function visiblePlan(plan, options, operation) {
  return {
    valid: plan.valid,
    operation,
    readOnly: operation !== "build",
    name: "runglance",
    version: plan.version,
    mcpIncluded: plan.mcpIncluded,
    output: options.outputRoot,
    runtimeFileCount: plan.runtimeFileCount,
    archives: Object.fromEntries(Object.entries(plan.archives).map(([kind, value]) => [kind, {
      file: value.name,
      sha256: value.sha256,
      size: value.size,
      contentDigest: value.contentDigest,
      entryCount: value.entries.length,
    }])),
    errors: plan.errors,
  };
}

function writePackages(plan, options) {
  const result = visiblePlan(plan, options, "build");
  if (!plan.valid) return result;
  const outputs = [
    ...Object.values(plan.archives).map((value) => ({ path: join(options.outputRoot, value.name), contents: value.bytes })),
    { path: join(options.outputRoot, CHECKSUM_NAME), contents: plan.checksumBytes },
  ];
  const existing = outputs.filter((output) => existsSync(output.path));
  if (existing.length > 0 && !options.replace) {
    throw new Error(`Refusing existing package artifacts without --replace:\n${existing.map((output) => `- ${output.path}`).join("\n")}`);
  }
  mkdirSync(options.outputRoot, { recursive: true });
  for (const output of outputs) {
    writeFileSync(output.path, output.contents, { flag: existsSync(output.path) ? "w" : "wx", mode: 0o644 });
  }
  return { ...result, written: outputs.map((output) => basename(output.path)) };
}

function verifyPackages(plan, options) {
  const result = visiblePlan(plan, options, "verify");
  if (!plan.valid) return result;
  const errors = [];
  for (const value of Object.values(plan.archives)) {
    const path = join(options.outputRoot, value.name);
    if (!existsSync(path)) errors.push(`missing artifact: ${value.name}`);
    else if (!readFileSync(path).equals(value.bytes)) errors.push(`artifact differs from deterministic build: ${value.name}`);
  }
  const checksumPath = join(options.outputRoot, CHECKSUM_NAME);
  if (!existsSync(checksumPath)) errors.push(`missing artifact: ${CHECKSUM_NAME}`);
  else if (!readFileSync(checksumPath).equals(plan.checksumBytes)) errors.push(`${CHECKSUM_NAME} differs from deterministic build`);
  return {
    ...result,
    valid: errors.length === 0,
    errors,
    verified: errors.length === 0 ? [CHECKSUM_NAME, ...Object.values(ARCHIVE_NAMES)].sort() : [],
  };
}

function format(result) {
  const lines = [
    `PACKAGE ${result.operation.toUpperCase()} ${result.valid ? "OK" : "FAILED"}`,
    `Version: ${result.version ?? "unknown"}`,
    `Runtime files: ${result.runtimeFileCount}`,
    `MCP companion: ${result.mcpIncluded ? "included" : "not built; omitted"}`,
    ...Object.entries(result.archives).map(([kind, value]) => `- ${kind}: ${value.file} ${value.sha256}`),
    ...result.errors.map((error) => `ERROR: ${error}`),
  ];
  if (result.operation === "plan") lines.push("No files were changed.");
  if (result.operation === "build" && result.valid) lines.push("Artifacts were built locally; nothing was installed or published.");
  return lines.join("\n");
}

export function readStoredZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (method !== 0) throw new Error("Package ZIP contains a compressed entry; deterministic packages must use stored entries");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error("Truncated package ZIP entry");
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (!safeArchivePath(name) || entries.has(name)) throw new Error(`Unsafe or duplicate package ZIP entry: ${name}`);
    entries.set(name, buffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return entries;
}

export function listStoredZipEntries(buffer) {
  return [...readStoredZipEntries(buffer).keys()];
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const plan = createPackagePlan();
  const result = options.command === "build"
    ? writePackages(plan, options)
    : options.command === "verify"
      ? verifyPackages(plan, options)
      : visiblePlan(plan, options, "plan");
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  return result.valid ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
