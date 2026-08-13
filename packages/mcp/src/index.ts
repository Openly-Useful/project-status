#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { resolveManifestPath } from "./manifest-adapter.js";
import { createProjectStatusServer } from "./server.js";

function configuredPath(args: string[]): string | undefined {
  if (args.length === 0) {
    if (process.env.PROJECT_STATUS_MANIFEST !== undefined || process.env.PROJECT_STATUS_ROOT !== undefined) {
      return resolveManifestPath();
    }
    return undefined;
  }
  if (args.length === 2 && args[0] === "--manifest" && args[1] !== undefined) {
    return resolveManifestPath({ explicitPath: args[1] });
  }
  throw new Error("Usage: project-status-mcp [--manifest <path>]");
}

try {
  const manifestPath = configuredPath(process.argv.slice(2));
  const handle = serveStdio(() => createProjectStatusServer(manifestPath === undefined ? {} : { manifestPath }));
  process.on("SIGINT", () => {
    void handle.close();
  });
  process.on("SIGTERM", () => {
    void handle.close();
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
