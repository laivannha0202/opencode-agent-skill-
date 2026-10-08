// V16.13 Research network policy — POLICY OWNER D.
//
// Owns: URL canonicalization, SSRF policy, redirects, privacy/egress
// decision, external fetch limits. Does NOT own: research planning,
// provider selection, claim truth.
//
// Research network policy is SEPARATE from local-dev browser policy.

import { containsSecret, redactSecrets } from "./secret-redaction.mjs";

export const RESEARCH_NETWORK_POLICY = "research-network-policy-v16-13";
export const RESEARCH_NETWORK_SCHEMA_VERSION = 1;

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "mc_cid",
  "mc_eid", "igshid", "ref", "referrer", "spm",
]);

const PRIVATE_V4 = [
  { base: 0x00000000, mask: 0xff000000 }, // 0.0.0.0/8 ("this network")
  { base: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8 loopback
  { base: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { base: 0x64400000, mask: 0xffc00000 }, // 100.64.0.0/10 CGNAT (unsafe for egress)
  { base: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { base: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
  { base: 0xc0000000, mask: 0xffffff00 }, // 192.0.0.0/24 IETF protocol / metadata
  { base: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 link-local
  { base: 0xc6120000, mask: 0xfffe0000 }, // 198.18.0.0/15 benchmarking
  { base: 0xe0000000, mask: 0xf0000000 }, // 224.0.0.0/4 multicast
  { base: 0xf0000000, mask: 0xf0000000 }, // 240.0.0.0/4 reserved / 255.255.255.255
];

const CLOUD_METADATA_V4 = new Set(["169.254.169.254", "100.100.100.200", "192.0.0.192"]);
const UNSAFE_SCHEMES = new Set(["file:", "data:", "javascript:", "vbscript:", "ftp:", "gopher:"]);

function ipv4ToInt(host) {
  const parts = String(host).split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function isPrivateV4(host) {
  const n = ipv4ToInt(host);
  if (n == null) return false;
  const unsigned = n >>> 0;
  return PRIVATE_V4.some(({ base, mask }) => ((unsigned & mask) >>> 0) === (base >>> 0));
}

// IPv6 classification. Returns true for loopback, unspecified, ULA (fc00::/7),
// link-local (fe80::/10), multicast (ff00::/8), IPv4-mapped private, and any
// IPv4-embedded address that is itself private. Conservative: an address we
// cannot classify as clearly public is treated as private for research egress.
function normalizeIpv6(raw) {
  let host = String(raw || "").toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone); // strip scope id
  return host;
}

function parseIpv6ToBytes(host) {
  let text = normalizeIpv6(host);
  if (!text.includes(":")) return null;
  // Handle IPv4-mapped suffix (::ffff:1.2.3.4).
  const embedded = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  let v4Tail = null;
  if (embedded) {
    const n = ipv4ToInt(embedded[2]);
    if (n == null) return null;
    v4Tail = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    text = embedded[1] + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = [];
  for (const part of head) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  const missing = 8 - (head.length + tail.length) - (v4Tail ? 0 : 0);
  if (halves.length === 2) {
    if (missing < 0) return null;
    for (let i = 0; i < missing; i += 1) groups.push(0);
  }
  for (const part of tail) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  if (v4Tail) { bytes[12] = v4Tail[0]; bytes[13] = v4Tail[1]; bytes[14] = v4Tail[2]; bytes[15] = v4Tail[3]; }
  return bytes;
}

function isPrivateIpv6(host) {
  const bytes = parseIpv6ToBytes(host);
  if (!bytes) return false;
  // Unspecified :: and loopback ::1
  if (bytes.every((b) => b === 0)) return true;
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  const first = bytes[0];
  // fc00::/7 unique local
  if ((first & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local
  if (first === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // ff00::/8 multicast
  if (first === 0xff) return true;
  // IPv4-mapped ::ffff:0:0/96 -> classify the embedded v4
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return isPrivateV4(v4) || CLOUD_METADATA_V4.has(v4);
  }
  return false;
}

function isLoopbackOrPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost") return true;
  if (host === "::1" || host === "[::1]") return true;
  if (host.endsWith(".localhost")) return true;
  if (isPrivateV4(host)) return true;
  if (CLOUD_METADATA_V4.has(host)) return true;
  if (isPrivateIpv6(host)) return true;
  // Any remaining bracketed / colon-bearing host is an IPv6 literal we could not
  // prove public: fail closed for research egress.
  if (host.includes(":")) return true;
  // Metadata hostnames.
  if (host === "metadata.google.internal" || host === "instance-data" || host === "169.254.169.254.nip.io") return true;
  return false;
}

/**
 * Classify a single RESOLVED address string (from a DNS lookup) as public or
 * private. A hostname that resolves to a private/link-local/metadata address
 * must be blocked even when the hostname text looked public.
 *
 * @returns {{ allowed: boolean, reason: string, address: string }}
 */
export function checkResolvedAddress(address) {
  const value = String(address || "").trim();
  if (!value) return { allowed: false, reason: "BLOCKED_POLICY:empty-address", address: value };
  const isV6 = value.includes(":");
  const blocked = isV6 ? isPrivateIpv6(value) : (isPrivateV4(value) || CLOUD_METADATA_V4.has(value));
  if (blocked) return { allowed: false, reason: `BLOCKED_POLICY:resolved-private-address:${value}`, address: value };
  return { allowed: true, reason: "resolved-public", address: value };
}

/**
 * Validate a set of resolved addresses for a hostname. If ANY resolved address
 * is private the whole target is BLOCKED_POLICY (a DNS answer that mixes public
 * and private is treated as hostile). An empty set is treated as unresolvable.
 */
export function checkResolvedAddresses(addresses = []) {
  const list = (Array.isArray(addresses) ? addresses : []).map((a) => String(a || "").trim()).filter(Boolean);
  if (!list.length) return { allowed: false, reason: "BLOCKED_POLICY:unresolvable-host", failure: "BLOCKED_POLICY" };
  for (const address of list) {
    const check = checkResolvedAddress(address);
    if (!check.allowed) return { allowed: false, reason: check.reason, failure: "BLOCKED_POLICY", address };
  }
  return { allowed: true, reason: "all-resolved-addresses-public", addresses: list };
}

export function isPrivateIpv4(host) {
  return isPrivateV4(host) || CLOUD_METADATA_V4.has(String(host || ""));
}

export function isPrivateIpv6Host(host) {
  return isPrivateIpv6(host);
}

/**
 * Canonicalize a URL for dedup. Strips tracking params + fragments, lowercases
 * host. Does NOT over-normalize distinct semantic pages: path and meaningful
 * query keys are preserved.
 */
export function canonicalizeUrl(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("empty-url");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("invalid-url");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  // Drop default ports.
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

/**
 * SSRF + scheme + credential gate. PUBLIC HTTPS ONLY by default.
 * Returns { allowed: boolean, reason: string }.
 */
export function checkUrlAllowed(raw, options = {}) {
  const text = String(raw || "").trim();
  if (!text) return { allowed: false, reason: "BLOCKED_POLICY:empty-url", failure: "BLOCKED_POLICY" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { allowed: false, reason: "BLOCKED_POLICY:invalid-url", failure: "BLOCKED_POLICY" };
  }
  const scheme = url.protocol.toLowerCase();
  if (UNSAFE_SCHEMES.has(scheme)) {
    return { allowed: false, reason: `BLOCKED_POLICY:unsafe-scheme:${scheme}`, failure: "BLOCKED_POLICY" };
  }
  if (scheme !== "https:") {
    if (options.allowHttp !== true) {
      return { allowed: false, reason: `BLOCKED_POLICY:non-https-scheme:${scheme}`, failure: "BLOCKED_POLICY" };
    }
  }
  if (url.username || url.password) {
    return { allowed: false, reason: "BLOCKED_POLICY:credential-url", failure: "BLOCKED_POLICY" };
  }
  if (isLoopbackOrPrivateHost(url.hostname)) {
    return { allowed: false, reason: `BLOCKED_POLICY:private-host:${url.hostname}`, failure: "BLOCKED_POLICY" };
  }
  return { allowed: true, reason: "allowed" };
}

/**
 * Validate EVERY redirect hop. A public -> private redirect is BLOCKED_POLICY.
 */
export function validateRedirectChain(hops = [], options = {}) {
  const list = Array.isArray(hops) ? hops : [];
  for (let i = 0; i < list.length; i += 1) {
    const hop = String(list[i] || "");
    const check = checkUrlAllowed(hop, options);
    if (!check.allowed) {
      return { allowed: false, reason: `BLOCKED_POLICY:redirect-hop-${i}:${check.reason}`, failure: "BLOCKED_POLICY", hopIndex: i };
    }
  }
  return { allowed: true, reason: "redirect-chain-allowed" };
}

/**
 * Outbound privacy classification. Reuses lib/secret-redaction.mjs.
 * Secret-containing queries are DENIED, never silently redacted-and-sent.
 */
export function classifyOutboundQuery(text, options = {}) {
  const raw = typeof text === "string" ? text : JSON.stringify(text ?? "");
  if (!raw.trim()) return { verdict: "DENY_EXTERNAL", reason: "empty-query", redacted: raw };
  if (containsSecret(raw, options)) {
    return { verdict: "DENY_EXTERNAL", reason: "secret-detected-in-query", redacted: redactSecrets(raw, options).text };
  }
  // Private-source markers force deny even without a token shape.
  if (/(?:\.env\b|private.*repo|internal.*url|localhost|127\.0\.0\.1|customer.*data|auth.*state|browser.*profile)/i.test(raw)) {
    return { verdict: "DENY_EXTERNAL", reason: "private-source-marker", redacted: raw };
  }
  if (/password|token|cookie|secret|otp|private/i.test(raw)) {
    return { verdict: "REDACTION_REQUIRED", reason: "sensitive-keyword", redacted: redactSecrets(raw, options).text };
  }
  return { verdict: "SAFE_PUBLIC_QUERY", reason: "public-abstract-query", redacted: raw };
}

const SUPPORTED_CONTENT_TYPES = [
  "text/html", "text/plain", "text/markdown", "application/json",
  "application/vnd.github", "application/xml", "text/xml",
];

/**
 * External fetch limits: bounded bytes + supported types.
 */
export function checkFetchLimits({ bytes, contentType, maxBytes = 2_000_000 } = {}) {
  const n = bytes == null ? null : Number(bytes);
  if (n != null && Number.isFinite(n) && n > maxBytes) {
    return { allowed: false, reason: "OVERSIZED", failure: "OVERSIZED" };
  }
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  if (ct && !SUPPORTED_CONTENT_TYPES.some((t) => ct === t || ct.endsWith("+json"))) {
    if (/^(image|video|audio|font|application\/(zip|octet-stream|pdf|x-))/.test(ct)) {
      return { allowed: false, reason: `UNSUPPORTED_TYPE:${ct}`, failure: "UNSUPPORTED_TYPE" };
    }
  }
  return { allowed: true, reason: "fetch-limits-ok" };
}

const INSTRUCTION_PATTERNS = [
  /ignore previous instructions/i,
  /run this command/i,
  /upload your repository/i,
  /send your api key/i,
  /disable verifier/i,
  /\bmark pass\b/i,
  /publish now/i,
];

/**
 * Scan fetched content for prompt-injection markers. Content ALWAYS stays
 * DATA: instructionAuthority is "none" regardless of scan outcome.
 */
export function scanInjection(content) {
  const text = String(content || "");
  const hits = [];
  for (const pattern of INSTRUCTION_PATTERNS) {
    if (pattern.test(text)) hits.push(String(pattern.source).slice(0, 48));
  }
  return {
    instructionAuthority: "none",
    injectionDetected: hits.length > 0,
    hits,
  };
}

export const researchNetworkPolicyExports = Object.freeze({
  canonicalizeUrl,
  checkUrlAllowed,
  validateRedirectChain,
  classifyOutboundQuery,
  checkFetchLimits,
  scanInjection,
  checkResolvedAddress,
  checkResolvedAddresses,
  isPrivateIpv4,
  isPrivateIpv6Host,
});
