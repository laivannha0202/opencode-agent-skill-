// V16.10 Repo Intelligence Cache.
//
// WHY THIS MODULE EXISTS
//
// The runtime already caches repo analysis in memory: `buildRepoGraphCached`
// (LRU-8), `buildSemanticIndexCached` (LRU-6, plus an on-disk artifact),
// `resolveAffectedTests` (LRU-24). Each is correct on its own, but they cache
// DIFFERENT things under DIFFERENT keys, none of them share a single keying
// law, and none of them can answer the only question that matters for a
// persistent cache: "is this artifact still true for the CURRENT workspace
// fingerprint?".
//
// This module is the SINGLE owner of a persistent, fingerprint-scoped artifact
// cache for repo intelligence. Its contract is deliberately narrow:
//
//   * An entry is keyed by (root, workspaceFingerprint, kind, optionsDigest).
//     A workspace whose fingerprint changed can NEVER read another
//     fingerprint's entry. Stale data is impossible by construction, not by
//     TTL luck.
//   * Entries are written atomically (temp file + rename) so a crash mid-write
//     can never leave a half-written JSON that a later read trusts.
//   * Reads are validated by schema version; an unknown/older entry is ignored,
//     not guessed at.
//   * The store is bounded by BOTH entry count and a max byte size, and evicts
//     least-recently-used first.
//   * In-flight computation is coalesced per key, so two concurrent callers of
//     the same artifact do the work once.
//
// It is a CACHE, not an owner of analysis: it never computes repo facts itself.
// Callers pass a `compute()` and this module decides whether to run it.
//
// Windows notes: writes go through a same-directory temp file so the rename is
// on one volume; `fs.rename` replaces an existing target on Windows; a locked
// target is retried a bounded number of times and then surfaces as a cache miss
// (never as a wrong answer).

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { measured } from "./measurement-provenance.mjs"

export const REPO_INTEL_CACHE_SCHEMA_VERSION = 1
export const REPO_INTEL_CACHE_POLICY = "repo-intelligence-cache-v16-10"
export const REPO_INTEL_CACHE_DIR = path.join(".ues-cache", "repo-intel-v16-10")

const DEFAULTS = Object.freeze({
  maxEntries: 64,
  maxBytes: 8 * 1024 * 1024,
  ttlMs: 30 * 60_000,
})

// In-memory L1. The disk store is L2. Both are bounded.
const MEMORY = new Map() // key -> { at, value, bytes }
const INFLIGHT = new Map() // key -> Promise
const STATS = { hits: 0, misses: 0, coalesced: 0, evictions: 0, writes: 0, writeFailures: 0, readFailures: 0, staleDrops: 0 }

function digest(value, chars = 32) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, chars)
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function cacheRoot(root) {
  return path.join(path.resolve(root), REPO_INTEL_CACHE_DIR)
}

function entryPath(root, key) {
  const hash = digest(key, 40)
  return path.join(cacheRoot(root), hash.slice(0, 2), hash + ".json")
}

/**
 * The cache key. Every component that can change the artifact's truth is in it.
 * `optionsDigest` must be supplied by the caller as a stable digest of the
 * options that affect the computation (not a JSON.stringify of an object with
 * unstable key order - the caller owns that normalization).
 */
export function repoIntelCacheKey(input = {}) {
  const root = path.resolve(String(input.root || process.cwd()))
  const fingerprint = String(input.workspaceFingerprint || "unknown")
  const kind = String(input.kind || "artifact")
  const optionsDigest = String(input.optionsDigest || "")
  return [REPO_INTEL_CACHE_POLICY, root, fingerprint, kind, optionsDigest].join("\u0000")
}

/** Normalize an options object into a stable digest (sorted keys, bounded). */
export function stableOptionsDigest(options = {}) {
  const rows = []
  for (const key of Object.keys(options).sort()) {
    const value = options[key]
    if (typeof value === "function") continue
    if (value === undefined) continue
    if (Array.isArray(value)) rows.push(`${key}=${[...value].map(String).sort().join(",")}`)
    else if (value && typeof value === "object") rows.push(`${key}=${stableOptionsDigest(value)}`)
    else rows.push(`${key}=${String(value)}`)
  }
  return digest(rows.join("|"), 24)
}

function memoryGet(key, now, ttlMs) {
  const row = MEMORY.get(key)
  if (!row) return null
  if (now - row.at > ttlMs) {
    MEMORY.delete(key)
    STATS.staleDrops += 1
    return null
  }
  // LRU touch.
  MEMORY.delete(key)
  MEMORY.set(key, row)
  return row
}

function memorySet(key, value, now, limits) {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
  MEMORY.set(key, { at: now, value, bytes })
  let total = 0
  for (const row of MEMORY.values()) total += row.bytes
  while (MEMORY.size > limits.maxEntries || total > limits.maxBytes) {
    const oldest = MEMORY.keys().next().value
    if (oldest == null) break
    const evicted = MEMORY.get(oldest)
    total -= evicted?.bytes || 0
    MEMORY.delete(oldest)
    STATS.evictions += 1
  }
}

async function readDiskEntry(root, key, options) {
  const file = entryPath(root, key)
  if (!existsSync(file)) return null
  try {
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw)
    if (Number(parsed?.schemaVersion) !== REPO_INTEL_CACHE_SCHEMA_VERSION) {
      STATS.staleDrops += 1
      return null
    }
    // Belt and braces: a disk entry must still match the key it was stored under,
    // so a renamed/copied cache directory can never serve the wrong artifact.
    if (String(parsed.key) !== String(key)) {
      STATS.staleDrops += 1
      return null
    }
    if (options.ttlMs && Date.now() - Number(parsed.at || 0) > options.ttlMs) {
      STATS.staleDrops += 1
      return null
    }
    return parsed.value ?? null
  } catch {
    STATS.readFailures += 1
    return null
  }
}

async function writeDiskEntry(root, key, value, options) {
  const file = entryPath(root, key)
  const dir = path.dirname(file)
  const payload = JSON.stringify({ schemaVersion: REPO_INTEL_CACHE_SCHEMA_VERSION, key, at: Date.now(), value }, null, 0)
  if (Buffer.byteLength(payload, "utf8") > options.maxBytes) return false
  await mkdir(dir, { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, payload, "utf8")
  } catch {
    STATS.writeFailures += 1
    return false
  }
  // Retry the rename: on Windows a concurrent reader can briefly hold the file.
  let attempt = 0
  for (;;) {
    try {
      await rename(temp, file)
      STATS.writes += 1
      break
    } catch (error) {
      attempt += 1
      if (attempt >= 3) {
        STATS.writeFailures += 1
        await rm(temp, { force: true }).catch(() => {})
        return false
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * attempt))
    }
  }
  await pruneDisk(root, options).catch(() => null)
  return true
}

async function pruneDisk(root, options) {
  const base = cacheRoot(root)
  if (!existsSync(base)) return
  const shards = await readdir(base, { withFileTypes: true }).catch(() => [])
  const rows = []
  let totalBytes = 0
  for (const shard of shards) {
    if (!shard.isDirectory()) continue
    const shardDir = path.join(base, shard.name)
    const files = await readdir(shardDir, { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue
      const full = path.join(shardDir, file.name)
      const info = await stat(full).catch(() => null)
      if (!info) continue
      rows.push({ full, at: info.mtimeMs, bytes: info.size })
      totalBytes += info.size
    }
  }
  if (rows.length <= options.maxEntries && totalBytes <= options.maxBytes) return
  rows.sort((a, b) => a.at - b.at)
  let count = rows.length
  for (const row of rows) {
    if (count <= options.maxEntries && totalBytes <= options.maxBytes) break
    await rm(row.full, { force: true }).catch(() => {})
    totalBytes -= row.bytes
    count -= 1
    STATS.evictions += 1
  }
}

/**
 * The one entry point. Returns `{ value, cacheHit, source, coalesced, durationMs }`.
 *
 * - `source: "memory" | "disk" | "computed"`.
 * - On any cache read failure it falls through to `compute()`; a broken cache
 *   degrades to "slow", never to "wrong".
 * - `compute()` is coalesced per key.
 */
export async function getOrComputeRepoIntel(root, input = {}, compute, options = {}) {
  if (typeof compute !== "function") throw new Error("getOrComputeRepoIntel requires a compute function")
  const limits = {
    maxEntries: boundedInt(options.maxEntries, DEFAULTS.maxEntries, 1, 4096),
    maxBytes: boundedInt(options.maxBytes, DEFAULTS.maxBytes, 64 * 1024, 256 * 1024 * 1024),
    ttlMs: boundedInt(options.ttlMs, DEFAULTS.ttlMs, 1000, 24 * 60 * 60_000),
  }
  const key = repoIntelCacheKey(input)
  const now = Date.now()

  if (options.enabled !== false) {
    const memory = memoryGet(key, now, limits.ttlMs)
    if (memory) {
      STATS.hits += 1
      return { value: memory.value, cacheHit: true, source: "memory", coalesced: false, durationMs: 0 }
    }
    const disk = await readDiskEntry(path.resolve(String(input.root || process.cwd())), key, limits)
    if (disk !== null && disk !== undefined) {
      STATS.hits += 1
      memorySet(key, disk, now, limits)
      return { value: disk, cacheHit: true, source: "disk", coalesced: false, durationMs: 0 }
    }
  }

  if (INFLIGHT.has(key)) {
    STATS.coalesced += 1
    const value = await INFLIGHT.get(key)
    return { value, cacheHit: true, source: "inflight", coalesced: true, durationMs: 0 }
  }

  STATS.misses += 1
  const startedAt = Date.now()
  const pending = (async () => {
    const value = await compute()
    return value
  })()
  INFLIGHT.set(key, pending)
  try {
    const value = await pending
    memorySet(key, value, Date.now(), limits)
    if (options.persist !== false) {
      await writeDiskEntry(path.resolve(String(input.root || process.cwd())), key, value, limits).catch(() => null)
    }
    return { value, cacheHit: false, source: "computed", coalesced: false, durationMs: Date.now() - startedAt }
  } finally {
    INFLIGHT.delete(key)
  }
}

export function repoIntelCacheStats() {
  return {
    schemaVersion: REPO_INTEL_CACHE_SCHEMA_VERSION,
    policy: REPO_INTEL_CACHE_POLICY,
    ...STATS,
    memoryEntries: MEMORY.size,
    inflight: INFLIGHT.size,
    provenance: measured(STATS.hits + STATS.misses),
  }
}

export function clearRepoIntelCache(root) {
  if (root == null) MEMORY.clear()
  else {
    for (const key of [...MEMORY.keys()]) {
      if (key.includes(path.resolve(String(root)))) MEMORY.delete(key)
    }
  }
  INFLIGHT.clear()
}

/** Remove the persistent store. Used by tests and by explicit cache resets. */
export async function purgeRepoIntelCache(root) {
  const base = cacheRoot(root)
  await rm(base, { recursive: true, force: true }).catch(() => {})
  clearRepoIntelCache(root)
}

export const repoIntelligenceCacheExports = Object.freeze({
  getOrComputeRepoIntel,
  repoIntelCacheKey,
  stableOptionsDigest,
  repoIntelCacheStats,
  clearRepoIntelCache,
  purgeRepoIntelCache,
})
