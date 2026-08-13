#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution } from "./entrypoint.mjs";

const ALLOWED_TOP_LEVEL = new Set(["SKILL.md", "agents", "assets", "references", "scripts"]);
const SKILL_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = { command, target: null, mode: "symlink", json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--mode") options.mode = rest[++index] ?? null;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (options.target === null) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  options.target ??= process.cwd();
  if (!["plan", "apply", "verify"].includes(options.command)) throw new Error("Usage: attach.mjs <plan|apply|verify> <project-root> [--mode symlink|copy] [--json]");
  if (!["symlink", "copy"].includes(options.mode)) throw new Error("--mode must be symlink or copy");
  return options;
}

function safeProjectRoot(value) {
  const root = resolve(value);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const resolvedHome = resolve(homedir());
  if (root === resolve("/") || root === resolvedHome) throw new Error("Refusing to attach at a broad filesystem or home-directory root");
  return realpathSync(root);
}

function walkRuntime(root) {
  const files = [];
  function visit(path, relativePath) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime skill contains a symlink: ${rel}`);
      if (entry.isDirectory()) { visit(full, rel); continue; }
      if (!entry.isFile()) throw new Error(`Runtime skill contains an unsupported entry: ${rel}`);
      if (rel.includes(".test.") || rel.startsWith("tests/")) throw new Error(`Runtime allowlist rejected test file: ${rel}`);
      files.push({ relativePath: rel.replaceAll(sep, "/"), fullPath: full, contents: readFileSync(full) });
    }
  }
  for (const name of [...ALLOWED_TOP_LEVEL].sort()) {
    const full = join(root, name);
    if (!existsSync(full)) continue;
    if (name === "SKILL.md") files.push({ relativePath: name, fullPath: full, contents: readFileSync(full) });
    else visit(full, name);
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function filesDigest(files) {
  const inventory = files.map((file) => `${createHash("sha256").update(file.contents).digest("hex")}  ${file.relativePath}`).join("\n");
  return createHash("sha256").update(`${inventory}\n`).digest("hex");
}

function treeFiles(root) {
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return null;
  const files = [];
  function visit(path, rel) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Attached copy contains a symlink: ${nextRel}`);
      if (entry.isDirectory()) visit(full, nextRel);
      else if (entry.isFile()) files.push({ relativePath: nextRel, fullPath: full, contents: readFileSync(full) });
      else throw new Error(`Attached copy contains an unsupported entry: ${nextRel}`);
    }
  }
  visit(root, "");
  return files;
}

function sameTree(path, sourceDigest) {
  try {
    const files = treeFiles(path);
    return files !== null && filesDigest(files) === sourceDigest;
  } catch {
    return false;
  }
}

function relativeLinkResolvesTo(path, canonical) {
  if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) return false;
  try {
    const raw = readlinkSync(path);
    if (raw.startsWith("/")) return false;
    return realpathSync(resolve(dirname(path), raw)) === realpathSync(canonical);
  } catch {
    return false;
  }
}

function inspectPath(path, expectedKind, canonical, sourceDigest) {
  if (!existsSync(path)) return "missing";
  if (expectedKind === "canonical") return sameTree(path, sourceDigest) ? "current" : "conflict";
  if (expectedKind === "symlink") return relativeLinkResolvesTo(path, canonical) ? "current" : "conflict";
  return sameTree(path, sourceDigest) ? "current" : "conflict";
}

function copyRuntime(files, destination) {
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const output = join(destination, file.relativePath);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, file.contents, { flag: "wx", mode: file.relativePath.endsWith(".mjs") ? 0o755 : 0o644 });
  }
}

export function inspectAttachment(options) {
  const root = safeProjectRoot(options.target);
  const sourceFiles = walkRuntime(SKILL_ROOT);
  const sourceDigest = filesDigest(sourceFiles);
  const canonical = join(root, ".agent-skills", "project-status");
  const discoveries = [join(root, ".agents", "skills", "project-status"), join(root, ".claude", "skills", "project-status")];
  const canonicalState = inspectPath(canonical, "canonical", canonical, sourceDigest);
  const expectedKind = options.mode;
  const targets = [
    { role: "canonical", path: canonical, state: canonicalState },
    ...discoveries.map((path) => ({ role: expectedKind, path, state: inspectPath(path, expectedKind, canonical, sourceDigest) })),
  ];
  return { root, sourceFiles, sourceDigest, canonical, discoveries, targets };
}

function visible(result, operation, mode) {
  return {
    valid: result.targets.every((target) => target.state !== "conflict"),
    operation,
    readOnly: operation !== "apply",
    mode,
    projectRoot: result.root,
    sourceDigest: result.sourceDigest,
    targets: result.targets.map(({ role, path, state }) => ({ role, path: relative(result.root, path).replaceAll(sep, "/"), state })),
  };
}

function applyAttachment(options, inspected) {
  const conflicts = inspected.targets.filter((target) => target.state === "conflict");
  if (conflicts.length > 0) throw new Error(`Refusing attachment conflicts:\n${conflicts.map((target) => `- ${target.path}`).join("\n")}`);
  const written = [];
  if (inspected.targets[0].state === "missing") {
    copyRuntime(inspected.sourceFiles, inspected.canonical);
    written.push(relative(inspected.root, inspected.canonical).replaceAll(sep, "/"));
  }
  for (const [index, discovery] of inspected.discoveries.entries()) {
    if (inspected.targets[index + 1].state === "current") continue;
    mkdirSync(dirname(discovery), { recursive: true });
    if (options.mode === "symlink") {
      const link = relative(dirname(discovery), inspected.canonical);
      symlinkSync(link, discovery, "dir");
    } else {
      copyRuntime(inspected.sourceFiles, discovery);
    }
    written.push(relative(inspected.root, discovery).replaceAll(sep, "/"));
  }
  const checked = inspectAttachment(options);
  const output = visible(checked, "apply", options.mode);
  return { ...output, written };
}

function verifyAttachment(options) {
  const root = safeProjectRoot(options.target);
  const sourceFiles = walkRuntime(SKILL_ROOT);
  const sourceDigest = filesDigest(sourceFiles);
  const canonical = join(root, ".agent-skills", "project-status");
  const discoveries = [join(root, ".agents", "skills", "project-status"), join(root, ".claude", "skills", "project-status")];
  const targets = [
    { role: "canonical", path: canonical, state: inspectPath(canonical, "canonical", canonical, sourceDigest) },
    ...discoveries.map((path) => {
      const state = relativeLinkResolvesTo(path, canonical) || sameTree(path, sourceDigest) ? "current" : existsSync(path) ? "conflict" : "missing";
      return { role: lstatSafe(path)?.isSymbolicLink() ? "symlink" : "copy", path, state };
    }),
  ];
  return visible({ root, sourceDigest, targets }, "verify", "mixed");
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

function format(result) {
  return [
    `ATTACH ${result.operation.toUpperCase()} ${result.valid ? "OK" : "FAILED"}`,
    `Mode: ${result.mode}`,
    `Digest: ${result.sourceDigest}`,
    ...result.targets.map((target) => `- ${target.path}: ${target.state}`),
    ...(result.operation === "plan" ? ["No files were changed."] : []),
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  let result;
  if (options.command === "verify") result = verifyAttachment(options);
  else {
    const inspected = inspectAttachment(options);
    result = options.command === "apply" ? applyAttachment(options, inspected) : visible(inspected, "plan", options.mode);
  }
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  return result.valid ? 0 : 1;
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
