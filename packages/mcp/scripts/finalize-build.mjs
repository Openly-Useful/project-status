#!/usr/bin/env node

import { chmodSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const relativePath of ["dist/index.js", "dist/runglance-index.js"]) {
  const output = resolve(packageRoot, relativePath);
  if (!existsSync(output)) throw new Error(`Missing MCP executable: ${relativePath}`);
  chmodSync(output, 0o755);
}
