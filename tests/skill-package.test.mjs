import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listStoredZipEntries, readStoredZipEntries, scanPackagedContents } from "../scripts/package-skill.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packager = join(root, "scripts", "package-skill.mjs");
const archiveNames = [
  "project-status-portable-claude-skill.zip",
  "project-status-openai-plugin.zip",
  "project-status-claude-plugin.zip",
];

function run(args) {
  return spawnSync(process.execPath, [packager, ...args], { cwd: root, encoding: "utf8" });
}

test("package builds are byte-for-byte deterministic and verify successfully", () => {
  const first = mkdtempSync(join(tmpdir(), "project-status-package-a-"));
  const second = mkdtempSync(join(tmpdir(), "project-status-package-b-"));
  const buildFirst = run(["build", "--output", first, "--json"]);
  assert.equal(buildFirst.status, 0, buildFirst.stderr || buildFirst.stdout);
  const buildSecond = run(["build", "--output", second, "--json"]);
  assert.equal(buildSecond.status, 0, buildSecond.stderr || buildSecond.stdout);
  for (const name of [...archiveNames, "checksums.json"]) {
    assert.equal(readFileSync(join(first, name)).equals(readFileSync(join(second, name))), true, `${name} is not deterministic`);
  }
  const verify = run(["verify", "--output", first, "--json"]);
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assert.equal(JSON.parse(verify.stdout).valid, true);
});

test("all archives have safe allowlisted entry paths and SHA-256 inventories", () => {
  const output = mkdtempSync(join(tmpdir(), "project-status-package-safe-"));
  const built = run(["build", "--output", output, "--json"]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  for (const name of archiveNames) {
    const archive = readFileSync(join(output, name));
    const stored = readStoredZipEntries(archive);
    const entries = [...stored.keys()];
    assert.ok(entries.includes("MANIFEST.sha256"));
    assert.ok(entries.some((entry) => entry.endsWith("/SKILL.md")));
    assert.ok(entries.every((entry) => !entry.startsWith("/") && !entry.includes("..") && !entry.includes("\\")));
    assert.ok(entries.every((entry) => !/(?:^|\/)tests?(?:\/|$)|\.test\./.test(entry)));
    assert.ok(entries.every((entry) => !/(?:^|\/)node_modules(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(entry)));
    const expectedInventory = `${[...stored]
      .filter(([entry]) => entry !== "MANIFEST.sha256")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entry, contents]) => `${createHash("sha256").update(contents).digest("hex")}  ${entry}`)
      .join("\n")}\n`;
    assert.equal(stored.get("MANIFEST.sha256").toString("utf8"), expectedInventory);
    for (const [entry, contents] of stored) {
      if (contents.includes(0)) continue;
      const text = contents.toString("utf8");
      assert.doesNotMatch(text, /\/(?:Users|home)\//, `${entry} embeds a user-home path`);
      assert.doesNotMatch(text, /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/, `${entry} embeds a private key`);
      assert.doesNotMatch(text, /\b(?:AKIA[0-9A-Z]{16}|gh[oprsu]_[A-Za-z0-9_]{24,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/, `${entry} embeds a likely secret`);
    }
  }
  const openai = listStoredZipEntries(readFileSync(join(output, "project-status-openai-plugin.zip")));
  assert.ok(openai.includes(".codex-plugin/plugin.json"));
  assert.ok(openai.includes("skills/project-status/SKILL.md"));
  const claude = listStoredZipEntries(readFileSync(join(output, "project-status-claude-plugin.zip")));
  assert.ok(claude.includes(".claude-plugin/plugin.json"));
  assert.ok(claude.includes("skills/project-status/SKILL.md"));
  for (const entries of [openai, claude]) {
    assert.ok(entries.includes("mcp/dist/index.js"));
    assert.ok(entries.includes("core/index.mjs"));
    assert.equal(entries.includes("package.json"), false);
    assert.equal(entries.includes("package-lock.json"), false);
    assert.deepEqual(entries.filter((entry) => entry.startsWith("mcp/dist/")), ["mcp/dist/index.js"]);
    assert.ok(entries.every((entry) => !entry.endsWith(".map") && !entry.endsWith(".d.ts") && !entry.includes("/src/")));
  }
});

test("checksums name the release version and every deterministic archive", () => {
  const output = mkdtempSync(join(tmpdir(), "project-status-package-checksums-"));
  const built = run(["build", "--output", output, "--json"]);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const checksums = JSON.parse(readFileSync(join(output, "checksums.json"), "utf8"));
  assert.equal(checksums.version, readFileSync(join(root, "VERSION"), "utf8").trim());
  assert.deepEqual(Object.keys(checksums.archives).sort(), ["claude", "openai", "portable"]);
  for (const archive of Object.values(checksums.archives)) {
    const bytes = readFileSync(join(output, archive.file));
    assert.equal(archive.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(archive.size, bytes.length);
  }
});

test("package build refuses existing artifacts without explicit replacement", () => {
  const output = mkdtempSync(join(tmpdir(), "project-status-package-refuse-"));
  assert.equal(run(["build", "--output", output]).status, 0);
  const refused = run(["build", "--output", output]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /without --replace/);
  const replaced = run(["build", "--output", output, "--replace", "--json"]);
  assert.equal(replaced.status, 0, replaced.stderr || replaced.stdout);
});

test("package safety scanner rejects home paths, secret material, and unsafe entry paths", () => {
  assert.deepEqual(scanPackagedContents("safe/config.json", Buffer.from('{"mode":"read-only"}\n')), []);
  assert.ok(scanPackagedContents("../escape.txt", Buffer.from("safe\n")).some((error) => /unsafe archive path/.test(error)));
  assert.ok(scanPackagedContents("config.txt", Buffer.from("/Users/example/private/file\n")).some((error) => /user-home path/.test(error)));
  assert.ok(scanPackagedContents("config.txt", Buffer.from('api_key="sk-proj-abcdefghijklmnopqrstuvwxyz"\n')).some((error) => /probable secret/.test(error)));
  assert.ok(scanPackagedContents(".env", Buffer.from("MODE=local\n")).some((error) => /not packageable/.test(error)));
});
