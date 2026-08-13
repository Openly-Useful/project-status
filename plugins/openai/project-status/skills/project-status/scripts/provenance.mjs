#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { readManifest, validateManifest, validTimestamp } from "./core.mjs";
import { isDirectExecution } from "./entrypoint.mjs";
import { assessUrl, mapConcurrent, safeFetch } from "./network.mjs";

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = { command, target: null, json: false, network: false, allowLocalhost: false, timeoutMs: 5_000, concurrency: 4, maxAgeHours: null, now: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--network") options.network = true;
    else if (arg === "--allow-localhost") options.allowLocalhost = true;
    else if (["--timeout-ms", "--concurrency", "--max-age-hours", "--now"].includes(arg)) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--timeout-ms") options.timeoutMs = Number(value);
      if (arg === "--concurrency") options.concurrency = Number(value);
      if (arg === "--max-age-hours") options.maxAgeHours = Number(value);
      if (arg === "--now") options.now = value;
    } else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (options.target === null) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  options.target ??= process.cwd();
  if (!["plan", "verify"].includes(options.command)) throw new Error("Usage: provenance.mjs <plan|verify> [project-root] [--network] [--json]");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) throw new Error("--timeout-ms must be between 100 and 30000");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) throw new Error("--concurrency must be between 1 and 10");
  if (options.maxAgeHours !== null && (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0)) throw new Error("--max-age-hours must be positive");
  if (options.now !== null && !Number.isFinite(Date.parse(options.now))) throw new Error("--now must be an RFC 3339 timestamp");
  return options;
}

function evidenceEntries(manifest) {
  const taskIdsByEvidence = new Map(manifest.evidence.map((item) => [item.id, []]));
  for (const phase of manifest.phases) {
    for (const task of phase.tasks) {
      for (const evidenceId of task.evidenceRefs) taskIdsByEvidence.get(evidenceId)?.push(task.id);
    }
  }
  return manifest.evidence.map((item) => ({
    evidenceId: item.id,
    taskIds: [...taskIdsByEvidence.get(item.id)].sort(),
    kind: item.kind,
    tier: item.tier,
    state: item.state,
    visibility: item.visibility,
    capturedAt: item.capturedAt,
    verifiedAt: item.verifiedAt,
    expiresAt: item.expiresAt,
    locator: item.locator,
    integrity: item.integrity,
  }));
}

function freshness(entry, options) {
  const now = options.now ? Date.parse(options.now) : Date.now();
  const ageHours = validTimestamp(entry.verifiedAt)
    ? Math.max(0, (now - Date.parse(entry.verifiedAt)) / 3_600_000)
    : null;
  const expired = validTimestamp(entry.expiresAt) && Date.parse(entry.expiresAt) <= now;
  const exceedsMaxAge = options.maxAgeHours !== null && ageHours !== null && ageHours > options.maxAgeHours;
  return { ageHours, expired, stale: entry.state === "stale" || expired || exceedsMaxAge };
}

function visibleLocator(entry, value) {
  return entry.visibility === "public" ? value : "<redacted>";
}

function baseResult(entry, freshnessResult) {
  return {
    evidenceId: entry.evidenceId,
    taskIds: entry.taskIds,
    kind: entry.kind,
    locatorType: entry.locator.type,
    visibility: entry.visibility,
    capturedAt: entry.capturedAt,
    verifiedAt: entry.verifiedAt,
    freshness: freshnessResult,
  };
}

function verifyFile(entry, base) {
  const path = entry.locator.path;
  if (!isAbsolute(path)) return { ...base, status: "unsafe", reason: "file locator is not absolute" };
  if (!existsSync(path)) return { ...base, status: "missing", reason: "declared file does not exist" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { ...base, status: "unsafe", reason: "evidence file must not be a symbolic link" };
  if (!stat.isFile()) return { ...base, status: "unsafe", reason: "evidence locator is not a regular file" };
  const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (entry.integrity?.digest && digest !== entry.integrity.digest) {
    return { ...base, status: "mismatch", reason: "SHA-256 digest mismatch" };
  }
  if (!entry.integrity) return { ...base, status: base.freshness.stale ? "stale" : "unverified", reason: "no integrity digest is declared" };
  return { ...base, status: base.freshness.stale ? "stale" : "verified" };
}

async function verifyUrl(entry, base, options) {
  const assessment = assessUrl(entry.locator.url, { allowLocalhost: options.allowLocalhost });
  const locator = visibleLocator(entry, assessment.display);
  if (!assessment.ok) return { ...base, locator, status: "unsafe", reason: assessment.reason };
  if (!options.network) return { ...base, locator, status: base.freshness.stale ? "stale" : "unverified", reason: "network verification not requested" };
  try {
    const response = await safeFetch(entry.locator.url, options);
    const status = response.status >= 200 && response.status < 400 ? (base.freshness.stale ? "stale" : "verified") : "unreachable";
    return { ...base, locator: visibleLocator(entry, response.finalUrl), status, httpStatus: response.status, latencyMs: response.latencyMs };
  } catch (error) {
    return { ...base, locator, status: "unreachable", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function verifyEntry(entry, options) {
  const age = freshness(entry, options);
  const base = baseResult(entry, age);
  if (entry.state === "revoked") return { ...base, status: "revoked", reason: "evidence record is revoked" };
  if (entry.state === "unverified") return { ...base, status: "unverified", reason: "evidence record is declared unverified" };
  if (entry.locator.type === "file") return verifyFile(entry, base);
  if (entry.locator.type === "url") return verifyUrl(entry, base, options);
  if (entry.locator.type === "artifact" && entry.integrity && entry.locator.digest !== entry.integrity.digest) {
    return { ...base, status: "mismatch", reason: "artifact locator and integrity digests disagree" };
  }
  return {
    ...base,
    status: age.stale ? "stale" : "unverified",
    reason: `${entry.locator.type} evidence requires an independent verifier`,
  };
}

function hardFailure(result) {
  return ["missing", "mismatch", "unsafe", "unreachable", "revoked"].includes(result.status);
}

function formatError(error) {
  return typeof error === "string" ? error : `${error.path}: ${error.message} [${error.code}]`;
}

export async function runProvenance(options) {
  const loaded = readManifest(options.target);
  const clockOptions = options.now ? { now: options.now } : {};
  const validation = validateManifest(loaded.manifest, clockOptions);
  if (validation.errors.length > 0) {
    return { valid: false, manifestPath: loaded.path, manifestDigest: validation.manifestDigest, errors: validation.errors, warnings: validation.warnings, results: [] };
  }
  const entries = evidenceEntries(loaded.manifest);
  const preview = entries.map((entry) => ({
    evidenceId: entry.evidenceId,
    taskIds: entry.taskIds,
    kind: entry.kind,
    locatorType: entry.locator.type,
    visibility: entry.visibility,
    network: entry.locator.type === "url",
  }));
  if (options.command === "plan") {
    return { valid: true, operation: "plan", readOnly: true, manifestPath: loaded.path, manifestDigest: validation.manifestDigest, evidenceCount: entries.length, networkEnabled: options.network, entries: preview, warnings: validation.warnings };
  }
  const results = await mapConcurrent(entries, options.concurrency, (entry) => verifyEntry(entry, options));
  return {
    valid: !results.some(hardFailure),
    operation: "verify",
    readOnly: true,
    manifestPath: loaded.path,
    manifestDigest: validation.manifestDigest,
    networkEnabled: options.network,
    results,
    counts: Object.fromEntries([...new Set(results.map((result) => result.status))].sort().map((status) => [status, results.filter((result) => result.status === status).length])),
    warnings: validation.warnings,
  };
}

function format(result) {
  if (!result.valid && result.errors) return ["PROVENANCE INVALID", ...result.errors.map((error) => `- ${formatError(error)}`)].join("\n");
  if (result.operation === "plan") return `PROVENANCE PLAN\nEvidence: ${result.evidenceCount}\nNetwork: ${result.networkEnabled ? "enabled" : "disabled"}\nNo files will be changed.`;
  return [`PROVENANCE ${result.valid ? "VALID" : "FAILED"}`, ...result.results.map((entry) => `- ${entry.evidenceId} ${entry.locatorType}: ${entry.status}`)].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const result = await runProvenance(options);
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  return result.valid ? 0 : 1;
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
