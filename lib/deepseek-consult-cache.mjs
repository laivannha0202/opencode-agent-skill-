// V16.6 DeepSeek consult cache / dedup.
//
// Same run, same evidence, same question -> no second external round trip.
//
// The cache is IN MEMORY ONLY and bounded: V16.6 does not create a second
// persistent conversation store. Raw advice already lives in the Evidence
// Store; here we only remember that a byte-equivalent question was already
// answered, plus the evidence reference to that answer.
//
// Key inputs (all fingerprinted, never raw): HEAD, staged+worktree diff,
// evidence fingerprint, advisor role, question, constraints. The key therefore
// invalidates itself the moment the repository or the evidence changes.

import { createHash } from "node:crypto"
import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"

export const CONSULT_CACHE_SCHEMA_VERSION = 1
export const CONSULT_CACHE_POLICY = "deepseek-consult-cache-v16-6"
export const DEFAULT_CACHE_ENTRIES = 64
export const HARD_MAX_CACHE_ENTRIES = 128
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

function normalize(value, limit = 8_000) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, limit)
}

/**
 * Deterministic cache key. Fingerprints only - no secret, path or payload is
 * ever stored in plaintext outside the Evidence Store.
 */
export function consultCacheKey(input = {}) {
  const parts = [
    `v${CONSULT_CACHE_SCHEMA_VERSION}`,
    `head:${normalize(input.head, 80)}`,
    `diff:${sha256(normalize(input.diff, 200_000))}`,
    `evidence:${normalize(input.evidenceFingerprint, 128)}`,
    `role:${normalize(input.role, 64)}`,
    `phase:${normalize(input.phase, 64)}`,
    `mode:${normalize(input.reasoningMode, 32)}`,
    `question:${sha256(normalize(input.question, 20_000))}`,
    `constraints:${sha256(normalize(input.constraints, 8_000))}`,
  ]
  return sha256(parts.join("|"))
}

/**
 * Bounded LRU consult cache.
 *
 * Lifecycle is explicit: `beginRun()` resets per-run counters so a fresh task
 * never inherits a stale hit, and `invalidate()` records WHY the cache was
 * dropped (head moved, evidence changed, session rotated, mode changed).
 */
export function createConsultCache(options = {}) {
  const maxEntries = Math.max(
    1,
    Math.min(HARD_MAX_CACHE_ENTRIES, Number(options.maxEntries) || DEFAULT_CACHE_ENTRIES),
  )
  const ttlMs = Math.max(0, Number(options.ttlMs) || DEFAULT_CACHE_TTL_MS)
  const entries = new Map()
  const stats = {
    hits: 0,
    misses: 0,
    duplicatesAvoided: 0,
    invalidations: 0,
    evictions: 0,
    stores: 0,
    bytesAvoided: 0,
  }
  let currentRunId = null

  function prune(now) {
    for (const [key, entry] of entries) {
      if (ttlMs > 0 && now - entry.storedAt > ttlMs) {
        entries.delete(key)
        stats.evictions += 1
      }
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
      stats.evictions += 1
    }
  }

  return {
    schemaVersion: CONSULT_CACHE_SCHEMA_VERSION,
    policy: CONSULT_CACHE_POLICY,
    maxEntries,
    ttlMs,

    beginRun(runId) {
      currentRunId = String(runId || "")
      prune(Date.now())
      return currentRunId
    },

    /** Returns a cached entry or null. `now` is injectable for tests. */
    get(key, now = Date.now()) {
      const row = entries.get(String(key))
      if (!row) {
        stats.misses += 1
        return null
      }
      if (ttlMs > 0 && now - row.storedAt > ttlMs) {
        entries.delete(String(key))
        stats.evictions += 1
        stats.misses += 1
        return null
      }
      // refresh LRU position
      entries.delete(String(key))
      entries.set(String(key), row)
      stats.hits += 1
      stats.duplicatesAvoided += 1
      stats.bytesAvoided += row.answerChars || 0
      return { ...row, hit: true, runId: currentRunId }
    },

    put(key, value = {}, now = Date.now()) {
      prune(now)
      const row = {
        key: String(key),
        runId: currentRunId,
        storedAt: now,
        answer: value.answer ?? null,
        answerChars: Number(value.answerChars) || String(value.answer ?? "").length,
        evidenceRef: value.evidenceRef ?? null,
        role: String(value.role || ""),
        phase: String(value.phase || ""),
        telemetryRef: value.telemetryRef ?? null,
        turn: Number(value.turn) || 0,
      }
      if (!entries.has(String(key))) stats.stores += 1
      entries.set(String(key), row)
      prune(now)
      return row
    },

    /** Drop everything, recording an explicit machine reason. */
    invalidate(reason = "unspecified", now = Date.now()) {
      const count = entries.size
      entries.clear()
      stats.invalidations += 1
      return { invalidations: stats.invalidations, dropped: count, reason: String(reason), at: now }
    },

    size: () => entries.size,

    stats: () => ({
      ...stats,
      size: derived(entries.size),
      maxEntries: derived(maxEntries),
    }),

    /**
     * Telemetry with explicit provenance. Cache counters are MEASURED (they
     * are observed directly); `bytesAvoided` is DERIVED from stored lengths.
     */
    telemetry() {
      return {
        schemaVersion: CONSULT_CACHE_SCHEMA_VERSION,
        policy: CONSULT_CACHE_POLICY,
        hits: measured(stats.hits),
        misses: measured(stats.misses),
        duplicatesAvoided: measured(stats.duplicatesAvoided),
        invalidations: measured(stats.invalidations),
        evictions: measured(stats.evictions),
        stores: measured(stats.stores),
        entries: derived(entries.size),
        maxEntries: derived(maxEntries),
        bytesAvoided: derived(stats.bytesAvoided),
        tokensAvoided: NOT_MEASURED,
        latencyMsAvoided: NOT_MEASURED,
        persistence: "in-memory-only",
        provenance: {
          counters: "MEASURED",
          capacity: "DERIVED",
          savings: "DERIVED-from-content-length",
        },
      }
    },

    clear() {
      entries.clear()
    },
  }
}

/** Default instance used by the runtime (single process, per task run). */
let defaultCache = null
export function consultCache() {
  if (!defaultCache) defaultCache = createConsultCache()
  return defaultCache
}

export function resetConsultCacheForTests() {
  defaultCache = null
  return defaultCache
}

/**
 * Convenience: key + lookup in one call, so the call site in ues.ts stays a
 * single expression. Returns `{key, cached, answer, evidenceRef}`.
 */
export function consultOnce(cache, input = {}, now = Date.now()) {
  const key = consultCacheKey(input)
  const cached = cache.get(key, now)
  if (cached) {
    return { key, cached: true, answer: cached.answer, evidenceRef: cached.evidenceRef, turn: cached.turn }
  }
  return { key, cached: false, answer: null, evidenceRef: null, turn: 0 }
}

export const CONSULT_CACHE_EXPORTS = Object.freeze([
  "consultCacheKey",
  "createConsultCache",
  "consultCache",
  "resetConsultCacheForTests",
  "consultOnce",
])
