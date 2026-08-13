import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MANIFEST_SCHEMA as CORE_SCHEMA,
  calculateStatus as calculateCoreStatus,
  createPublicProjection as createCorePublicProjection,
  validateManifest as validateCoreManifest,
} from "../packages/core/index.mjs";
import {
  MANIFEST_SCHEMA as PORTABLE_SCHEMA,
  calculateStatus as calculatePortableStatus,
  createPublicProjection as createPortablePublicProjection,
  validateManifest as validatePortableManifest,
} from "../skill/project-status/scripts/core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scripts = join(root, "skill", "project-status", "scripts");
const repositoryManifestPath = join(root, ".project-status", "manifest.json");
const repositoryManifest = JSON.parse(readFileSync(repositoryManifestPath, "utf8"));
const now = repositoryManifest.audit.evidenceAsOf;

function clone(value = repositoryManifest) {
  return structuredClone(value);
}

function fixture(manifest = repositoryManifest) {
  const directory = mkdtempSync(join(tmpdir(), "project-status-cli-"));
  mkdirSync(join(directory, ".project-status"), { recursive: true });
  writeFileSync(join(directory, ".project-status", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({ dependencies: { vite: "1.0.0" } }, null, 2)}\n`);
  return directory;
}

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [join(scripts, script), ...args], { cwd: options.cwd ?? root, encoding: "utf8" });
}

function errorCodes(validation) {
  return new Set(validation.errors.map((error) => error.code));
}

test("repository manifest validates through core and the portable CLI at exactly 61/100", () => {
  assert.deepEqual(PORTABLE_SCHEMA, CORE_SCHEMA);
  assert.deepEqual(validateCoreManifest(repositoryManifest), { valid: true, errors: [] });
  assert.equal(validatePortableManifest(repositoryManifest, { now }).valid, true);
  assert.deepEqual(calculatePortableStatus(repositoryManifest, { now }), calculateCoreStatus(repositoryManifest, { now }));

  const cli = run("status.mjs", ["validate", repositoryManifestPath, "--json", "--now", now]);
  assert.equal(cli.status, 0, cli.stderr);
  const validation = JSON.parse(cli.stdout);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.summary.score.earnedWeight, 61);
  assert.equal(validation.summary.score.totalWeight, 100);
  assert.equal(validation.summary.score.displayPercent, 61);
  assert.equal(validation.summary.tasks.total, 16);
  assert.deepEqual(validation.warnings, []);
});

test("portable validation and projection sample an injected clock once per operation", () => {
  let calls = 0;
  const clock = () => {
    calls += 1;
    return new Date(now);
  };
  assert.equal(validatePortableManifest(repositoryManifest, { clock }).summary.asOf, now);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(createPortablePublicProjection(repositoryManifest, { clock }).manifestFreshness.asOf, now);
  assert.equal(calls, 1);
});

test("portable validation rejects unknown versions and properties, invalid enums, unsafe routes, and reversed ranges", () => {
  const directory = fixture();
  const candidate = clone();
  candidate.schemaVersion = 999;
  candidate.route = "/status/%2e%2e/private";
  candidate.extra = true;
  candidate.phases[0].tasks[2].status = "almost_done";
  candidate.phases[0].tasks[2].remainingHours = { min: 8, max: 2 };
  candidate.phases[0].tasks[2].owner.privateNote = "reject me";
  writeFileSync(join(directory, ".project-status", "manifest.json"), `${JSON.stringify(candidate, null, 2)}\n`);

  const cli = run("status.mjs", ["validate", directory, "--json", "--now", now]);
  assert.equal(cli.status, 1, cli.stderr);
  const validation = JSON.parse(cli.stdout);
  assert.equal(validation.valid, false);
  const codes = errorCodes(validation);
  assert.ok(codes.has("unsupported_schema_version"));
  assert.ok(codes.has("unknown_property"));
  assert.ok(codes.has("invalid_enum"));
  assert.ok(codes.has("invalid_route"));
  assert.ok(codes.has("invalid_range"));
  assert.ok(validation.errors.some((error) => error.path.endsWith(".owner.privateNote")));
});

test("portable validation reports malformed reference collections without crashing", () => {
  const candidate = clone();
  candidate.phases[0].tasks[0].evidenceRefs = "audit-divergence";
  candidate.gates[0].taskRefs = { task: "source-deployment-binding" };
  const validation = validatePortableManifest(candidate, { now });
  assert.equal(validation.valid, false);
  assert.ok(errorCodes(validation).has("expected_array"));
});

test("summary is deterministic and labels manifest freshness without claiming a live check", () => {
  const directory = fixture();
  const text = run("status.mjs", ["summary", directory, "--now", now]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /READINESS 61\/100 · 61%/);
  assert.match(text.stdout, /MANIFEST FRESHNESS CURRENT SNAPSHOT/);
  assert.match(text.stdout, /NO LIVE CHECK PERFORMED/);

  const markdown = run("status.mjs", ["summary", directory, "--markdown", "--now", now]);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /\*\*Readiness:\*\* 61\/100 \(61%\)/);
  assert.match(markdown.stdout, /Manifest freshness: current snapshot/);
  assert.match(markdown.stdout, /no live evidence or service check was performed/i);

  const json = run("status.mjs", ["summary", directory, "--json", "--now", now]);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).asOf, now);
});

test("public CLI projection matches core and redacts private locators, identities, and restricted integrity", () => {
  const directory = fixture();
  const cli = run("status.mjs", ["public", directory, "--now", now]);
  assert.equal(cli.status, 0, cli.stderr);
  const projection = JSON.parse(cli.stdout);
  assert.deepEqual(projection, createCorePublicProjection(repositoryManifest, { now }));
  assert.deepEqual(projection, createPortablePublicProjection(repositoryManifest, { now }));
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /\/Users\//);
  assert.doesNotMatch(serialized, /project-ambient-dashboard-audit:/);
  assert.doesNotMatch(serialized, /dashboard-audit-agent/);
  assert.doesNotMatch(serialized, /e4f23473d84a798eb9aab30d6db5461f66a866442dd37b2261567758cf86ebe3/);
  assert.equal(projection.route, "/status");
  assert.equal(projection.score.earnedWeight, 61);
  assert.equal(projection.manifestFreshness.basis, "manifest_snapshot");
  assert.equal(projection.liveHealth.state, "unknown");
});

test("find locates one canonical manifest and refuses ambiguous discovery", () => {
  const directory = fixture();
  const found = run("status.mjs", ["find", directory]);
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), join(directory, ".project-status", "manifest.json"));

  mkdirSync(join(directory, "status"));
  writeFileSync(join(directory, "status", "manifest.json"), `${JSON.stringify(repositoryManifest, null, 2)}\n`);
  const ambiguous = run("status.mjs", ["find", directory]);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /Multiple project-status manifests found/);
});

test("init writes a zero-credit canonical proposal with an injected timestamp and refuses unsafe routes or overwrite", () => {
  const directory = mkdtempSync(join(tmpdir(), "project-status-init-"));
  const initialized = run("status.mjs", ["init", directory, "--project", "Launch Console", "--route", "/ops/status", "--now", now]);
  assert.equal(initialized.status, 0, initialized.stderr);
  const path = join(directory, ".project-status", "manifest.json");
  assert.equal(initialized.stdout.trim(), path);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.initiative.id, "launch-console");
  assert.equal(manifest.initiative.name, "Launch Console");
  assert.equal(manifest.route, "/ops/status");
  assert.equal(manifest.audit.evidenceAsOf, now);
  assert.equal(validateCoreManifest(manifest, { now }).valid, true);
  assert.equal(calculateCoreStatus(manifest, { now }).score.earnedWeight, 0);

  const overwrite = run("status.mjs", ["init", directory, "--now", now]);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /Refusing to overwrite existing manifest/);

  const unsafeDirectory = mkdtempSync(join(tmpdir(), "project-status-init-unsafe-"));
  const unsafe = run("status.mjs", ["init", unsafeDirectory, "--route", "/status/%2e%2e/private", "--now", now]);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /invalid_route/);
  assert.equal(existsSync(join(unsafeDirectory, ".project-status", "manifest.json")), false);
});

test("dashboard plan remains read-only and its generated projection stays private", () => {
  const directory = fixture();
  const manifestPath = join(directory, ".project-status", "manifest.json");
  const before = readFileSync(manifestPath);
  const plan = run("dashboard.mjs", ["plan", directory, "--json", "--now", now]);
  assert.equal(plan.status, 0, plan.stderr);
  const planned = JSON.parse(plan.stdout);
  assert.equal(planned.readOnly, true);
  assert.equal(planned.route, "/status");
  assert.equal(planned.output, "public/status");
  assert.equal(readFileSync(manifestPath).equals(before), true);

  const apply = run("dashboard.mjs", ["apply", directory, "--json", "--now", now]);
  assert.equal(apply.status, 0, apply.stderr);
  const projection = JSON.parse(readFileSync(join(directory, "public", "status", "status.json"), "utf8"));
  assert.equal(projection.readiness.exact, 61);
  assert.equal(JSON.stringify(projection).includes("/Users/"), false);
  assert.equal(JSON.stringify(projection).includes("dashboard-audit-agent"), false);

  const check = run("dashboard.mjs", ["check", directory, "--json", "--now", now]);
  assert.equal(check.status, 0, check.stdout);
  writeFileSync(join(directory, "public", "status", "status.css"), "drift\n");
  const drift = run("dashboard.mjs", ["check", directory, "--json", "--now", now]);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /status\.css is conflict/);
  assert.equal(readFileSync(manifestPath).equals(before), true);
});

test("bundled dashboard labels manifest freshness without implying live evidence verification", () => {
  const source = readFileSync(join(root, "skill", "project-status", "assets", "dashboard-static", "status.js"), "utf8");
  assert.match(source, /Manifest freshness/);
  assert.match(source, /no live evidence check/);
  assert.doesNotMatch(source, /Weighted audit (?:stale|within budget)/);
});

test("provenance plans and verifies canonical global evidence without exposing private locators", () => {
  const candidate = clone();
  const directory = fixture(candidate);
  const manifestPath = join(directory, ".project-status", "manifest.json");
  const fileEvidenceIds = new Set([
    "legacy-desktop-screenshot",
    "legacy-mobile-screenshot",
    "local-release-verification",
    "a11y-engineering-audit",
    "a11y-dark-mobile-drawer",
  ]);
  for (const evidence of candidate.evidence) {
    if (fileEvidenceIds.has(evidence.id)) evidence.locator = { type: "file", path: "/fixture/pending" };
  }
  const privatePaths = [];
  for (const [index, evidence] of candidate.evidence.filter((item) => item.locator.type === "file").entries()) {
    const path = join(directory, `private-evidence-${index}.txt`);
    const contents = Buffer.from(`evidence fixture ${index}\n`, "utf8");
    writeFileSync(path, contents);
    evidence.locator.path = path;
    evidence.integrity = { algorithm: "sha256", digest: createHash("sha256").update(contents).digest("hex") };
    privatePaths.push(path);
  }
  writeFileSync(manifestPath, `${JSON.stringify(candidate, null, 2)}\n`);

  const plan = run("provenance.mjs", ["plan", directory, "--json", "--now", now]);
  assert.equal(plan.status, 0, plan.stderr);
  const planned = JSON.parse(plan.stdout);
  assert.equal(planned.evidenceCount, candidate.evidence.length);
  assert.equal(planned.entries.find((entry) => entry.evidenceId === "legacy-desktop-screenshot").locatorType, "file");
  assert.deepEqual(planned.entries.find((entry) => entry.evidenceId === "legacy-desktop-screenshot").taskIds, ["responsive-a11y-baseline"]);
  for (const path of privatePaths) assert.equal(plan.stdout.includes(path), false);

  const verified = run("provenance.mjs", ["verify", directory, "--json", "--now", now]);
  assert.equal(verified.status, 0, verified.stdout);
  const result = JSON.parse(verified.stdout);
  assert.equal(result.results.find((entry) => entry.evidenceId === "legacy-desktop-screenshot").status, "verified");
  assert.equal(result.counts.verified, 5);
  assert.equal(result.counts.unverified, 4);
  for (const path of privatePaths) assert.equal(verified.stdout.includes(path), false);
  assert.doesNotMatch(verified.stdout, /dashboard-audit-agent/);

  writeFileSync(privatePaths[0], "tampered\n");
  const mismatch = run("provenance.mjs", ["verify", directory, "--json", "--now", now]);
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stdout).results.find((entry) => entry.evidenceId === "legacy-desktop-screenshot").status, "mismatch");
});

test("monitor once cannot change canonical readiness or claim scheduled evidence", () => {
  const directory = fixture();
  const manifestPath = join(directory, ".project-status", "manifest.json");
  const before = readFileSync(manifestPath);
  const monitored = run("monitor.mjs", ["once", directory, "--json", "--now", now]);
  assert.equal(monitored.status, 0, monitored.stderr);
  const result = JSON.parse(monitored.stdout);
  assert.equal(result.readOnly, true);
  assert.equal(result.recorded, false);
  assert.equal(result.scheduled, false);
  assert.equal(result.readiness, 61);
  assert.equal(result.liveState, "unknown");
  assert.equal(readFileSync(manifestPath).equals(before), true);
});

test("attachment plan is read-only and copy attachment verifies both hosts", () => {
  const directory = fixture();
  const plan = run("attach.mjs", ["plan", directory, "--mode", "copy", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  const planned = JSON.parse(plan.stdout);
  assert.equal(planned.readOnly, true);
  assert.ok(planned.targets.every((target) => target.state === "missing"));

  const applied = run("attach.mjs", ["apply", directory, "--mode", "copy", "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).targets.every((target) => target.state === "current"), true);
  const repeated = run("attach.mjs", ["apply", directory, "--mode", "copy", "--json"]);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout).written, []);
  const verified = run("attach.mjs", ["verify", directory, "--json"]);
  assert.equal(verified.status, 0, verified.stdout);
  assert.equal(JSON.parse(verified.stdout).targets.every((target) => target.state === "current"), true);
});

test("symlink attachment keeps every packaged CLI executable through host discovery paths", () => {
  const directory = fixture();
  const applied = run("attach.mjs", ["apply", directory, "--mode", "symlink", "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).targets.every((target) => target.state === "current"), true);

  const agentsScripts = join(directory, ".agents", "skills", "project-status", "scripts");
  const claudeScripts = join(directory, ".claude", "skills", "project-status", "scripts");
  const invoke = (scriptRoot, script, args) => spawnSync(
    process.execPath,
    [join(scriptRoot, script), ...args],
    { cwd: directory, encoding: "utf8" },
  );

  const status = invoke(agentsScripts, "status.mjs", ["summary", directory, "--now", now]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /READINESS 61\/100/);

  const dashboard = invoke(claudeScripts, "dashboard.mjs", ["plan", directory, "--json", "--now", now]);
  assert.equal(dashboard.status, 0, dashboard.stderr);
  assert.equal(JSON.parse(dashboard.stdout).readOnly, true);

  const provenance = invoke(agentsScripts, "provenance.mjs", ["plan", directory, "--json", "--now", now]);
  assert.equal(provenance.status, 0, provenance.stderr);
  assert.equal(JSON.parse(provenance.stdout).readOnly, true);

  const monitor = invoke(claudeScripts, "monitor.mjs", ["once", directory, "--json", "--now", now]);
  assert.equal(monitor.status, 0, monitor.stderr);
  assert.equal(JSON.parse(monitor.stdout).readOnly, true);

  const packagePlan = invoke(agentsScripts, "package.mjs", [
    "plan",
    "--output",
    join(directory, "artifacts", "skills"),
    "--json",
  ]);
  assert.equal(packagePlan.status, 0, packagePlan.stderr);
  assert.equal(JSON.parse(packagePlan.stdout).readOnly, true);

  const attached = invoke(claudeScripts, "attach.mjs", ["verify", directory, "--json"]);
  assert.equal(attached.status, 0, attached.stderr);
  assert.equal(JSON.parse(attached.stdout).targets.every((target) => target.state === "current"), true);
});
