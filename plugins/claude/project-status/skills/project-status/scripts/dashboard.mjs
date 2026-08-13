#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicProjection, isWithin, readManifest, stableStringify, validateManifest } from "./core.mjs";
import { isDirectExecution } from "./entrypoint.mjs";

const TEMPLATE_DIRECTORY = fileURLToPath(new URL("../assets/dashboard-static", import.meta.url));
const STATIC_FILES = ["index.html", "status.css", "status.js"];

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = { command, target: null, output: null, json: false, replace: false, now: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--output") options.output = rest[++index] ?? null;
    else if (arg === "--now") options.now = rest[++index] ?? null;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (options.target === null) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  options.target ??= process.cwd();
  if (!["plan", "apply", "check"].includes(options.command)) throw new Error("Usage: dashboard.mjs <plan|apply|check> [project-root] [--output relative-dir] [--json]");
  if (options.now !== null && !Number.isFinite(Date.parse(options.now))) throw new Error("--now must be an RFC 3339 timestamp");
  return options;
}

function detectFramework(root) {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return { name: "static", recommendedOutput: "status" };
  try {
    const payload = JSON.parse(readFileSync(packagePath, "utf8"));
    const dependencies = { ...(payload.dependencies ?? {}), ...(payload.devDependencies ?? {}) };
    if (dependencies.next) return { name: "next", recommendedOutput: "public/status" };
    if (dependencies.vite || dependencies.react || dependencies["@vitejs/plugin-react"]) return { name: "vite", recommendedOutput: "public/status" };
  } catch {
    return { name: "unknown", recommendedOutput: "status" };
  }
  return { name: "node", recommendedOutput: "public/status" };
}

function safeOutput(root, value) {
  if (typeof value !== "string" || value.trim().length === 0 || isAbsolute(value)) throw new Error("--output must be a non-empty project-relative directory");
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
  if (normalized === "." || normalized.split("/").some((part) => part === "" || part === "..")) throw new Error("--output must stay within a dedicated project subdirectory");
  const output = resolve(root, normalized);
  if (!isWithin(root, output) || output === resolve(root)) throw new Error("--output escapes the project root");
  return { normalized, output };
}

function expectedFiles(manifest, validation) {
  const files = new Map();
  for (const name of STATIC_FILES) files.set(name, readFileSync(join(TEMPLATE_DIRECTORY, name)));
  files.set("status.json", Buffer.from(`${stableStringify(createPublicProjection(manifest, validation), 2)}\n`, "utf8"));
  return files;
}

function inspectOutput(output, expected) {
  const states = [];
  for (const [name, contents] of expected) {
    const path = join(output, name);
    if (!existsSync(path)) states.push({ name, state: "missing" });
    else if (!statSync(path).isFile()) states.push({ name, state: "conflict" });
    else if (Buffer.compare(readFileSync(path), contents) === 0) states.push({ name, state: "current" });
    else states.push({ name, state: "conflict" });
  }
  const expectedNames = new Set(expected.keys());
  const unexpected = existsSync(output) && statSync(output).isDirectory()
    ? readdirSync(output).filter((name) => !expectedNames.has(name)).sort()
    : [];
  return { states, unexpected };
}

export function planDashboard(options) {
  const target = resolve(options.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`Project root is not a directory: ${target}`);
  const loaded = readManifest(target);
  const validation = validateManifest(loaded.manifest, { now: options.now ? new Date(options.now) : undefined });
  if (validation.errors.length > 0) return { valid: false, operation: options.command, readOnly: options.command !== "apply", manifestPath: loaded.path, errors: validation.errors, warnings: validation.warnings };
  const framework = detectFramework(target);
  const selected = safeOutput(target, options.output ?? framework.recommendedOutput);
  const expected = expectedFiles(loaded.manifest, validation);
  const inspected = inspectOutput(selected.output, expected);
  return {
    valid: true,
    operation: options.command,
    readOnly: options.command !== "apply",
    projectRoot: target,
    manifestPath: loaded.path,
    manifestDigest: validation.manifestDigest,
    route: loaded.manifest.route,
    framework: framework.name,
    output: selected.normalized,
    files: inspected.states,
    unexpectedFiles: inspected.unexpected,
    conflicts: inspected.states.filter((entry) => entry.state === "conflict").map((entry) => entry.name),
    integrationRequired: ["next", "vite", "node"].includes(framework.name),
    integrationNote: "Verify that the host serves the generated directory at the declared route; some frameworks need an explicit rewrite or route adapter.",
    warnings: validation.warnings,
    _outputPath: selected.output,
    _expected: expected,
  };
}

function publicResult(result) {
  const { _outputPath, _expected, ...visible } = result;
  return visible;
}

function applyDashboard(options, plan) {
  if (!plan.valid) return plan;
  if (plan.conflicts.length > 0 && !options.replace) throw new Error(`Refusing to replace generated conflicts without --replace: ${plan.conflicts.join(", ")}`);
  mkdirSync(plan._outputPath, { recursive: true });
  const written = [];
  for (const [name, contents] of plan._expected) {
    const path = join(plan._outputPath, name);
    if (existsSync(path) && Buffer.compare(readFileSync(path), contents) === 0) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { flag: existsSync(path) ? "w" : "wx" });
    written.push(name);
  }
  const checked = planDashboard({ ...options, command: "check" });
  return { ...publicResult(checked), operation: "apply", readOnly: false, written, replaced: options.replace ? plan.conflicts : [] };
}

function checkDashboard(plan) {
  if (!plan.valid) return plan;
  const errors = plan.files.filter((entry) => entry.state !== "current").map((entry) => `${entry.name} is ${entry.state}`);
  return { ...publicResult(plan), valid: errors.length === 0, errors };
}

function format(result) {
  if (!result.valid) return [`DASHBOARD ${result.operation.toUpperCase()} FAILED`, ...(result.errors ?? []).map((error) => `- ${error}`)].join("\n");
  const lines = [
    `DASHBOARD ${result.operation.toUpperCase()}`,
    `Framework: ${result.framework}`,
    `Output: ${result.output}`,
    `Route: ${result.route}`,
    ...result.files.map((file) => `- ${file.name}: ${file.state}`),
  ];
  if (result.operation === "plan") lines.push("No files were changed.");
  if (result.integrationRequired) lines.push(result.integrationNote);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const plan = planDashboard(options);
  const result = options.command === "apply" ? applyDashboard(options, plan) : options.command === "check" ? checkDashboard(plan) : publicResult(plan);
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  return result.valid ? 0 : 1;
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
