#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const releaseRoot = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_OUTPUT = join(releaseRoot, "THIRD_PARTY_NOTICES.md");
const LICENSE_FILE = /^(?:licen[sc]e|copying|notice)(?:\.|$)/i;
const PROFILES = [
  {
    id: "site-runtime",
    label: "site runtime",
    root: releaseRoot,
    lockPath: join(releaseRoot, "package-lock.json"),
    roots: ["@fontsource/ibm-plex-mono", "@fontsource/inter", "@phosphor-icons/react", "react", "react-dom"],
  },
  {
    id: "mcp-runtime",
    label: "MCP runtime",
    root: join(releaseRoot, "packages", "mcp"),
    lockPath: join(releaseRoot, "packages", "mcp", "package-lock.json"),
    roots: ["@modelcontextprotocol/server", "zod"],
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedText(path) {
  return `${readFileSync(path, "utf8").replaceAll("\r\n", "\n").trim()}\n`;
}

function packageRecord(packages, name) {
  return packages[`node_modules/${name}`] ?? null;
}

function runtimeClosure(profile) {
  const lock = JSON.parse(readFileSync(profile.lockPath, "utf8"));
  const packages = lock.packages ?? {};
  const queue = [...profile.roots];
  const names = new Set();
  while (queue.length > 0) {
    const name = queue.shift();
    if (names.has(name)) continue;
    const record = packageRecord(packages, name);
    if (!record) throw new Error(`${profile.id} lockfile is missing node_modules/${name}`);
    names.add(name);
    for (const dependency of Object.keys(record.dependencies ?? {}).sort()) queue.push(dependency);
  }
  return [...names].sort().map((name) => ({ name, record: packageRecord(packages, name) }));
}

function licenseFiles(profile, name) {
  const directory = join(profile.root, "node_modules", name);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`${profile.id} dependency is not installed: ${name}`);
  }
  const files = readdirSync(directory)
    .filter((entry) => LICENSE_FILE.test(entry) && statSync(join(directory, entry)).isFile())
    .sort();
  if (files.length === 0) throw new Error(`${profile.id} dependency has no local license or notice file: ${name}`);
  return files.map((file) => ({ name: file, text: normalizedText(join(directory, file)) }));
}

export function createThirdPartyNoticePlan() {
  const records = new Map();
  for (const profile of PROFILES) {
    for (const { name, record } of runtimeClosure(profile)) {
      const key = `${name}@${record.version}`;
      const files = licenseFiles(profile, name);
      const existing = records.get(key);
      const candidate = {
        name,
        version: record.version,
        declaredLicense: record.license ?? "UNKNOWN",
        profiles: new Set([profile.label]),
        files,
      };
      if (existing) {
        existing.profiles.add(profile.label);
        if (existing.declaredLicense !== candidate.declaredLicense || stableJson(existing.files) !== stableJson(candidate.files)) {
          throw new Error(`Dependency metadata differs between runtime profiles: ${key}`);
        }
      } else records.set(key, candidate);
    }
  }

  const dependencies = [...records.values()]
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
    .map((entry) => ({ ...entry, profiles: [...entry.profiles].sort() }));
  const textGroups = new Map();
  for (const dependency of dependencies) {
    for (const file of dependency.files) {
      const digest = sha256(file.text);
      const group = textGroups.get(digest) ?? { digest, text: file.text, packages: [] };
      group.packages.push(`${dependency.name}@${dependency.version} (${file.name})`);
      textGroups.set(digest, group);
    }
  }

  const lines = [
    "# Third-Party Notices",
    "",
    "This file is generated deterministically from the pinned site-runtime and bundled-MCP runtime dependency graphs. It is a reviewable attribution inventory, not legal advice and not authorization to publish.",
    "",
    "## Runtime dependency inventory",
    "",
    "| Package | Version | Runtime | Declared license |",
    "| --- | --- | --- | --- |",
    ...dependencies.map((entry) => `| \`${entry.name}\` | \`${entry.version}\` | ${entry.profiles.join(", ")} | \`${entry.declaredLicense}\` |`),
    "",
    "## License and notice texts",
    "",
    ...[...textGroups.values()]
      .sort((left, right) => left.digest.localeCompare(right.digest))
      .flatMap((group) => [
        `### SHA-256 \`${group.digest}\``,
        "",
        `Applies to: ${group.packages.sort().map((item) => `\`${item}\``).join(", ")}.`,
        "",
        "```text",
        group.text.trimEnd(),
        "```",
        "",
      ]),
  ];
  const contents = `${lines.join("\n").trimEnd()}\n`;
  return {
    valid: true,
    output: DEFAULT_OUTPUT,
    packageCount: dependencies.length,
    licenseTextCount: textGroups.size,
    sha256: sha256(contents),
    dependencies: dependencies.map(({ files, ...entry }) => ({
      ...entry,
      licenseFiles: files.map((file) => ({ name: file.name, sha256: sha256(file.text) })),
    })),
    contents,
  };
}

function parse(argv) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
  const rest = command === argv[0] ? argv.slice(1) : argv;
  const options = { command, output: DEFAULT_OUTPUT, replace: false, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--output") options.output = resolve(rest[++index] ?? "");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["plan", "build", "verify"].includes(command)) {
    throw new Error("Usage: third-party-notices.mjs <plan|build|verify> [--output path] [--replace] [--json]");
  }
  return options;
}

function visible(plan, operation, output) {
  return {
    valid: plan.valid,
    operation,
    readOnly: operation !== "build",
    output,
    packageCount: plan.packageCount,
    licenseTextCount: plan.licenseTextCount,
    sha256: plan.sha256,
    dependencies: plan.dependencies,
  };
}

export function runThirdPartyNotices(options) {
  const plan = createThirdPartyNoticePlan();
  const result = visible(plan, options.command, options.output);
  if (options.command === "plan") return result;
  if (options.command === "verify") {
    const current = existsSync(options.output) && statSync(options.output).isFile() ? readFileSync(options.output, "utf8") : null;
    return {
      ...result,
      valid: current === plan.contents,
      reason: current === null ? "notice file is missing" : current === plan.contents ? null : "notice file differs from the deterministic runtime inventory",
    };
  }
  if (existsSync(options.output) && !options.replace) {
    throw new Error(`Refusing existing notice file without --replace: ${options.output}`);
  }
  writeFileSync(options.output, plan.contents, { flag: existsSync(options.output) ? "w" : "wx", mode: 0o644 });
  return { ...result, written: [basename(options.output)] };
}

function format(result) {
  return [
    `THIRD-PARTY NOTICES ${result.operation.toUpperCase()} ${result.valid ? "OK" : "FAILED"}`,
    `Packages: ${result.packageCount}`,
    `Unique license texts: ${result.licenseTextCount}`,
    `SHA-256: ${result.sha256}`,
    result.reason ? `Reason: ${result.reason}` : null,
    result.operation === "plan" ? "No files were changed." : null,
  ].filter(Boolean).join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const result = runThirdPartyNotices(parse(argv));
  process.stdout.write(`${argv.includes("--json") ? stableJson(result) : `${format(result)}\n`}`);
  return result.valid ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
