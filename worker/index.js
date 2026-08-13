import manifest from "../.project-status/manifest.json" with { type: "json" };
import { handleStatusRequest } from "./status-api.js";

const STATUS_CACHE_BUCKET_MS = 60_000;

function statusAsOf() {
  const bucket = Math.floor(Date.now() / STATUS_CACHE_BUCKET_MS) * STATUS_CACHE_BUCKET_MS;
  const manifestFloor = Math.max(
    Date.parse(manifest.audit.evidenceAsOf),
    Date.parse(manifest.audit.verifiedAt ?? manifest.audit.evidenceAsOf),
  );
  return new Date(Math.max(bucket, manifestFloor)).toISOString();
}

export default {
  async fetch(request, env) {
    const statusResponse = await handleStatusRequest(request, {
      manifest,
      // The core projection is deterministic by default. A serving adapter must
      // explicitly supply wall time so manifest freshness can actually age.
      // Minute bucketing keeps ETags stable for the advertised cache window.
      now: statusAsOf(),
      readLatestMonitorState: async () => {
        if (env.STATUS_MONITOR?.get) {
          const value = await env.STATUS_MONITOR.get("latest", { type: "json" });
          if (value) return value;
        }
        return env.LATEST_MONITOR_STATE ?? null;
      },
    });
    if (statusResponse) return statusResponse;

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
