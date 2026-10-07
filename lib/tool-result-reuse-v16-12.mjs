// V16.12 Read / Search / Tool Result Reuse.
//
// WHY THIS MODULE EXISTS
//
// A long task re-reads the same file slice and re-runs the same exact search
// many times. Each repeat is deterministic and identical, yet the runtime pays
// for it again. That is wasted wall time AND wasted model context.
//
// This module is the SINGLE V16.12 owner of the question:
//
//   "Have we already produced the EXACT SAME deterministic result for this
//    operation against this EXACT workspace state?"
//
// LAWS
//
//   1. REUSE IS NEVER STALE. A file read key includes the file's CONTENT hash;
//      if a single byte changed the hash differs and the answer is MISS. A
//      search/repo query key includes the workspace content fingerprint. A
//      changed file can never be served from cache.
//   2. THE CACHE IS NOT AN AUTHORITY. It is an optimization. A caller may always
//      force a fresh read (`fresh: true`); the model retains the ability to
//      re-read when correctness requires it.
//   3. PROVENANCE IS EXPLICIT. Every result carries `CACHE_HIT` or `FRESH_READ`.
//      A cached result is NEVER presented as freshly measured.
//   4. BOUNDED. The store is keyed, content-addressed where a file hash is
//      available, and bounded by entry count and bytes.
//   5. NO SECRETS. Nothing here writes raw content to disk; results live in
//      memory only, and callers remain responsible for the existing secret
//      filtering on the way OUT (this module never adds an unfiltered path).
//
// It owns NO workspace truth (WorkspaceStateOwner), NO evidence bytes
// (evidence-store) and NO verification (verification-ladder). It is a pure,
// bounded memo of deterministic tool results.

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { putEvidence, getEvidence } from "./evidence-store.mjs"

export const TOOL_RESULT_REUSE_SCHEMA_VERSION = 1
export const TOOL_RESULT_REUSE_POLICY = "tool-result-reuse-v16-12"

export const TOOL_RESULT_PROVENANCE = Object.freeze({
  CACHE_HIT: "CACHE_HIT",
  FRESH_READ: "FRESH_READ",
})

const DEFAULTS = Object.freeze({
  maxEntries: 400,
  maxBytes: 32 * 1024 * 1024,
  ttlMs: 10 * 60_000,
  // Above this serialized size a result is NOT held in memory. It is handed to
  // the ONE evidence store and only a reference is memoized, so a large read or
  // search result is never duplicated as a second giant in-memory blob.
  spillBytes: 256 * 1024,
})

// In-memory only. A deterministic tool result is cheap to recompute after a
// restart; persisting raw source text would create a second giant evidence store
// and a staleness risk. Bounded LRU. Values ABOVE `spillBytes` are not kept in
// memory at all - they are handed to the evidence store and only a reference is
// memoized (so a large result is stored exactly once, by the evidence owner).
const STORE = new Map() // key -> { at, bytes, value, evidenceRef }
const INFLIGHT = new Map() // key -> Promise
const STATS = {
  lookups: 0,
  hits: 0,
  misses: 0,
  forced: 0,
  coalesced: 0,
  evictions: 0,
  invalidations: 0,
  spilled: 0,
  spillReads: 0,
}

function digest(value, chars = 40) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, chars)
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeRel(root, file) {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, String(file || ""))
  if (resolved === resolvedRoot) return "."
  if (resolved.startsWith(resolvedRoot + path.sep)) {
    return path.relative(resolvedRoot, resolved).split(path.sep).join("/")
  }
  return resolved.split(path.sep).join("/")
}

/** Stable digest of operation arguments (sorted keys, arrays order-preserved). */
export function argsDigest(args = {}) {
  const rows = []
  for (const key of Object.keys(args).sort()) {
    const value = args[key]
    if (typeof value === "function") continue
    if (value === undefined) continue
    if (Array.isArray(value)) rows.push(`${key}=[${value.map(String).join(",")}]`)
    else if (value && typeof value === "object") rows.push(`${key}={${argsDigest(value)}}`)
    else rows.push(`${key}=${String(value)}`)
  }
  return digest(rows.join("|"), 32)
}

/**
 * The reuse key. Every component that can change the result is included:
 * workspace content fingerprint, operation, normalized path, range, arguments,
 * and policy version.
 */
export function toolResultKey(input = {}) {
  const root = path.resolve(String(input.root || process.cwd()))
  return digest(JSON.stringify([
    TOOL_RESULT_REUSE_POLICY,
    TOOL_RESULT_REUSE_SCHEMA_VERSION,
    root,
    String(input.operation || "op"),
    String(input.workspaceFingerprint || "unknown"),
    input.file ? normalizeRel(root, input.file) : "",
    input.contentHash ? String(input.contentHash) : "",
    String(input.range || ""),
    argsDigest(input.args || {}),
  ]), 64)
}

/** Content hash of a file, or null when unreadable. */
export async function fileContentHash(root, file) {
  try {
    const full = path.resolve(path.resolve(root), String(file || ""))
    const bytes = await readFile(full)
    return createHash("sha256").update(bytes).digest("hex")
  } catch {
    return null
  }
}

async function fileSignature(root, file) {
  try {
    const full = path.resolve(path.resolve(root), String(file || ""))
    const info = await stat(full)
    return `${info.size}:${Math.trunc(info.mtimeMs)}`
  } catch {
    return null
  }
}

function memoryGet(key, ttlMs, now) {
  const row = STORE.get(key)
  if (!row) return null
  if (now - row.at > ttlMs) {
    STORE.delete(key)
    return null
  }
  STORE.delete(key)
  STORE.set(key, row) // LRU touch
  return row
}

function memorySet(key, value, now) {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
  STORE.set(key, { at: now, bytes, value })
  // Bound by count.
  while (STORE.size > DEFAULTS.maxEntries) {
    const oldest = STORE.keys().next().value
    if (oldest === undefined) break
    STORE.delete(oldest)
    STATS.evictions += 1
  }
  // Bound by bytes.
  let total = 0
  for (const row of STORE.values()) total += row.bytes
  while (total > DEFAULTS.maxBytes && STORE.size > 1) {
    const oldest = STORE.keys().next().value
    if (oldest === undefined) break
    total -= STORE.get(oldest)?.bytes || 0
    STORE.delete(oldest)
    STATS.evictions += 1
  }
}

/**
 * Store a computed value. Small values stay in the bounded in-memory LRU.
 * Large values are spilled to the evidence store and only a reference is kept,
 * so a giant result is never duplicated as a second in-memory blob.
 */
async function storeValue(root, key, value, now, options = {}) {
  const serialized = JSON.stringify(value)
  const bytes = Buffer.byteLength(serialized, "utf8")
  const spillBytes = boundedInt(options.spillBytes, DEFAULTS.spillBytes, 0, 64 * 1024 * 1024)
  const evidenceEnabled = options.evidenceStore !== false
  if (evidenceEnabled && spillBytes > 0 && bytes > spillBytes && typeof value !== "undefined") {
    try {
      const saved = await putEvidence(root, serialized, {
        kind: "tool-result-reuse",
        source: `tool-result-reuse:${String(options.operation || "op")}`,
        summary: "V16.12 deterministic tool result spilled to the evidence store",
        mediaType: "application/json",
        encoding: "utf8",
      })
      if (saved?.ref) {
        STORE.set(key, { at: now, bytes, value: null, evidenceRef: saved.ref, spilled: true })
        STATS.spilled += 1
        return
      }
    } catch {
      // Evidence preservation is best-effort; fall back to the in-memory LRU.
    }
  }
  memorySet(key, value, now)
}

/** Resolve a memoized row to its value, rehydrating a spilled result. */
async function resolveRow(root, row) {
  if (!row) return null
  if (row.spilled && row.evidenceRef) {
    const evidence = await getEvidence(root, row.evidenceRef, { maxBytes: 64 * 1024 * 1024 }).catch(() => null)
    if (!evidence?.content) return null
    try {
      STATS.spillReads += 1
      return JSON.parse(evidence.content)
    } catch {
      return null
    }
  }
  return row.value
}

/**
 * Wrap a deterministic read/search operation with bounded reuse.
 *
 * @param {string} root workspace root
 * @param {object} input
 * @param {string} input.operation        e.g. "read", "search", "repo-graph"
 * @param {string} [input.workspaceFingerprint] workspace content fingerprint
 * @param {string} [input.file]           file identity for reads
 * @param {boolean} [input.hashFile]      when true, add the file's CONTENT hash
 * @param {string} [input.range]          e.g. "10-40"
 * @param {object} [input.args]           deterministic operation args
 * @param {boolean} [input.fresh]         force a fresh compute (bypass cache)
 * @param {(input: object) => Promise<any>} compute
 * @param {object} [options] { ttlMs }
 * @returns {Promise<{ value: any, provenance: string, cacheHit: boolean, coalesced: boolean, key: string }>}
 */
export async function withResultReuse(root, input = {}, compute, options = {}) {
  root = path.resolve(root)
  const ttlMs = boundedInt(options.ttlMs ?? input.ttlMs, DEFAULTS.ttlMs, 0, 60 * 60_000)
  const now = Date.now()

  // Resolve the file content hash when the caller asked for content binding.
  let contentHash = input.contentHash ? String(input.contentHash) : ""
  if (!contentHash && input.file && input.hashFile !== false && (input.operation === "read" || input.hashFile === true)) {
    const [hash, signature] = await Promise.all([
      fileContentHash(root, input.file),
      fileSignature(root, input.file),
    ])
    contentHash = hash || (signature ? `sig:${signature}` : "")
    if (!contentHash) {
      // The file could not be hashed: never reuse, compute fresh.
      STATS.misses += 1
      const value = await compute(input)
      return { value, provenance: TOOL_RESULT_PROVENANCE.FRESH_READ, cacheHit: false, coalesced: false, key: toolResultKey({ ...input, root, contentHash: "" }) }
    }
  }

  const key = toolResultKey({ ...input, root, contentHash })
  const storeOptions = { ...options, operation: input.operation }

  if (input.fresh === true) {
    STATS.forced += 1
    const value = await compute(input)
    await storeValue(root, key, value, Date.now(), storeOptions)
    return { value, provenance: TOOL_RESULT_PROVENANCE.FRESH_READ, cacheHit: false, coalesced: false, key }
  }

  STATS.lookups += 1
  const cached = memoryGet(key, ttlMs, now)
  if (cached) {
    const value = await resolveRow(root, cached)
    if (value !== null) {
      STATS.hits += 1
      return { value, provenance: TOOL_RESULT_PROVENANCE.CACHE_HIT, cacheHit: true, coalesced: false, key }
    }
    // A spilled row that can no longer be resolved is a MISS, never a wrong answer.
    STORE.delete(key)
  }

  // Coalesce concurrent identical operations: compute once, share the result.
  if (INFLIGHT.has(key)) {
    STATS.coalesced += 1
    const value = await INFLIGHT.get(key)
    return { value, provenance: TOOL_RESULT_PROVENANCE.CACHE_HIT, cacheHit: true, coalesced: true, key }
  }

  STATS.misses += 1
  const pending = (async () => {
    const value = await compute(input)
    await storeValue(root, key, value, Date.now(), storeOptions)
    return value
  })()
  INFLIGHT.set(key, pending)
  try {
    const value = await pending
    return { value, provenance: TOOL_RESULT_PROVENANCE.FRESH_READ, cacheHit: false, coalesced: false, key }
  } finally {
    INFLIGHT.delete(key)
  }
}

/**
 * Explicitly invalidate a key. Used when a caller KNOWS a file changed (e.g.
 * immediately after an edit) so the next read is guaranteed fresh even before a
 * new content hash is computed.
 */
export function invalidateResult(key) {
  const existed = STORE.delete(key)
  if (existed) STATS.invalidations += 1
  return existed
}

/** Invalidate every cached entry for a file (all ranges/args). */
export function invalidateFile(root, file) {
  const resolvedRoot = path.resolve(root)
  const rel = normalizeRel(resolvedRoot, file)
  let removed = 0
  for (const key of [...STORE.keys()]) {
    const row = STORE.get(key)
    if (row?.value?.__uesFile === rel) {
      STORE.delete(key)
      removed += 1
    }
  }
  if (removed) STATS.invalidations += removed
  return removed
}

export function toolResultReuseStats() {
  return { ...STATS, entries: STORE.size, policy: TOOL_RESULT_REUSE_POLICY }
}

export function clearToolResultReuse() {
  STORE.clear()
  INFLIGHT.clear()
  for (const key of Object.keys(STATS)) STATS[key] = 0
}

export const toolResultReuseExports = Object.freeze({
  toolResultKey,
  argsDigest,
  fileContentHash,
  withResultReuse,
  invalidateResult,
  invalidateFile,
  toolResultReuseStats,
  clearToolResultReuse,
  TOOL_RESULT_PROVENANCE,
})
