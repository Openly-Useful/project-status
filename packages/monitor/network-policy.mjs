import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class ProbePolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProbePolicyError";
    this.code = code;
  }
}

function parseIpv4(address) {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function inIpv4Range(parts, first, prefixBits) {
  const value = parts.reduce((total, part) => (total << 8) + part, 0) >>> 0;
  const base = first.reduce((total, part) => (total << 8) + part, 0) >>> 0;
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv4Scope(address) {
  const parts = parseIpv4(address);
  if (parts === null) return null;
  const denied = [
    [[0, 0, 0, 0], 8, "unspecified"],
    [[10, 0, 0, 0], 8, "private"],
    [[100, 64, 0, 0], 10, "shared"],
    [[127, 0, 0, 0], 8, "loopback"],
    [[169, 254, 0, 0], 16, "link_local"],
    [[172, 16, 0, 0], 12, "private"],
    [[192, 0, 0, 0], 24, "reserved"],
    [[192, 0, 2, 0], 24, "documentation"],
    [[192, 88, 99, 0], 24, "reserved"],
    [[192, 168, 0, 0], 16, "private"],
    [[198, 18, 0, 0], 15, "benchmark"],
    [[198, 51, 100, 0], 24, "documentation"],
    [[203, 0, 113, 0], 24, "documentation"],
    [[224, 0, 0, 0], 4, "multicast"],
    [[240, 0, 0, 0], 4, "reserved"],
  ];
  return denied.find(([base, prefix]) => inIpv4Range(parts, base, prefix))?.[2] ?? "public";
}

function expandIpv6(address) {
  const withoutZone = address.toLowerCase().split("%")[0];
  let normalized = withoutZone;
  const embeddedIpv4 = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) {
    const parts = parseIpv4(embeddedIpv4);
    if (parts === null) return null;
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    normalized = normalized.slice(0, -embeddedIpv4.length) + `${high}:${low}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

function ipv6Scope(address) {
  if (isIP(address) !== 6) return null;
  const groups = expandIpv6(address);
  if (groups === null) return "reserved";

  const allZero = groups.every((group) => group === 0);
  if (allZero) return "unspecified";
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return "loopback";
  if ((groups[0] & 0xfe00) === 0xfc00) return "private";
  if ((groups[0] & 0xffc0) === 0xfe80) return "link_local";
  if ((groups[0] & 0xffc0) === 0xfec0) return "private";
  if ((groups[0] & 0xff00) === 0xff00) return "multicast";
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return "documentation";

  const ipv4Mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const ipv4Compatible = groups.slice(0, 6).every((group) => group === 0);
  if (ipv4Mapped || ipv4Compatible) {
    const address4 = [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
    return ipv4Scope(address4);
  }
  return "public";
}

export function addressScope(address) {
  return ipv4Scope(address) ?? ipv6Scope(address) ?? "invalid";
}

function hostnameIsLocal(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized.endsWith(".home.arpa");
}

export async function defaultResolveHostname(hostname) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** Validate a probe URL and every currently resolved address before I/O. */
export async function validateProbeUrl(value, options = {}) {
  const {
    allowPrivateNetwork = false,
    resolveHostname = defaultResolveHostname,
  } = options;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbePolicyError("invalid_url", "Probe URL must be a valid absolute URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new ProbePolicyError("unsupported_protocol", "Probe URL must use http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProbePolicyError("credentials_not_allowed", "Probe URLs must not contain embedded credentials.");
  }
  if (url.href.length > 2048) {
    throw new ProbePolicyError("url_too_long", "Probe URL must not exceed 2,048 characters.");
  }

  const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!allowPrivateNetwork && hostnameIsLocal(hostname)) {
    throw new ProbePolicyError("private_network_denied", "Local and private network targets are denied.");
  }

  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    const scope = addressScope(hostname);
    if (!allowPrivateNetwork && scope !== "public") {
      throw new ProbePolicyError("private_network_denied", `Network target is not globally routable (${scope}).`);
    }
    return { url, addresses: [hostname] };
  }

  let addresses;
  try {
    addresses = await resolveHostname(hostname);
  } catch {
    throw new ProbePolicyError("dns_resolution_failed", "Probe hostname could not be resolved.");
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ProbePolicyError("dns_resolution_failed", "Probe hostname did not resolve to an address.");
  }
  for (const address of addresses) {
    const scope = addressScope(address);
    if (!allowPrivateNetwork && scope !== "public") {
      throw new ProbePolicyError("private_network_denied", `Resolved network target is not globally routable (${scope}).`);
    }
  }
  return { url, addresses: [...new Set(addresses)].sort() };
}
