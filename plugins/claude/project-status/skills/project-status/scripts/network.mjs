import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const SECRET_QUERY_RE = /(?:^|_)(?:access|api|auth|credential|key|password|secret|signature|token)(?:$|_)/i;

function blockedIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function blockedIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? blockedIpv4(mapped[1]) : false;
}

export function isBlockedAddress(address) {
  const version = isIP(address);
  if (version === 4) return blockedIpv4(address);
  if (version === 6) return blockedIpv6(address);
  return true;
}

function isLocalHostname(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

export function redactUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function assessUrl(value, options = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, display: "<invalid-url>", reason: "invalid URL" };
  }
  const display = redactUrl(parsed.toString());
  if (parsed.username || parsed.password) return { ok: false, display, reason: "URL credentials are forbidden" };
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_RE.test(key)) return { ok: false, display, reason: "secret-like query parameters are forbidden" };
  }
  const local = isLocalHostname(parsed.hostname);
  if (local && !options.allowLocalhost) return { ok: false, display, reason: "localhost requires --allow-localhost" };
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:" && options.allowLocalhost)) {
    return { ok: false, display, reason: "HTTPS is required" };
  }
  if (isIP(parsed.hostname) && isBlockedAddress(parsed.hostname) && !(local && options.allowLocalhost)) {
    return { ok: false, display, reason: "private or special-use address is forbidden" };
  }
  return { ok: true, display, parsed, local };
}

async function resolveAndCheck(assessment, options) {
  if (assessment.local && options.allowLocalhost) return;
  const answers = await lookup(assessment.parsed.hostname, { all: true, verbatim: true });
  if (answers.length === 0) throw new Error("hostname has no addresses");
  if (answers.some((answer) => isBlockedAddress(answer.address))) throw new Error("hostname resolves to a private or special-use address");
}

export async function safeFetch(value, options = {}) {
  const timeoutMs = Math.max(100, Math.min(30_000, Number(options.timeoutMs ?? 5_000)));
  const maxRedirects = Math.max(0, Math.min(3, Number(options.maxRedirects ?? 2)));
  const started = performance.now();
  let current = value;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const assessment = assessUrl(current, options);
    if (!assessment.ok) throw new Error(assessment.reason);
    await resolveAndCheck(assessment, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(assessment.parsed, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.1", "user-agent": "project-status-monitor/1" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (redirect === maxRedirects) {
        await response.body?.cancel();
        throw new Error("redirect limit exceeded");
      }
      const next = new URL(response.headers.get("location"), assessment.parsed);
      await response.body?.cancel();
      current = next.toString();
      continue;
    }
    await response.body?.cancel();
    return {
      status: response.status,
      ok: response.ok,
      finalUrl: assessment.display,
      redirects: redirect,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
  throw new Error("request did not complete");
}

export async function mapConcurrent(items, concurrency, callback) {
  const limit = Math.max(1, Math.min(10, Number(concurrency ?? 4)));
  const output = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      output[current] = await callback(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker));
  return output;
}
