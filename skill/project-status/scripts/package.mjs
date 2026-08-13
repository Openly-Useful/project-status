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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./entrypoint.mjs";
import { stableStringify } from "./core.mjs";

const EMBEDDED_SKILL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED_TOP_LEVEL = new Set(["SKILL.md", "agents", "assets", "references", "scripts"]);
const ARCHIVE_NAMES = {
  portable: "project-status-portable-claude-skill.zip",
  openai: "project-status-openai-plugin.zip",
  claude: "project-status-claude-plugin.zip",
};
const CHECKSUM_NAME = "checksums.json";

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function strictSemver(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function parse(argv, defaults) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = {
    command,
    skillRoot: defaults.skillRoot ?? EMBEDDED_SKILL_ROOT,
    pluginsRoot: defaults.pluginsRoot ?? null,
    outputRoot: defaults.outputRoot ?? resolve(process.cwd(), "artifacts", "skills"),
    replace: false,
    json: false,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--skill-root") options.skillRoot = rest[++index] ?? null;
    else if (arg === "--plugins-root") options.pluginsRoot = rest[++index] ?? null;
    else if (arg === "--output") options.outputRoot = rest[++index] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["plan", "build", "verify"].includes(options.command)) throw new Error("Usage: package.mjs <plan|build|verify> [--output dir] [--replace] [--json]");
  options.skillRoot = resolve(options.skillRoot);
  options.pluginsRoot = options.pluginsRoot ? resolve(options.pluginsRoot) : null;
  options.outputRoot = resolve(options.outputRoot);
  const resolvedHome = resolve(homedir());
  if (options.outputRoot === resolve("/") || options.outputRoot === resolvedHome) throw new Error("Refusing a broad filesystem or home-directory output root");
  return options;
}

function validateMetadata(metadata) {
  const errors = [];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return ["package metadata must be an object"];
  if (metadata.name !== "project-status") errors.push("package name must be project-status");
  if (!strictSemver(metadata.version)) errors.push("package version must be strict semver");
  if (typeof metadata.description !== "string" || !metadata.description.trim()) errors.push("package description is required");
  if (typeof metadata.author?.name !== "string" || !metadata.author.name.trim()) errors.push("package author.name is required");
  const interfaceValue = metadata.openai?.interface;
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    if (typeof interfaceValue?.[field] !== "string" || !interfaceValue[field].trim()) errors.push(`openai.interface.${field} is required`);
  }
  if (!Array.isArray(interfaceValue?.capabilities) || !interfaceValue.capabilities.every((value) => typeof value === "string" && value.trim())) errors.push("openai.interface.capabilities must be strings");
  if (!Array.isArray(interfaceValue?.defaultPrompt) || interfaceValue.defaultPrompt.length < 1 || interfaceValue.defaultPrompt.length > 3) errors.push("openai.interface.defaultPrompt must contain one to three prompts");
  if (typeof metadata.claude?.description !== "string" || !metadata.claude.description.trim()) errors.push("claude.description is required");
  return errors;
}

export function expectedPluginManifests(metadata) {
  return {
    openai: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author,
      skills: "./skills/",
      interface: metadata.openai.interface,
    },
    claude: {
      name: metadata.name,
      version: metadata.version,
      description: metadata.claude.description,
      author: metadata.author,
    },
  };
}

function forbiddenText(contents) {
  if (contents.includes(0)) return null;
  const text = contents.toString("utf8");
  const prefixes = [`/${"Users"}/`, `/${"home"}/`, `${"C:"}\\${"Users"}\\`];
  return prefixes.find((prefix) => text.includes(prefix)) ?? null;
}

function safeArchivePath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || path.includes("\\")) return false;
  return !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function collectRuntimeFiles(skillRoot) {
  const root = resolve(skillRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Skill root is not a directory: ${root}`);
  const files = [];
  function add(path, relativePath) {
    if (!safeArchivePath(relativePath)) throw new Error(`Unsafe runtime path: ${relativePath}`);
    if (relativePath.includes(".test.") || relativePath.startsWith("tests/") || relativePath.includes("/__")) throw new Error(`Test or temporary file is not packageable: ${relativePath}`);
    const contents = readFileSync(path);
    const forbidden = forbiddenText(contents);
    if (forbidden) throw new Error(`Runtime file embeds a user-home path (${forbidden}): ${relativePath}`);
    files.push({ path: relativePath, contents, mode: relativePath.endsWith(".mjs") ? 0o100755 : 0o100644 });
  }
  function visit(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const rel = `${prefix}/${entry.name}`.replaceAll(sep, "/");
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error(`Symlinks are forbidden in runtime packages: ${rel}`);
      if (entry.isDirectory()) visit(path, rel);
      else if (entry.isFile()) add(path, rel);
      else throw new Error(`Unsupported runtime entry: ${rel}`);
    }
  }
  const rootEntries = readdirSync(root).sort();
  for (const entry of rootEntries) {
    if (!ALLOWED_TOP_LEVEL.has(entry)) throw new Error(`Unexpected skill top-level entry: ${entry}`);
    const path = join(root, entry);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlinks are forbidden in runtime packages: ${entry}`);
    if (entry === "SKILL.md" && statSync(path).isFile()) add(path, entry);
    else if (statSync(path).isDirectory()) visit(path, entry);
    else throw new Error(`Invalid skill top-level entry: ${entry}`);
  }
  if (!files.some((file) => file.path === "SKILL.md")) throw new Error("Skill package is missing SKILL.md");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function addInventory(entries) {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const inventory = `${sorted.map((entry) => `${digest(entry.contents)}  ${entry.path}`).join("\n")}\n`;
  return {
    entries: [...sorted, { path: "MANIFEST.sha256", contents: Buffer.from(inventory, "utf8"), mode: 0o100644 }].sort((left, right) => left.path.localeCompare(right.path)),
    contentDigest: digest(Buffer.from(inventory, "utf8")),
    inventory,
  };
}

function archiveEntries(kind, runtimeFiles, manifests) {
  let entries;
  if (kind === "portable") {
    entries = runtimeFiles.map((file) => ({ ...file, path: `project-status/${file.path}` }));
  } else if (kind === "openai") {
    entries = [
      { path: ".codex-plugin/plugin.json", contents: Buffer.from(`${stableStringify(manifests.openai, 2)}\n`, "utf8"), mode: 0o100644 },
      ...runtimeFiles.map((file) => ({ ...file, path: `skills/project-status/${file.path}` })),
    ];
  } else {
    entries = [
      { path: ".claude-plugin/plugin.json", contents: Buffer.from(`${stableStringify(manifests.claude, 2)}\n`, "utf8"), mode: 0o100644 },
      ...runtimeFiles.map((file) => ({ ...file, path: `skills/project-status/${file.path}` })),
    ];
  }
  for (const entry of entries) if (!safeArchivePath(entry.path)) throw new Error(`Unsafe archive path: ${entry.path}`);
  return addInventory(entries);
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, value) => {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      return crc >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

export function createDeterministicZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!safeArchivePath(entry.path)) throw new Error(`Unsafe ZIP path: ${entry.path}`);
    const name = Buffer.from(entry.path, "utf8");
    const contents = Buffer.from(entry.contents);
    const crc = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function listStoredZipEntries(buffer) {
  const names = [];
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    names.push(name);
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}

function sourceWrapperErrors(pluginsRoot, manifests) {
  if (!pluginsRoot) return [];
  const expected = [
    { label: "OpenAI", path: join(pluginsRoot, "openai", "project-status", ".codex-plugin", "plugin.json"), value: manifests.openai },
    { label: "Claude", path: join(pluginsRoot, "claude", "project-status", ".claude-plugin", "plugin.json"), value: manifests.claude },
  ];
  const errors = [];
  for (const wrapper of expected) {
    if (!existsSync(wrapper.path)) { errors.push(`${wrapper.label} source wrapper is missing`); continue; }
    let actual;
    try { actual = JSON.parse(readFileSync(wrapper.path, "utf8")); }
    catch { errors.push(`${wrapper.label} source wrapper is invalid JSON`); continue; }
    if (stableStringify(actual) !== stableStringify(wrapper.value)) errors.push(`${wrapper.label} source wrapper differs from package metadata`);
  }
  return errors;
}

export function createPackagePlan(options) {
  const metadataPath = join(options.skillRoot, "assets", "package-metadata.json");
  if (!existsSync(metadataPath)) throw new Error(`Package metadata is missing: ${metadataPath}`);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const errors = validateMetadata(metadata);
  const manifests = expectedPluginManifests(metadata);
  errors.push(...sourceWrapperErrors(options.pluginsRoot, manifests));
  let runtimeFiles = [];
  try { runtimeFiles = collectRuntimeFiles(options.skillRoot); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const archives = {};
  if (errors.length === 0) {
    for (const kind of Object.keys(ARCHIVE_NAMES)) {
      const packaged = archiveEntries(kind, runtimeFiles, manifests);
      const bytes = createDeterministicZip(packaged.entries);
      archives[kind] = {
        name: ARCHIVE_NAMES[kind],
        bytes,
        sha256: digest(bytes),
        size: bytes.length,
        contentDigest: packaged.contentDigest,
        entries: packaged.entries.map((entry) => entry.path),
      };
    }
  }
  const checksumPayload = {
    schemaVersion: 1,
    name: metadata.name,
    version: metadata.version,
    archives: Object.fromEntries(Object.entries(archives).map(([kind, archive]) => [kind, {
      file: archive.name,
      sha256: archive.sha256,
      size: archive.size,
      contentDigest: archive.contentDigest,
    }])),
  };
  const checksumBytes = Buffer.from(`${stableStringify(checksumPayload, 2)}\n`, "utf8");
  return { valid: errors.length === 0, errors, metadata, manifests, runtimeFiles, archives, checksumPayload, checksumBytes };
}

function visiblePlan(plan, options, operation) {
  return {
    valid: plan.valid,
    operation,
    readOnly: operation !== "build",
    name: plan.metadata?.name ?? null,
    version: plan.metadata?.version ?? null,
    output: options.outputRoot,
    runtimeFileCount: plan.runtimeFiles.length,
    archives: Object.fromEntries(Object.entries(plan.archives).map(([kind, archive]) => [kind, {
      file: archive.name,
      sha256: archive.sha256,
      size: archive.size,
      contentDigest: archive.contentDigest,
      entryCount: archive.entries.length,
    }])),
    errors: plan.errors,
  };
}

function writePackages(plan, options) {
  if (!plan.valid) return visiblePlan(plan, options, "build");
  const outputs = [
    ...Object.values(plan.archives).map((archive) => ({ path: join(options.outputRoot, archive.name), contents: archive.bytes })),
    { path: join(options.outputRoot, CHECKSUM_NAME), contents: plan.checksumBytes },
  ];
  const existing = outputs.filter((output) => existsSync(output.path));
  if (existing.length > 0 && !options.replace) throw new Error(`Refusing existing package artifacts without --replace:\n${existing.map((output) => `- ${output.path}`).join("\n")}`);
  mkdirSync(options.outputRoot, { recursive: true });
  for (const output of outputs) writeFileSync(output.path, output.contents, { flag: existsSync(output.path) ? "w" : "wx", mode: 0o644 });
  return { ...visiblePlan(plan, options, "build"), written: outputs.map((output) => basename(output.path)) };
}

function verifyPackages(plan, options) {
  const result = visiblePlan(plan, options, "verify");
  if (!plan.valid) return result;
  const errors = [];
  for (const archive of Object.values(plan.archives)) {
    const path = join(options.outputRoot, archive.name);
    if (!existsSync(path)) errors.push(`missing artifact: ${archive.name}`);
    else if (Buffer.compare(readFileSync(path), archive.bytes) !== 0) errors.push(`artifact differs from deterministic build: ${archive.name}`);
  }
  const checksumPath = join(options.outputRoot, CHECKSUM_NAME);
  if (!existsSync(checksumPath)) errors.push(`missing artifact: ${CHECKSUM_NAME}`);
  else if (Buffer.compare(readFileSync(checksumPath), plan.checksumBytes) !== 0) errors.push(`${CHECKSUM_NAME} differs from deterministic build`);
  return { ...result, valid: errors.length === 0, errors, verified: errors.length === 0 ? [CHECKSUM_NAME, ...Object.values(ARCHIVE_NAMES)].sort() : [] };
}

function format(result) {
  const lines = [
    `PACKAGE ${result.operation.toUpperCase()} ${result.valid ? "OK" : "FAILED"}`,
    `Version: ${result.version ?? "unknown"}`,
    `Runtime files: ${result.runtimeFileCount}`,
    ...Object.entries(result.archives).map(([kind, archive]) => `- ${kind}: ${archive.file} ${archive.sha256}`),
    ...(result.errors ?? []).map((error) => `ERROR: ${error}`),
  ];
  if (result.operation === "plan") lines.push("No files were changed.");
  if (result.operation === "build") lines.push("Artifacts were built locally; nothing was installed or published.");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), defaults = {}) {
  const options = parse(argv, defaults);
  const plan = createPackagePlan(options);
  const result = options.command === "build" ? writePackages(plan, options) : options.command === "verify" ? verifyPackages(plan, options) : visiblePlan(plan, options, "plan");
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  return result.valid ? 0 : 1;
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
