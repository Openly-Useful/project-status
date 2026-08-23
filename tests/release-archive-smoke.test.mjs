import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPackagePlan, readStoredZipEntries } from "../scripts/package-skill.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(projectRoot, ".project-status", "manifest.json");
const releaseVersion = readFileSync(join(projectRoot, "VERSION"), "utf8").trim();
const mcpRequire = createRequire(new URL("../packages/mcp/package.json", import.meta.url));
const { Client } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client")).href);
const { StdioClientTransport } = await import(pathToFileURL(mcpRequire.resolve("@modelcontextprotocol/client/stdio")).href);

async function extractStoredArchive(bytes, destination) {
  for (const [entry, contents] of readStoredZipEntries(bytes)) {
    const output = resolve(destination, entry);
    assert.ok(output.startsWith(`${destination}${sep}`), `archive entry escaped extraction root: ${entry}`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, contents);
  }
}

async function exerciseExtractedPlugin(kind, archive) {
  const extractionRoot = await mkdtemp(join(tmpdir(), `project-status-${kind}-archive-`));
  try {
    await extractStoredArchive(archive.bytes, extractionRoot);
    const entrypoint = join(extractionRoot, "mcp", "dist", "index.js");
    const environment = { ...process.env };
    delete environment.NODE_PATH;
    delete environment.PROJECT_STATUS_MANIFEST;
    delete environment.PROJECT_STATUS_ROOT;

    const client = new Client(
      { name: `project-status-${kind}-archive-smoke`, version: releaseVersion },
      { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "--manifest", manifestPath],
      cwd: extractionRoot,
      env: environment,
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion().name, "project-status-mcp-server");
      assert.equal(client.getServerVersion().version, releaseVersion);

      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
        "project_status_get_activity",
        "project_status_get_dependencies",
        "project_status_get_locks",
        "project_status_get_summary",
        "project_status_get_usage",
        "project_status_list_active_work",
        "project_status_list_tasks",
        "project_status_validate_manifest",
      ]);

      const validation = await client.callTool({
        name: "project_status_validate_manifest",
        arguments: {},
      });
      assert.equal(validation.isError, undefined);
      assert.equal(validation.structuredContent.ok, true);
      assert.equal(validation.structuredContent.valid, true);

      const summary = await client.callTool({
        name: "project_status_get_summary",
        arguments: {},
      });
      assert.equal(summary.isError, undefined);
      assert.equal(summary.structuredContent.ok, true);
      assert.equal(summary.structuredContent.initiative.name, "Project Status");
      assert.equal(summary.structuredContent.score.totalWeight, 100);
    } finally {
      await client.close();
    }
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

async function exercisePackagedSkillThroughHostDiscovery(kind, archive) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), `project-status-${kind}-discovery-`));
  const discovery = kind === "openai" ? ".agents" : ".claude";
  const skillRoot = join(fixtureRoot, discovery, "skills", "project-status");
  try {
    for (const [entry, contents] of readStoredZipEntries(archive.bytes)) {
      const prefix = "skills/project-status/";
      if (!entry.startsWith(prefix)) continue;
      const relativeEntry = entry.slice(prefix.length);
      const output = resolve(skillRoot, relativeEntry);
      assert.ok(output.startsWith(`${skillRoot}${sep}`), `skill entry escaped discovery root: ${entry}`);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, contents);
    }

    const scripts = join(skillRoot, "scripts");
    const run = (script, args) => spawnSync(process.execPath, [join(scripts, script), ...args], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    const checks = [
      ["status.mjs", ["summary", projectRoot, "--json"], (output) => output.score?.totalWeight === 100],
      ["dashboard.mjs", ["plan", projectRoot, "--json"], (output) => output.readOnly === true],
      ["provenance.mjs", ["plan", projectRoot, "--json"], (output) => output.readOnly === true],
      ["monitor.mjs", ["once", projectRoot, "--json"], (output) => output.readOnly === true && output.recorded === false],
      ["package.mjs", ["plan", "--output", join(fixtureRoot, "artifacts"), "--json"], (output) => output.readOnly === true],
      ["attach.mjs", ["plan", fixtureRoot, "--mode", "copy", "--json"], (output) => output.readOnly === true],
    ];
    for (const [script, args, accepts] of checks) {
      const result = run(script, args);
      assert.equal(result.status, 0, `${kind}/${script}: ${result.stderr || result.stdout}`);
      assert.equal(accepts(JSON.parse(result.stdout)), true, `${kind}/${script} returned an unexpected contract`);
    }
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

test("extracted OpenAI and Claude plugin archives run their bundled MCP server without installation", async (context) => {
  const plan = createPackagePlan();
  assert.equal(plan.valid, true, plan.errors.join("\n"));
  assert.equal(plan.mcpIncluded, true);

  for (const kind of ["openai", "claude"]) {
    await context.test(kind, async () => {
      await exerciseExtractedPlugin(kind, plan.archives[kind]);
    });
  }
});

test("packaged CLIs run without installation through .agents and .claude discovery paths", async (context) => {
  const plan = createPackagePlan();
  assert.equal(plan.valid, true, plan.errors.join("\n"));

  for (const kind of ["openai", "claude"]) {
    await context.test(kind, async () => {
      await exercisePackagedSkillThroughHostDiscovery(kind, plan.archives[kind]);
    });
  }
});
