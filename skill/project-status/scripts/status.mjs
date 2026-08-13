#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicProjection, findManifest, readManifest, validateManifest } from "./core.mjs";
import { isDirectExecution } from "./entrypoint.mjs";

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "summary";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = { command, target: null, json: false, markdown: false, project: null, route: "/status", now: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--markdown") options.markdown = true;
    else if (["--project", "--route", "--now"].includes(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--project") options.project = value;
      if (arg === "--route") options.route = value;
      if (arg === "--now") options.now = value;
    }
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (options.target === null) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  options.target ??= process.cwd();
  if (options.now !== null && !Number.isFinite(Date.parse(options.now))) throw new Error("--now must be an RFC 3339 timestamp");
  return options;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatRange(value) {
  return value === null ? "unknown" : `${formatNumber(value.min)}–${formatNumber(value.max)}h`;
}

function formatError(error) {
  return typeof error === "string" ? error : `${error.path}: ${error.message} [${error.code}]`;
}

function freshnessLabel(summary) {
  if (summary.audit.verificationState === "proposal") return "proposal snapshot";
  if (summary.audit.verificationState === "current") return "current snapshot";
  return summary.audit.verificationState.replaceAll("_", " ");
}

export function formatSummary(summary, format = "text") {
  if (format === "json") return JSON.stringify(summary, null, 2);
  if (format === "markdown") {
    return [
      `## ${summary.project} status`,
      "",
      `**Readiness:** ${formatNumber(summary.exactCompletion)}/100 (${summary.displayedCompletion}%)`,
      "",
      ...summary.phases.map((phase) => `- ${phase.name}: ${formatNumber(phase.earnedWeight)}/${formatNumber(phase.weight)} (${formatNumber(phase.completion)}%)`),
      "",
      `Hands-on: ${formatRange(summary.activeHandsOnRemaining)}; deferred: ${formatRange(summary.deferredExpansion)}; unknown estimates: ${summary.time.unknownEstimateTaskIds.length}.`,
      `Blocked: ${summary.blockers.length}; external gates: ${summary.externalGates.length}.`,
      `Manifest freshness: ${freshnessLabel(summary)} as of ${summary.asOf}. This describes the manifest snapshot; no live evidence or service check was performed.`,
    ].join("\n");
  }
  return [
    `${String(summary.project).toUpperCase()} STATUS`,
    `READINESS ${formatNumber(summary.exactCompletion)}/100 · ${summary.displayedCompletion}%`,
    ...summary.phases.map((phase) => `${phase.name}: ${formatNumber(phase.earnedWeight)}/${formatNumber(phase.weight)} · ${formatNumber(phase.completion)}%`),
    `HANDS-ON ${formatRange(summary.activeHandsOnRemaining)} · DEFERRED ${formatRange(summary.deferredExpansion)} · UNKNOWN ESTIMATES ${summary.time.unknownEstimateTaskIds.length}`,
    `BLOCKED ${summary.blockers.length} · EXTERNAL GATES ${summary.externalGates.length}`,
    `MANIFEST FRESHNESS ${freshnessLabel(summary).toUpperCase()} · AS OF ${summary.asOf} · NO LIVE CHECK PERFORMED`,
  ].join("\n");
}

function slug(value) {
  const candidate = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return candidate || "project";
}

function initialize(target, project, route, now) {
  const root = resolve(target);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
  const output = join(root, ".project-status", "manifest.json");
  if (existsSync(output)) throw new Error(`Refusing to overwrite existing manifest: ${output}`);
  const examplePath = fileURLToPath(new URL("../assets/manifest.example.json", import.meta.url));
  const manifest = JSON.parse(readFileSync(examplePath, "utf8"));
  manifest.initiative.name = project ?? basename(root);
  manifest.initiative.id = slug(manifest.initiative.name);
  manifest.route = route ?? "/status";
  manifest.audit.evidenceAsOf = new Date(now ?? Date.now()).toISOString();
  const validation = validateManifest(manifest, { now: manifest.audit.evidenceAsOf });
  if (!validation.valid) throw new Error(`Initialized manifest is invalid:\n${validation.errors.map((error) => `- ${formatError(error)}`).join("\n")}`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return output;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!["find", "init", "validate", "summary", "public"].includes(options.command)) {
    throw new Error("Usage: status.mjs <find|init|validate|summary|public> [project-root|manifest.json] [--json|--markdown|--now <timestamp>]");
  }
  if (options.command === "find") {
    process.stdout.write(`${findManifest(options.target)}\n`);
    return 0;
  }
  if (options.command === "init") {
    process.stdout.write(`${initialize(options.target, options.project, options.route, options.now)}\n`);
    return 0;
  }
  const loaded = readManifest(options.target);
  const clockOptions = options.now ? { now: options.now } : {};
  const validation = validateManifest(loaded.manifest, clockOptions);
  if (options.command === "validate") {
    if (options.json) process.stdout.write(`${JSON.stringify({ path: loaded.path, ...validation }, null, 2)}\n`);
    else {
      for (const warning of validation.warnings) process.stderr.write(`WARNING: ${warning}\n`);
      for (const error of validation.errors) process.stderr.write(`ERROR: ${formatError(error)}\n`);
      if (validation.errors.length === 0) process.stdout.write(`VALID ${loaded.path}\n`);
    }
    return validation.errors.length === 0 ? 0 : 1;
  }
  if (validation.errors.length > 0) {
    for (const error of validation.errors) process.stderr.write(`ERROR: ${formatError(error)}\n`);
    return 1;
  }
  if (options.command === "public") {
    process.stdout.write(`${JSON.stringify(createPublicProjection(loaded.manifest, clockOptions), null, 2)}\n`);
    return 0;
  }
  const format = options.json ? "json" : options.markdown ? "markdown" : "text";
  process.stdout.write(`${formatSummary(validation.summary, format)}\n`);
  for (const warning of validation.warnings) process.stderr.write(`WARNING: ${warning}\n`);
  return 0;
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
