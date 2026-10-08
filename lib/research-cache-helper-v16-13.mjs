// V16.13 Research cache helper — NON-AUTHORITATIVE storage.
//
// The broker owns cache POLICY (key identity, freshness class, TTL,
// forceFresh, reuse eligibility). This helper owns ONLY metadata
// persistence, schema validation, bounded LRU, atomic Windows-safe writes,
// corruption -> MISS. EvidenceStore owns body bytes; cache NEVER owns raw
// bodies.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const RESEARCH_CACHE_POLICY = "research-cache-helper-v16-13";
export const RESEARCH_CACHE_SCHEMA_VERSION = 1;
export const RESEARCH_POLICY_VERSION = "research-policy-v16-13-1";

const MAX_ENTRIES = 200;
const ATOMIC_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

const TTL_BY_FRESHNESS_MS = Object.freeze({
  STATIC_DOC: 30 * 24 * 3600_000,
  VERSIONED_DOC: 14 * 24 * 3600_000,
  RELEASE: 7 * 24 * 3600_000,
  ISSUE: 24 * 3600_000,
  PACKAGE_METADATA: 6 * 3600_000,
  CURRENT_WEB: 6 * 3600_000,
  NEWS: 6 * 3600_000,
  UNKNOWN: 6 * 3600_000,
});

export const FRESHNESS_CLASS = Object.freeze({
  STATIC_DOC: "STATIC_DOC",
  VERSIONED_DOC: "VERSIONED_DOC",
  RELEASE: "RELEASE",
  ISSUE: "ISSUE",
  PACKAGE_METADATA: "PACKAGE_METADATA",
  CURRENT_WEB: "CURRENT_WEB",
  NEWS: "NEWS",
  UNKNOWN: "UNKNOWN",
});

/**
 * Cache identity: canonical URL + content/version target + provider +
 * freshness class + installed dependency version + research policy version.
 */
export function researchCacheKey(input = {}) {
  const canonical = String(input.canonicalUrl || input.url || "").trim();
  const payload = JSON.stringify([
    canonical,
    String(input.provider || ""),
    String(input.freshnessClass || FRESHNESS_CLASS.UNKNOWN),
    String(input.installedVersion || ""),
    String(input.contentTarget || ""),
    RESEARCH_POLICY_VERSION,
  ]);
  return `research:${createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32)}`;
}

export function ttlForFreshness(freshnessClass) {
  return TTL_BY_FRESHNESS_MS[String(freshnessClass)] ?? TTL_BY_FRESHNESS_MS.UNKNOWN;
}

function cacheFileFor(dir, key) {
  const safe = key.replace(/[^a-z0-9-]/gi, "").slice(0, 64) || "entry";
  return path.join(dir, `${safe}.json`);
}

async function atomicWriteJson(file, value) {
  const text = JSON.stringify(value, null, 2) + "\n";
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let attempt = 0;
  for (;;) {
    try {
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
      return;
    } catch (error) {
      attempt += 1;
      if (attempt >= 4 || !ATOMIC_RETRY_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

function validateEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.schemaVersion !== RESEARCH_CACHE_SCHEMA_VERSION) return null;
  if (typeof raw.key !== "string" || !raw.key) return null;
  if (typeof raw.storedAt !== "number" || !Number.isFinite(raw.storedAt)) return null;
  if (typeof raw.ttlMs !== "number" || !Number.isFinite(raw.ttlMs)) return null;
  // Metadata only: evidenceRef + excerpt descriptor, never a raw body.
  if (raw.rawBody != null || raw.fullContent != null || raw.body != null) return null;
  return raw;
}

/** Read-through: corruption or schema drift is a MISS, never a throw. */
export async function readResearchCache(dir, key, options = {}) {
  const now = Number(options.now ?? Date.now());
  const file = cacheFileFor(dir, key);
  if (!existsSync(file)) return { hit: false, reason: "MISS" };
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { hit: false, reason: "MISS", corrupt: true };
  }
  const entry = validateEntry(raw);
  if (!entry) return { hit: false, reason: "MISS", corrupt: true };
  if (options.forceFresh === true) return { hit: false, reason: "FORCE_FRESH_BYPASS", entry };
  const age = now - entry.storedAt;
  const stale = age > entry.ttlMs;
  // Latest/current tasks may require revalidation even within TTL.
  if (options.revalidate === true && entry.freshnessClass === FRESHNESS_CLASS.CURRENT_WEB) {
    return { hit: false, reason: "STALE_CURRENT_WEB", entry };
  }
  if (stale) return { hit: false, reason: "STALE", entry };
  return { hit: true, reason: "HIT", entry };
}

/**
 * V16.14 conditional-revalidation headers. When a cached entry carries an ETag
 * or Last-Modified, a stale re-read can be turned into a cheap conditional GET:
 * a 304 means the body is unchanged and the cached metadata may be reused.
 * Returns {} when no validator is available.
 */
export function revalidationHeadersFor(entry = {}) {
  const headers = {};
  if (entry.etag) headers["If-None-Match"] = String(entry.etag);
  if (entry.lastModified) headers["If-Modified-Since"] = String(entry.lastModified);
  return headers;
}

/**
 * Given a conditional GET outcome, decide whether the cached entry may be
 * reused. A 304 (or a matching ETag) is a REUSE; anything else is a MISS and
 * the caller must refetch the body. Purely a decision function: no I/O.
 */
export function reuseDecisionFor(entry = {}, outcome = {}) {
  const status = Number(outcome.status || 0);
  const etag = outcome.etag || null;
  if (status === 304) return { reuse: true, reason: "NOT_MODIFIED_304" };
  if (entry.etag && etag && String(entry.etag) === String(etag)) return { reuse: true, reason: "ETAG_MATCH" };
  return { reuse: false, reason: "MUST_REFETCH" };
}

/** Refresh only the freshness clock of an entry after a successful 304. */
export async function touchResearchCache(dir, key, options = {}) {
  const file = cacheFileFor(dir, key);
  if (!existsSync(file)) return { touched: false, reason: "MISS" };
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { touched: false, reason: "MISS", corrupt: true };
  }
  const entry = validateEntry(raw);
  if (!entry) return { touched: false, reason: "MISS", corrupt: true };
  const refreshed = {
    ...entry,
    storedAt: Number(options.now ?? Date.now()),
    revalidatedAt: Number(options.now ?? Date.now()),
  };
  await atomicWriteJson(file, refreshed);
  return { touched: true, entry: refreshed };
}

export async function writeResearchCache(dir, key, metadata = {}, options = {}) {
  const ttlMs = Number.isFinite(Number(options.ttlMs))
    ? Number(options.ttlMs)
    : ttlForFreshness(metadata.freshnessClass);
  const entry = {
    schemaVersion: RESEARCH_CACHE_SCHEMA_VERSION,
    policy: RESEARCH_CACHE_POLICY,
    key,
    storedAt: Number(options.now ?? Date.now()),
    ttlMs,
    freshnessClass: metadata.freshnessClass || FRESHNESS_CLASS.UNKNOWN,
    canonicalUrl: metadata.canonicalUrl || null,
    provider: metadata.provider || null,
    evidenceRef: metadata.evidenceRef || metadata.fullContentEvidenceRef || null,
    contentHash: metadata.contentHash || null,
    excerptHash: metadata.excerptHash || null,
    excerpt: typeof metadata.excerpt === "string" ? metadata.excerpt.slice(0, 2000) : null,
    versionRelation: metadata.versionRelation || null,
    // V16.14 conditional-revalidation validators (metadata only, never a body).
    etag: metadata.etag || null,
    lastModified: metadata.lastModified || null,
    revalidatedAt: Number.isFinite(Number(metadata.revalidatedAt)) ? Number(metadata.revalidatedAt) : null,
  };
  await mkdir(dir, { recursive: true });
  await atomicWriteJson(cacheFileFor(dir, key), entry);
  return entry;
}

export function cacheDirFor(root = process.cwd()) {
  return path.join(path.resolve(root), ".ues-cache", "research-v16-13");
}

export const researchCacheHelperExports = Object.freeze({
  researchCacheKey,
  ttlForFreshness,
  readResearchCache,
  writeResearchCache,
  cacheDirFor,
  revalidationHeadersFor,
  reuseDecisionFor,
  touchResearchCache,
});
