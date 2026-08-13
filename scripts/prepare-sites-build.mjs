#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const statusApi = path.join(root, "worker", "status-api.js");
const manifest = path.join(root, ".project-status", "manifest.json");
const core = path.join(root, "packages", "core");
const hosting = path.join(root, ".openai", "hosting.json");

for (const file of [index, worker, statusApi, manifest, core, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".project-status"), { recursive: true });
mkdirSync(path.join(dist, "packages", "core"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "index.js"));
copyFileSync(statusApi, path.join(dist, "server", "status-api.js"));
copyFileSync(manifest, path.join(dist, ".project-status", "manifest.json"));
for (const filename of readdirSync(core).filter((name) => name.endsWith(".mjs")).sort()) {
  copyFileSync(path.join(core, filename), path.join(dist, "packages", "core", filename));
}
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));

console.log("Prepared Sites build: static client, status worker graph, manifest, and hosting config");
