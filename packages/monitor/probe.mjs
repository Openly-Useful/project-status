import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

import { ProbePolicyError, validateProbeUrl } from "./network-policy.mjs";

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function responseHeaders(headers) {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(name, item);
    } else if (value !== undefined) {
      normalized.set(name, String(value));
    }
  }
  return normalized;
}

function requestAtAddress(url, init, address) {
  const client = url.protocol === "https:" ? https : http;
  const family = isIP(address);
  if (family === 0) return Promise.reject(new Error("Approved probe address is invalid."));
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method: init.method,
      headers: init.headers,
      signal: init.signal,
      agent: false,
      maxHeaderSize: 16 * 1024,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (incoming) => {
      resolve(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode ?? 500,
        statusText: incoming.statusMessage ?? "",
        headers: responseHeaders(incoming.headers),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

/**
 * Default Node fetch adapter. It connects only to an address approved by the
 * policy preflight, preventing a second DNS resolution from rebinding the host.
 */
export async function pinnedNodeFetch(value, init, context = {}) {
  const url = new URL(value);
  const addresses = context.approvedAddresses;
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ProbePolicyError("address_pin_missing", "Probe did not have an approved network address.");
  }
  let lastError;
  for (const address of addresses) {
    try {
      return await requestAtAddress(url, init, address);
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted) throw error;
    }
  }
  throw lastError ?? new Error("Probe could not connect to an approved address.");
}

function instant(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("Injected monitor clock returned an invalid instant.");
  return date;
}

function boundedInteger(value, name, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function normalizeProbeTarget(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new TypeError("Probe target must be an object.");
  }
  const allowed = new Set(["id", "name", "url", "method", "expectedStatus"]);
  for (const key of Object.keys(target)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown probe target property: ${key}`);
  }
  if (typeof target.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.id)) {
    throw new TypeError("Probe target id must be a lowercase kebab-case identifier.");
  }
  if (typeof target.name !== "string" || target.name.trim() === "" || target.name.length > 100) {
    throw new TypeError("Probe target name must contain 1 to 100 characters.");
  }
  if (typeof target.url !== "string") throw new TypeError("Probe target url must be a string.");
  const method = target.method ?? "GET";
  if (!["GET", "HEAD"].includes(method)) throw new TypeError("Probe method must be GET or HEAD.");

  let expectedStatus = target.expectedStatus ?? { min: 200, max: 299 };
  if (Number.isInteger(expectedStatus)) expectedStatus = { min: expectedStatus, max: expectedStatus };
  if (expectedStatus === null || typeof expectedStatus !== "object" || Array.isArray(expectedStatus)) {
    throw new TypeError("expectedStatus must be an HTTP status or { min, max } range.");
  }
  const min = boundedInteger(expectedStatus.min, "expectedStatus.min", { min: 100, max: 599 });
  const max = boundedInteger(expectedStatus.max, "expectedStatus.max", { min: 100, max: 599 });
  if (max < min) throw new TypeError("expectedStatus.max must be greater than or equal to min.");
  return Object.freeze({ id: target.id, name: target.name.trim(), url: target.url, method, expectedStatus: { min, max } });
}

async function consumeBoundedBody(response, maxResponseBytes) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxResponseBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ProbePolicyError("response_too_large", `Response exceeded the ${maxResponseBytes}-byte limit.`);
  }
  if (response.body === null) return 0;

  const reader = response.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return bytesRead;
      bytesRead += value.byteLength;
      if (bytesRead > maxResponseBytes) {
        await reader.cancel();
        throw new ProbePolicyError("response_too_large", `Response exceeded the ${maxResponseBytes}-byte limit.`);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function failure(code, message, fields = {}) {
  return { ok: false, outcome: code, failure: { code, message }, statusCode: null, bytesRead: 0, ...fields };
}

/**
 * Execute one bounded HTTP probe. Network access is the only side effect; this
 * function never persists. fetch, DNS resolution, timers, and clock are injectable.
 */
export async function probeHttpTarget(rawTarget, dependencies = {}) {
  const target = normalizeProbeTarget(rawTarget);
  const {
    fetchImpl = pinnedNodeFetch,
    resolveHostname,
    clock = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    allowPrivateNetwork = false,
    allowRedirects = false,
    maxRedirects = allowRedirects ? 3 : 0,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  } = dependencies;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  boundedInteger(timeoutMs, "timeoutMs", { min: 1, max: 120_000 });
  boundedInteger(maxResponseBytes, "maxResponseBytes", { min: 1, max: 10 * 1024 * 1024 });
  boundedInteger(maxRedirects, "maxRedirects", { min: 0, max: 10 });

  const started = instant(clock);
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(new Error("probe timeout")), timeoutMs);
  let result;
  let currentUrl = target.url;
  let redirectCount = 0;

  try {
    while (true) {
      const validated = await validateProbeUrl(currentUrl, { allowPrivateNetwork, resolveHostname });
      const response = await fetchImpl(validated.url.href, {
        method: target.method,
        headers: {
          accept: "*/*",
          "user-agent": "project-status-monitor/1.0.0",
        },
        redirect: "manual",
        signal: controller.signal,
      }, {
        // Native fetch ignores this third parameter. Security-aware injected
        // adapters can use it to pin the connection to a preflighted address.
        approvedAddresses: validated.addresses,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!allowRedirects) {
          result = failure("redirect_denied", "HTTP redirects are denied by the probe policy.", { statusCode: response.status });
          break;
        }
        if (location === null) {
          result = failure("redirect_missing_location", "Redirect response did not include a Location header.", { statusCode: response.status });
          break;
        }
        if (redirectCount >= maxRedirects) {
          result = failure("too_many_redirects", `Probe exceeded the ${maxRedirects}-redirect limit.`, { statusCode: response.status });
          break;
        }
        currentUrl = new URL(location, validated.url).href;
        redirectCount += 1;
        continue;
      }

      const bytesRead = target.method === "HEAD" ? 0 : await consumeBoundedBody(response, maxResponseBytes);
      const expected = response.status >= target.expectedStatus.min && response.status <= target.expectedStatus.max;
      result = expected
        ? { ok: true, outcome: "success", failure: null, statusCode: response.status, bytesRead }
        : failure("unexpected_status", `Expected HTTP ${target.expectedStatus.min}-${target.expectedStatus.max}; received ${response.status}.`, {
          statusCode: response.status,
          bytesRead,
        });
      break;
    }
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      result = failure("timeout", `Probe exceeded the ${timeoutMs}ms timeout.`);
    } else if (error instanceof ProbePolicyError) {
      result = failure(error.code, error.message);
    } else {
      result = failure("network_error", "Probe failed before receiving a complete HTTP response.");
    }
  } finally {
    clearTimer(timer);
  }

  const completed = instant(clock);
  return Object.freeze({
    id: target.id,
    name: target.name,
    url: target.url,
    attemptedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    redirectCount,
    ...result,
  });
}
