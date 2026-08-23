#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createRunGlanceServer } from "./runglance-server.js";

function configuredPath(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write("Usage: runglance-mcp [--snapshot <path>]\n");
    return undefined;
  }
  if (args.length === 2 && args[0] === "--snapshot" && args[1] !== undefined) return args[1];
  throw new Error("Usage: runglance-mcp [--snapshot <path>]");
}

try {
  const args = process.argv.slice(2);
  const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h");
  const snapshotPath = configuredPath(args);
  if (!help) {
    const handle = serveStdio(() => createRunGlanceServer(snapshotPath === undefined ? {} : { activityPath: snapshotPath }));
    process.on("SIGINT", () => { void handle.close(); });
    process.on("SIGTERM", () => { void handle.close(); });
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
