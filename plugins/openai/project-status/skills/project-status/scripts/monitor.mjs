#!/usr/bin/env node
import { resolve } from "node:path";
import { readManifest, validateManifest } from "./core.mjs";
import { isDirectExecution } from "./entrypoint.mjs";
import { assessUrl, mapConcurrent, safeFetch } from "./network.mjs";

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  const rest = command ? argv.slice(1) : argv;
  const options = { command, target: null, json: false, allowLocalhost: false, timeoutMs: 5_000, concurrency: 4, now: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--allow-localhost") options.allowLocalhost = true;
    else if (arg === "--timeout-ms") options.timeoutMs = Number(rest[++index]);
    else if (arg === "--concurrency") options.concurrency = Number(rest[++index]);
    else if (arg === "--now") options.now = rest[++index] ?? null;
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else if (options.target === null) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  options.target ??= process.cwd();
  if (options.command !== "once") throw new Error("Usage: monitor.mjs once [project-root] [--timeout-ms 5000] [--concurrency 4] [--json]");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30_000) throw new Error("--timeout-ms must be between 100 and 30000");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) throw new Error("--concurrency must be between 1 and 10");
  if (options.now !== null && !Number.isFinite(Date.parse(options.now))) throw new Error("--now must be an RFC 3339 timestamp");
  return options;
}

async function observe(check, options) {
  const assessment = assessUrl(check.url, { allowLocalhost: options.allowLocalhost });
  const base = { id: check.id, label: check.label, url: assessment.display, observedAt: options.now ?? new Date().toISOString() };
  if (!assessment.ok) return { ...base, state: "unknown", reason: assessment.reason };
  try {
    const response = await safeFetch(check.url, options);
    const expected = check.expectedStatus;
    const matches = expected === undefined ? response.status >= 200 && response.status < 400 : response.status === expected;
    const state = matches ? "operational" : response.status >= 400 && response.status < 500 ? "degraded" : "unavailable";
    return { ...base, state, httpStatus: response.status, latencyMs: response.latencyMs, redirects: response.redirects };
  } catch (error) {
    return { ...base, state: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function runMonitor(options) {
  const loaded = readManifest(options.target);
  const validation = validateManifest(loaded.manifest, { now: options.now ? new Date(options.now) : undefined });
  if (validation.errors.length > 0) return { valid: false, readOnly: true, errors: validation.errors, warnings: validation.warnings, observations: [] };
  const checks = loaded.manifest.liveChecks ?? [];
  const observations = await mapConcurrent(checks, options.concurrency, (check) => observe(check, options));
  const allOperational = observations.every((observation) => observation.state === "operational");
  return {
    valid: true,
    readOnly: true,
    scheduled: false,
    recorded: false,
    manifestPath: loaded.path,
    manifestDigest: validation.manifestDigest,
    readiness: validation.summary.exactCompletion,
    liveState: observations.length === 0 ? "unknown" : allOperational ? "operational" : "degraded",
    observations,
    warnings: validation.warnings,
  };
}

function format(result) {
  if (!result.valid) return [`MONITOR INVALID`, ...result.errors.map((error) => `- ${error}`)].join("\n");
  return [
    `MONITOR ONCE ${result.liveState.toUpperCase()}`,
    `Readiness remains ${result.readiness}/100`,
    ...result.observations.map((observation) => `- ${observation.label}: ${observation.state}${observation.httpStatus ? ` (${observation.httpStatus})` : ""}`),
    "No observation was recorded or scheduled.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const result = await runMonitor(options);
  process.stdout.write(`${options.json ? JSON.stringify(result, null, 2) : format(result)}\n`);
  if (!result.valid) return 1;
  return result.liveState === "operational" || result.liveState === "unknown" ? 0 : 2;
}

if (isDirectExecution(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
