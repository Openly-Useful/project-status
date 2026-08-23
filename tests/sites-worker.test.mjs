import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";
import manifest from "../.project-status/manifest.json" with { type: "json" };

const expectedEarnedWeight = manifest.phases
  .flatMap((phase) => phase.tasks)
  .reduce((total, task) => total + task.earnedWeight, 0);

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("serves the weighted manifest API without touching static assets", async () => {
  let assetCalls = 0;
  const response = await worker.fetch(new Request("https://example.test/status/manifest"), {
    ASSETS: { fetch: async () => { assetCalls += 1; return new Response("unexpected"); } },
  });

  assert.equal(response.status, 200);
  assert.equal(assetCalls, 0);
  const payload = await response.json();
  assert.equal(payload.initiative.name, manifest.initiative.name);
  assert.equal(payload.score.earnedWeight, expectedEarnedWeight);
  assert.equal(payload.score.totalWeight, 100);
  const freshnessAgeMs = Date.now() - Date.parse(payload.manifestFreshness.asOf);
  assert.ok(freshnessAgeMs >= 0 && freshnessAgeMs < 61_000, "serving adapter must evaluate freshness at request time");
  assert.ok(Date.parse(payload.manifestFreshness.asOf) >= Date.parse(manifest.audit.verifiedAt));
});

test("serves persisted monitoring state separately and never probes on request", async () => {
  let assetCalls = 0;
  const response = await worker.fetch(new Request("https://example.test/api/status"), {
    ASSETS: { fetch: async () => { assetCalls += 1; return new Response("unexpected"); } },
  });

  assert.equal(response.status, 503);
  assert.equal(assetCalls, 0);
  assert.equal((await response.json()).error, "monitor_state_unavailable");
});

test("serves activity only from an explicit binding and never fabricates it", async () => {
  let assetCalls = 0;
  const missing = await worker.fetch(new Request("https://example.test/api/activity"), {
    ASSETS: { fetch: async () => { assetCalls += 1; return new Response("unexpected"); } },
  });
  assert.equal(missing.status, 503);
  assert.equal(assetCalls, 0);

  const response = await worker.fetch(new Request("https://example.test/api/activity"), {
    ASSETS: { fetch: async () => new Response("unexpected", { status: 500 }) },
    LATEST_ACTIVITY_STATE: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      thread: { state: "running", startedAt: null },
      progress: { mode: "unavailable", completed: null, total: null, percent: null },
      counts: { workflows: 0, skills: 0, agents: 0 },
      usage: {},
      lock: { state: "unlocked", owner: null },
      freshness: { heartbeatAt: new Date().toISOString(), ageSeconds: 0 },
      capabilities: {},
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).thread.state, "running");
});

test("emits the files required by Sites packaging", { skip: process.env.PROJECT_STATUS_SKIP_BUILD_ARTIFACT_TEST === "1" }, async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/server/status-api.js", import.meta.url));
  await access(new URL("../dist/.project-status/manifest.json", import.meta.url));
  await access(new URL("../dist/packages/core/index.mjs", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));

  const builtWorker = (await import(`../dist/server/index.js?test=${Date.now()}`)).default;
  const response = await builtWorker.fetch(new Request("https://example.test/status/manifest"), {
    ASSETS: { fetch: async () => new Response("unexpected", { status: 500 }) },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).score.earnedWeight, expectedEarnedWeight);
});
