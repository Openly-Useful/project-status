import assert from "node:assert/strict";
import test from "node:test";
import {
  addressScope,
  probeHttpTarget,
  validateProbeUrl,
} from "../packages/monitor/index.mjs";

const target = {
  id: "public-health",
  name: "Public health",
  url: "https://status.example.com/health",
};

function sequenceClock(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test("network policy denies non-HTTP, credentials, localhost, and private DNS answers", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  };

  for (const url of [
    "file:///etc/passwd",
    "https://user:secret@example.com/health",
    "http://localhost:3000/health",
    "http://127.0.0.1/health",
    "http://[::1]/health",
  ]) {
    const result = await probeHttpTarget({ ...target, url }, { fetchImpl, clock: () => new Date(0) });
    assert.equal(result.ok, false);
    assert.match(result.outcome, /unsupported_protocol|credentials_not_allowed|private_network_denied/);
  }

  const dnsResult = await probeHttpTarget(target, {
    fetchImpl,
    resolveHostname: async () => ["10.20.30.40"],
    clock: () => new Date(0),
  });
  assert.equal(dnsResult.outcome, "private_network_denied");
  assert.equal(fetchCalls, 0);
});

test("address classification covers private, link-local, multicast, and mapped IPv6", () => {
  assert.equal(addressScope("8.8.8.8"), "public");
  assert.equal(addressScope("10.0.0.2"), "private");
  assert.equal(addressScope("169.254.1.2"), "link_local");
  assert.equal(addressScope("224.0.0.1"), "multicast");
  assert.equal(addressScope("::1"), "loopback");
  assert.equal(addressScope("fe80::1"), "link_local");
  assert.equal(addressScope("ff02::1"), "multicast");
  assert.equal(addressScope("::ffff:127.0.0.1"), "loopback");
});

test("successful probes use manual redirect mode and enforce the response byte bound", async () => {
  const calls = [];
  const result = await probeHttpTarget(target, {
    fetchImpl: async (url, init, context) => {
      calls.push({ url, init, context });
      return new Response("okay", { status: 200 });
    },
    resolveHostname: async () => ["93.184.216.34"],
    clock: sequenceClock(new Date(1_000), new Date(1_025)),
    maxResponseBytes: 4,
  });

  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 25);
  assert.equal(result.bytesRead, 4);
  assert.equal(result.statusCode, 200);
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(calls[0].context.approvedAddresses, ["93.184.216.34"]);

  const tooLarge = await probeHttpTarget(target, {
    fetchImpl: async () => new Response("12345", { headers: { "content-length": "5" } }),
    resolveHostname: async () => ["93.184.216.34"],
    clock: () => new Date(0),
    maxResponseBytes: 4,
  });
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.outcome, "response_too_large");
  assert.equal(tooLarge.bytesRead, 0);
});

test("redirects are denied by default and every explicitly followed hop is revalidated", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://redirect.example.com/health" } });
  };
  const denied = await probeHttpTarget(target, {
    fetchImpl,
    resolveHostname: async () => ["93.184.216.34"],
    clock: () => new Date(0),
  });
  assert.equal(denied.outcome, "redirect_denied");
  assert.equal(calls, 1);

  const resolved = [];
  calls = 0;
  const followed = await probeHttpTarget(target, {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(null, { status: 307, headers: { location: "https://redirect.example.com/health" } })
        : new Response("ok", { status: 200 });
    },
    resolveHostname: async (hostname) => {
      resolved.push(hostname);
      return ["93.184.216.34"];
    },
    allowRedirects: true,
    maxRedirects: 1,
    clock: () => new Date(0),
  });
  assert.equal(followed.ok, true);
  assert.equal(followed.redirectCount, 1);
  assert.deepEqual(resolved, ["status.example.com", "redirect.example.com"]);
});

test("the timeout aborts fetch and reports a stable actionable outcome", async () => {
  const result = await probeHttpTarget(target, {
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    resolveHostname: async () => ["93.184.216.34"],
    timeoutMs: 5,
    clock: () => new Date(0),
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "timeout");
  assert.match(result.failure.message, /5ms/);
});

test("the timeout also bounds DNS preflight and never starts fetch after abort", async () => {
  let fetchCalls = 0;
  const result = await probeHttpTarget(target, {
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response("unexpected");
    },
    resolveHostname: async () => new Promise(() => {}),
    timeoutMs: 5,
    clock: () => new Date(0),
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "timeout");
  assert.equal(fetchCalls, 0);
});

test("the private-network override is explicit and injectable", async () => {
  const result = await validateProbeUrl("http://127.0.0.1/health", { allowPrivateNetwork: true });
  assert.equal(result.url.hostname, "127.0.0.1");
  assert.deepEqual(result.addresses, ["127.0.0.1"]);
});
