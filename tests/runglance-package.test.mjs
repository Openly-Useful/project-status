import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readStoredZipEntries } from "../scripts/package-runglance.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packager = join(root, "scripts", "package-runglance.mjs");
const archiveNames = [
  "runglance-portable-claude-skill.zip",
  "runglance-openai-plugin.zip",
  "runglance-claude-plugin.zip",
];

function run(args) {
  return spawnSync(process.execPath, [packager, ...args], { cwd: root, encoding: "utf8" });
}

test("RunGlance packages are deterministic and independently verifiable", () => {
  const first = mkdtempSync(join(tmpdir(), "runglance-package-a-"));
  const second = mkdtempSync(join(tmpdir(), "runglance-package-b-"));
  assert.equal(run(["build", "--output", first]).status, 0);
  assert.equal(run(["build", "--output", second]).status, 0);
  for (const name of [...archiveNames, "checksums.json"]) {
    assert.equal(readFileSync(join(first, name)).equals(readFileSync(join(second, name))), true, name);
  }
  const verified = run(["verify", "--output", first, "--json"]);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(JSON.parse(verified.stdout).valid, true);
});

test("RunGlance archives contain only the RunGlance skill and optional read-only MCP bundle", () => {
  const output = mkdtempSync(join(tmpdir(), "runglance-package-safe-"));
  const built = run(["build", "--output", output, "--json"]);
  assert.equal(built.status, 0, built.stderr || built.stdout);

  const portable = readStoredZipEntries(readFileSync(join(output, archiveNames[0])));
  assert.ok(portable.has("runglance/SKILL.md"));
  assert.equal([...portable.keys()].some((name) => name.includes("project-status")), false);
  for (const legalFile of ["LICENSE", "PRIVACY.md", "TERMS.md", "SECURITY.md", "SUPPORT.md", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(portable.has(`runglance/${legalFile}`), `portable archive is missing ${legalFile}`);
  }

  for (const [name, manifest] of [
    [archiveNames[1], ".codex-plugin/plugin.json"],
    [archiveNames[2], ".claude-plugin/plugin.json"],
  ]) {
    const entries = readStoredZipEntries(readFileSync(join(output, name)));
    assert.ok(entries.has(manifest));
    assert.ok(entries.has("skills/runglance/SKILL.md"));
    assert.ok(entries.has("mcp/dist/index.js"));
    assert.ok(entries.has("MANIFEST.sha256"));
    for (const legalFile of ["LICENSE", "PRIVACY.md", "TERMS.md", "SECURITY.md", "SUPPORT.md", "THIRD_PARTY_NOTICES.md"]) {
      assert.ok(entries.has(legalFile), `${name} is missing ${legalFile}`);
    }
    const inventory = entries.get("MANIFEST.sha256").toString("utf8");
    for (const [entry, contents] of entries) {
      if (entry === "MANIFEST.sha256") continue;
      assert.match(inventory, new RegExp(`^${createHash("sha256").update(contents).digest("hex")}  ${entry.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}$`, "m"));
    }
  }
});
