// V16.6.1 DeepSeek consult cache / dedup.
//
// Same repository state, same evidence, same question -> no second external
// round trip. NEW repository state or NEW evidence -> never replay.
//
// The cache is IN MEMORY ONLY and bounded: V16.6 does not create a second
// persistent conversation store. Raw advice already lives in the Evidence
// Store; here we only remember that a byte-equivalent question was already
// answered, plus the evidence reference to that answer.
//
// V16.6.1 hardening. The key must describe the REPOSITORY and EVIDENCE STATE,
// not a summary of it. The v1 key accepted a `status + path` change list and a
// 128-character prefix of the advisor packet, so two runs that touched the same
// file path with different CONTENT, and two attempts of the same task separated
// by new verifier evidence, produced the SAME key and replayed stale advice.
//
// Key inputs (all fingerprinted, never raw): workspace identity, HEAD, the real
// staged+worktree diff, a per-file content fingerprint, the evidence
// fingerprint, the full Decision Packet digest, advisor role, phase, reasoning
// mode, the normalized question, the constraints, provider and model.
//
// Governing rule: NO NEW EVIDENCE -> reuse may be allowed.
//                 NEW SOURCE / DIFF / EVIDENCE -> a stale answer must not replay.

import { createHash } from "node:crypto"
import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"

export const CONSULT_CACHE_SCHEMA_VERSION = 3
export const CONSULT_CACHE_POLICY = "deepseek-consult-cache-v16-7-1"
export const DEFAULT_CACHE_ENTRIES = 64
export const HARD_MAX_CACHE_ENTRIES = 128
export const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000

// Hard byte ceiling for any single hashed input. A longer input is hashed over
// its head AND its length so two different truncated inputs still differ.
const MAX_DIGEST_INPUT_CHARS = 400_000

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

/**
 * Whitespace normalization is ONLY allowed where whitespace cannot carry
 * meaning. A diff, a file body and a packet are hashed RAW (line-ending
 * normalization only): collapsing runs of spaces there would let a semantic
 * edit hide behind an identical key.
 */
function digestRaw(value, limit = MAX_DIGEST_INPUT_CHARS) {
  const raw = String(value ?? "").replace(/\r\n/g, "\n")
  if (raw.length <= limit) return sha256(raw)
  return sha256(`${raw.slice(0, limit)}\x00${raw.length}`)
}

/** Whitespace-insensitive normalization, used only for identifiers. */
function normalize(value, limit = 8_000) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, limit)
}

/**
 * Per-file content fingerprint.
 *
 * Accepts `[{ path, contentHash?|content?|status? }]`, a plain record of
 * `path -> content`, or a workspace snapshot's `changedFiles`. The digest is
 * computed over the CONTENT whenever content is available, so a re-edit of the
 * same path changes the fingerprint even though the status and the path do not.
 */
export function relevantFileFingerprint(files) {
  const rows = []
  if (Array.isArray(files)) {
    for (const row of files) {
      if (row === null || row === undefined) continue
      if (typeof row === "string") {
        rows.push(`${row}\x00unknown`)
        continue
      }
      const filePath = String(row.path ?? row.file ?? "")
      if (!filePath) continue
      const content = row.contentHash ?? row.sha256 ?? row.content
      const status = String(row.status ?? row.code ?? "?")
      rows.push(`${filePath}\x00${status}\x00${content === undefined || content === null ? "path-only" : digestRaw(content, 100_000)}`)
    }
  } else if (files && typeof files === "object") {
    for (const [filePath, content] of Object.entries(files)) {
      rows.push(`${filePath}\x00${digestRaw(content, 100_000)}`)
    }
  }
  if (!rows.length) return "none"
  return sha256(rows.sort().join("\n"))
}

/**
 * Deterministic cache key. Fingerprints only - no secret, path or payload is
 * ever stored in plaintext outside the Evidence Store.
 */
export function consultCacheKey(input = {}) {
  const parts = [
    `v${CONSULT_CACHE_SCHEMA_VERSION}`,
    `workspace:${normalize(input.workspaceId, 200)}`,
    `head:${normalize(input.head, 80)}`,
    `workspaceState:${normalize(input.workspaceStateFingerprint, 128)}`,
    // The REAL diff, hashed raw. v1 hashed a `status + path` list here.
    `diff:${digestRaw(input.diff, 200_000)}`,
    `files:${relevantFileFingerprint(input.relevantFiles)}`,
    `evidence:${normalize(input.evidenceFingerprint, 128)}`,
    // v1 sliced the first 128 characters of the packet; the digest is now over
    // the whole bounded packet.
    `packet:${digestRaw(input.packetFingerprint ?? input.packet, 20_000)}`,
    `role:${normalize(input.role, 64)}`,
    `phase:${normalize(input.phase, 64)}`,
    `mode:${normalize(input.reasoningMode, 32)}`,
    `question:${sha256(normalize(input.question, 20_000))}`,
    `constraints:${digestRaw(input.constraints, 8_000)}`,
    // V16.7.1 Part 13: the cache identity must be complete enough that two
    // materially different consultations can never collide. Beyond the opaque
    // profile id, the TASK fingerprint (the normalized task text), the REPO
    // fingerprint (the bounded repository identity the answer was produced
    // against) and the SESSION identity (which conversation/generation the
    // answer belongs to) are all folded in. Each is a fingerprint, never a raw
    // path, prompt or payload, and each keeps its own bucket (`none`) when
    // absent so a session-less run never replays a session-bound answer.
    `task:${normalize(input.taskFingerprint, 128) || sha256(normalize(input.task, 20_000))}`,
    `repo:${normalize(input.repoFingerprint, 128) || "none"}`,
    `session:${normalize(input.sessionIdentity, 128) || "none"}`,
    `provider:${normalize(input.provider, 64)}`,
    `model:${normalize(input.model, 96)}`,
    // V16.7 account isolation. The profile id is an OPAQUE hash of the profile
    // NAME, never a credential or a path. Two accounts can therefore never
    // share a cache entry: a consultation answered for `personal` can never be
    // replayed for `work`, even when the workspace, diff, packet and question
    // are byte-identical. An absent profile keeps its own bucket (`none`) so a
    // profile-less run never reuses a profiled answer either.
    `profile:${normalize(input.profileId, 64) || "none"}`,
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
  "relevantFileFingerprint",
  "createConsultCache",
  "consultCache",
  "resetConsultCacheForTests",
  "consultOnce",
])
