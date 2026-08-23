import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "skill", "runglance", "scripts", "runglance.mjs");
const adapterScript = join(root, "skill", "runglance", "scripts", "runglance-adapter.mjs");
const now = "2026-08-15T20:00:00.000Z";

function fixture() {
  return mkdtempSync(join(tmpdir(), "runglance-runtime-"));
}

function run(runtime, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, RUNGLANCE_RUNTIME_DIR: runtime, ...(options.env ?? {}) },
  });
}

function runAdapter(runtime, args, input) {
  return spawnSync(process.execPath, [adapterScript, ...args], {
    cwd: root,
    encoding: "utf8",
    input: `${JSON.stringify(input)}\n`,
    env: { ...process.env, RUNGLANCE_RUNTIME_DIR: runtime },
  });
}

function runAdapterAsync(runtime, args, input) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [adapterScript, ...args], {
      cwd: root,
      env: { ...process.env, RUNGLANCE_RUNTIME_DIR: runtime },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

test("setup plan is read-only and start creates user-only deterministic state", () => {
  const runtime = fixture();
  const plan = run(runtime, ["setup", "plan", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).readOnly, true);
  assert.deepEqual(Object.keys(JSON.parse(plan.stdout).retention), ["default", "optionalMetadataDays"]);

  const started = run(runtime, ["start", "--session-id", "session-one", "--name", "Test task", "--now", now, "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const snapshot = JSON.parse(started.stdout);
  assert.equal(snapshot.sessionId, "session-one");
  assert.equal(snapshot.thread.state, "running");
  assert.equal(snapshot.counts.agents, 0);
  assert.equal(statSync(join(runtime, "sessions", "session-one.jsonl")).mode & 0o777, 0o600);
  assert.equal(statSync(join(runtime, "sessions", "session-one.snapshot.json")).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(runtime, "activity-snapshot.json"), "utf8")).sessionId, "session-one");
});

test("setup instructions and guided modes are read-only while apply writes only repo-local metadata", () => {
  const runtime = fixture();
  const project = fixture();
  const instructions = run(runtime, ["setup", "instructions", "--host", "generic", "--json"]);
  assert.equal(instructions.status, 0, instructions.stderr);
  assert.deepEqual(Object.keys(JSON.parse(instructions.stdout)), ["generic"]);
  const guided = run(runtime, ["setup", "guided", "--host", "claude", "--project-root", project, "--json"]);
  assert.equal(guided.status, 0, guided.stderr);
  assert.match(JSON.parse(guided.stdout).nextCommand, /setup apply/);
  const applied = run(runtime, ["setup", "apply", "--host", "claude", "--project-root", project, "--now", now, "--json"]);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.config.scope, "repository-local");
  assert.equal(result.config.hostConfigurationApplied, false);
  assert.equal(JSON.parse(readFileSync(result.path, "utf8")).host, "claude");
});

test("update and snapshot show derived context, exact progress, and terminal accounting", () => {
  const runtime = fixture();
  assert.equal(run(runtime, ["start", "--session-id", "work", "--now", now]).status, 0);
  const update = run(runtime, [
    "update", "--kind", "workflow", "--id", "tests", "--name", "Tests", "--state", "running",
    "--completed", "2", "--total", "4", "--context-used", "25", "--now", now, "--json",
  ]);
  assert.equal(update.status, 0, update.stderr);
  const completed = run(runtime, ["update", "--kind", "agent", "--id", "reviewer", "--state", "completed", "--now", now]);
  assert.equal(completed.status, 0, completed.stderr);
  const snapshot = run(runtime, ["snapshot", "--json", "--now", now]);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const parsed = JSON.parse(snapshot.stdout);
  assert.equal(parsed.progress.percent, 50);
  assert.equal(parsed.usage.contextRemainingPercent.value, 75);
  assert.equal(parsed.usage.contextRemainingPercent.truthClass, "derived");
  assert.equal(parsed.activeWork.some((item) => item.id === "tests"), true);
  assert.equal(parsed.activeWork.find((item) => item.id === "tests").startedAt, now);
  assert.equal(parsed.finishedWork.some((item) => item.id === "reviewer"), true);
  const locked = run(runtime, ["update", "--lock-owner", "primary-agent", "--now", now, "--json"]);
  assert.equal(JSON.parse(locked.stdout).lock.state, "locked");
  const unlocked = run(runtime, ["update", "--unlock", "--now", now, "--json"]);
  assert.equal(JSON.parse(unlocked.stdout).lock.state, "unlocked");
});

test("non-TTY watch emits one plain ASCII line without redraw control sequences", () => {
  const runtime = fixture();
  assert.equal(run(runtime, ["start", "--session-id", "watch", "--now", now]).status, 0);
  const watched = run(runtime, ["watch", "--once", "--preset", "diagnostic", "--width", "60", "--ascii", "--now", now], {
    env: { TERM: "dumb", NO_COLOR: "1" },
  });
  assert.equal(watched.status, 0, watched.stderr);
  assert.equal(watched.stdout.trim().split("\n").length, 1);
  assert.doesNotMatch(watched.stdout, /\u001b/);
  assert.ok(watched.stdout.trim().length <= 60);
});

test("verify executes argv without a shell, preserves exit code, and records only redacted bounded output", () => {
  const runtime = fixture();
  assert.equal(run(runtime, ["start", "--session-id", "verify", "--retention-days", "7", "--now", now]).status, 0);
  const marker = "sk_test_12345678901234567890";
  const failed = run(runtime, [
    "verify", "--name", "Failure fixture", "--now", now, "--",
    process.execPath, "-e", `process.stdout.write('${marker} /Users/example/private/file.txt\\n'); process.exit(7)`,
  ]);
  assert.equal(failed.status, 7, failed.stderr);
  assert.match(failed.stdout, new RegExp(marker));
  assert.match(failed.stderr, /FAIL · Failure fixture · exit 7/);
  const persisted = readFileSync(join(runtime, "sessions", "verify.jsonl"), "utf8");
  assert.doesNotMatch(persisted, new RegExp(marker));
  assert.doesNotMatch(persisted, /\/Users\/example/);
  assert.match(persisted, /<redacted>|<path>/);

  const passed = run(runtime, ["verify", "--name", "Pass fixture", "--now", now, "--", process.execPath, "-e", "process.exit(0)"]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stderr, /PASS · Pass fixture · exit 0/);
});

test("verified finish prints deterministic evidence and retained history while default finish removes session state", () => {
  const retained = fixture();
  assert.equal(run(retained, ["start", "--session-id", "receipt", "--retention-days", "7", "--now", now]).status, 0);
  assert.equal(run(retained, ["update", "--kind", "workflow", "--id", "unfinished", "--state", "running", "--now", now]).status, 0);
  assert.equal(run(retained, ["update", "--lock-owner", "primary-agent", "--now", now]).status, 0);
  assert.equal(run(retained, ["verify", "--name", "Checks", "--now", now, "--", process.execPath, "-e", "process.exit(0)"]).status, 0);
  const finished = run(retained, [
    "finish", "--outcome", "complete", "--summary", "Boundary fixed", "--fix", "Applied safe fix",
    "--remaining", "External review", "--final-summary", "verified", "--format", "markdown", "--now", now,
  ]);
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(finished.stdout, /Boundary fixed/);
  assert.match(finished.stdout, /PASS\s+Checks · exit 0/);
  assert.match(finished.stdout, /External review/);
  assert.match(finished.stdout, /Task result: complete/);
  assert.match(finished.stdout, /Project readiness: not assessed/);
  const latest = JSON.parse(readFileSync(join(retained, "activity-snapshot.json"), "utf8"));
  assert.equal(latest.lastReceipt.summary, "Boundary fixed");
  assert.equal(latest.activeWork.length, 0);
  assert.equal(latest.thread.state, "ready");
  assert.equal(latest.lock.state, "unlocked");
  assert.equal(latest.finishedWork.find((item) => item.kind === "thread" && item.id === "primary").state, "completed");
  assert.equal(latest.finishedWork.find((item) => item.kind === "workflow" && item.id === "unfinished").state, "stopped");
  assert.equal(JSON.parse(readFileSync(join(retained, "last-receipt.json"), "utf8")).projectReadiness.status, "not_assessed");
  const history = run(retained, ["history", "--json", "--now", now]);
  assert.equal(history.status, 0, history.stderr);
  assert.equal(JSON.parse(history.stdout)[0].summary, "Boundary fixed");

  const ephemeral = fixture();
  assert.equal(run(ephemeral, ["start", "--session-id", "ephemeral", "--now", now]).status, 0);
  const quiet = run(ephemeral, ["finish", "--final-summary", "off", "--now", now]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "");
  const missing = run(ephemeral, ["snapshot", "--session-id", "ephemeral", "--json", "--now", now]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No activity events/);
});

test("host adapters map only reported Codex and Claude facts and generic events remain metric-agnostic", () => {
  const runtime = fixture();
  const claude = runAdapter(runtime, ["claude-statusline", "--session-id", "claude-run", "--emit", "--json", "--now", now], {
    session_id: "claude-run",
    context_window: { remaining_percentage: 62 },
    rate_limits: { five_hour: { used_percentage: 18 }, seven_day: { used_percentage: 44 } },
  });
  assert.equal(claude.status, 0, claude.stderr);
  const claudeSnapshot = JSON.parse(claude.stdout);
  assert.equal(claudeSnapshot.usage.contextRemainingPercent.truthClass, "exact");
  assert.equal(claudeSnapshot.usage.contextRemainingPercent.value, 62);
  assert.equal(claudeSnapshot.usage.quotaRemainingPercent.truthClass, "derived");
  assert.equal(claudeSnapshot.usage.quotaRemainingPercent.value, 56);

  const codex = runAdapter(runtime, ["codex-hook", "--session-id", "codex-run", "--emit", "--json", "--now", now], {
    hook_event_name: "SubagentStart",
    thread_id: "codex-run",
    agent_id: "reviewer",
    agent_type: "review",
  });
  assert.equal(codex.status, 0, codex.stderr);
  const codexSnapshot = JSON.parse(codex.stdout);
  assert.equal(codexSnapshot.activeWork.some((item) => item.kind === "agent" && item.id === "reviewer"), true);
  assert.equal(codexSnapshot.usage.contextRemainingPercent.truthClass, "unknown");
  assert.equal(codexSnapshot.usage.quotaRemainingPercent.truthClass, "unknown");

  const generic = runAdapter(runtime, ["generic", "--session-id", "generic-run", "--json", "--now", now], {
    type: "entity.started",
    source: "generic-wrapper",
    entity: { kind: "workflow", id: "build" },
    state: "running",
  });
  assert.equal(generic.status, 0, generic.stderr);
  const genericEvent = JSON.parse(generic.stdout)[0];
  assert.deepEqual(genericEvent.metrics, {});
});

test("parallel adapter writers retain every independently identified agent", async () => {
  const runtime = fixture();
  assert.equal(run(runtime, ["start", "--session-id", "parallel", "--now", now]).status, 0);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => runAdapterAsync(
    runtime,
    ["codex-hook", "--session-id", "parallel", "--emit", "--json", "--now", now],
    { hook_event_name: "SubagentStart", agent_id: `agent-${index}`, agent_type: "worker" },
  )));
  assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join("\n"));
  const snapshot = JSON.parse(run(runtime, ["snapshot", "--session-id", "parallel", "--json", "--now", now]).stdout);
  assert.equal(snapshot.counts.agents, 12);
  assert.equal(snapshot.activeWork.filter((item) => item.kind === "agent").length, 12);
  const lines = readFileSync(join(runtime, "sessions", "parallel.jsonl"), "utf8").trim().split("\n");
  assert.equal(new Set(lines.map((line) => JSON.parse(line).sequence)).size, 13);
});

test("doctor is local and purge removes only the configured runtime directory", () => {
  const runtime = fixture();
  const doctor = run(runtime, ["doctor", "--json"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.checks.find((item) => item.id === "network").detail, "not used");
  assert.equal(report.checks.find((item) => item.id === "model-calls").detail, "not used");
  const purged = run(runtime, ["purge"]);
  assert.equal(purged.status, 0, purged.stderr);
  assert.match(purged.stdout, /^PURGED /);
  const refused = run("/", ["purge"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to purge broad runtime directory/);
});
