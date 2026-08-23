#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(packageRoot, "../..", "LICENSE");
const target = resolve(packageRoot, "LICENSE");
writeFileSync(target, readFileSync(source), { mode: 0o644 });
