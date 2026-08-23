#!/usr/bin/env node

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sharedRoot = resolve(packageRoot, "../mcp");
const executable = (name) => join(sharedRoot, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

function run(name, args) {
  const command = executable(name);
  if (!existsSync(command)) throw new Error(`Shared MCP toolchain is missing ${command}. Install only from the pinned packages/mcp lockfile.`);
  const result = spawnSync(command, args, {
    cwd: sharedRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const action = process.argv[2];
if (action === "build") {
  const output = join(packageRoot, "dist", "index.js");
  copyFileSync(resolve(packageRoot, "../..", "LICENSE"), join(packageRoot, "LICENSE"));
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  run("esbuild", [
    "src/runglance-index.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node20",
    `--outfile=${output}`,
    "--charset=utf8",
    "--legal-comments=eof",
  ]);
  chmodSync(output, 0o755);
} else if (action === "typecheck") {
  run("tsc", [
    "--ignoreConfig",
    "--noEmit",
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--lib", "ES2022",
    "--types", "node",
    "--strict",
    "--noUncheckedIndexedAccess",
    "--skipLibCheck",
    "src/runglance-index.ts",
  ]);
} else {
  throw new Error("Usage: toolchain.mjs <build|typecheck>");
}
