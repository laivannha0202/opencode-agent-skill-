// V16.12 Workspace-Scoped Verification Receipt Cache.
//
// WHY THIS MODULE EXISTS
//
// Large tasks are slow partly because the SAME expensive deterministic gate is
// run over and over against a workspace that has not changed. `npm test` at
// state H1 passes; nothing relevant changes; the next phase runs `npm test`
// again "just in case". That is pure wasted wall time, and it is the single
// biggest avoidable cost in a long implementation run.
//
// The V16.9 `verification-broker` already reuses a receipt keyed on
// (command, args) + an unchanged workspace fingerprint. That is correct but
// NARROW: it has no gate identity, no policy version, no runtime/Node identity,
// no explicit exclusion of aborted/partial/timeout runs, and no provenance
// distinction between a MEASURED run and a REUSED receipt. V16.12 needs all of
// those because a PASS may only be reused when EVERY dimension that can change
// the truth of that PASS is identical.
//
// This module is the SINGLE V16.12 owner of that question:
//
//   "Given this exact workspace + gate + command + cwd + policy + runtime, is
//    there a receipt that PROVES this gate already passed, and is it still valid
//    right now?"
//
// LAWS (non-negotiable)
//
//   1. A receipt is reusable ONLY when it recorded a genuine, completed PASS:
//      `outcome === "passed"`, `exitCode === 0`, `completed === true`, and none
//      of aborted / timedOut / partial. FAIL, UNVERIFIED, partial, aborted and
//      timed-out runs are NEVER promoted to a reusable PASS.
//   2. The key includes the workspace CONTENT fingerprint from the single
//      WorkspaceStateOwner, so any tracked source/config/dependency/test change
//      invalidates reuse by construction - not by TTL luck.
//   3. The key ALSO includes gate name, command, args, cwd, an environment
//      policy digest, the Node/runtime identity, and the verification policy
//      version, so a command/policy/runtime change invalidates reuse even when
//      the tree is byte-identical.
//   4. When validity cannot be PROVEN, the answer is MISS. Correctness beats
//      cache hit rate.
//   5. Provenance is never blurred: a stored entry is `MEASURED`, a served
//      entry is `REUSED`. The two are separate fields.
//   6. This is a DEVELOPMENT-workflow optimization. It NEVER substitutes for the
//      final release gate: `npm test` and `release:verify` must still execute
//      freshly on the final candidate. `finalReleaseMode()` disables all reuse.
//
// It owns NO workspace truth (WorkspaceStateOwner does), NO evidence bytes
// (evidence-store does) and NO verification escalation (verification-ladder
// does). It only decides reuse of an already-measured gate result.

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { captureOwnedWorkspaceState } from "./workspace-state-owner.mjs"
import { putEvidence, getEvidence } from "./evidence-store.mjs"

export const RECEIPT_CACHE_SCHEMA_VERSION = 1
export const RECEIPT_CACHE_POLICY = "verification-receipt-cache-v16-12"
export const RECEIPT_CACHE_DIR = path.join(".ues-cache", "verification-receipts-v16-12")

// The receipt outcome vocabulary. Only `passed` is reusable.
export const RECEIPT_OUTCOME = Object.freeze({
  PASSED: "passed",
  FAILED: "failed",
  UNVERIFIED: "unverified",
  PARTIAL: "partial",
  ABORTED: "aborted",
  TIMED_OUT: "timed-out",
})

export const RECEIPT_PROVENANCE = Object.freeze({
  MEASURED: "MEASURED",
  REUSED: "REUSED",
})

const DEFAULTS = Object.freeze({
  maxEntries: 200,
  maxBytes: 16 * 1024 * 1024,
  ttlMs: 30 * 60_000,
})

// In-memory L1 hot cache (key -> { entry, at }) so a hot reuse is served
// WITHOUT a disk read. It holds the parsed ENTRY, not just a path; it is bounded
// by count and cleared by purge/reset. It is an optimization only: every hit is
// still re-validated (fingerprint + receiptProvesPass + freshness) exactly as a
// disk hit would be, so it can never serve a stale or non-passing receipt.
const MEMORY = new Map()
const MEMORY_MAX_ENTRIES = 400
// V16.14 BOUNDED MAINTENANCE: a cheap per-root write counter so the automatic
// enforceBounds does not have to walk the whole cache directory after every
// single write. It only ever SKIPS a scan when the cache is obviously far under
// its limits; it never authorizes eviction on its own.
const WRITE_HINTS = new Map() // root -> approximate live entry count
const STATS = {
  lookups: 0,
  hits: 0,
  memoryHits: 0,
  misses: 0,
  invalidations: 0,
  writes: 0,
  writeFailures: 0,
  corrupt: 0,
  evictions: 0,
  finalModeRefusals: 0,
  boundsSkipped: 0,
}

function digest(value, chars = 40) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, chars)
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeCwd(root, cwd) {
  const resolvedRoot = path.resolve(root)
  if (!cwd) return "."
  const resolved = path.resolve(String(cwd))
  if (resolved === resolvedRoot) return "."
  if (resolved.startsWith(resolvedRoot + path.sep)) {
    return path.relative(resolvedRoot, resolved).split(path.sep).join("/")
  }
  // A cwd outside the workspace root is identity-bearing and never merged.
  return resolved.split(path.sep).join("/")
}

function runtimeIdentity() {
  return [String(process.version || ""), String(process.platform || ""), String(process.arch || "")].join("|")
}

function cacheRoot(root) {
  return path.join(path.resolve(root), RECEIPT_CACHE_DIR)
}

function entryPath(root, key) {
  const hash = digest(key, 48)
  return path.join(cacheRoot(root), hash.slice(0, 2), hash + ".json")
}

/**
 * The receipt-cache key. PURE and total: every input that can change the truth
 * of a PASS is a component. Two different workspaces, cwds, gates, policies,
 * runtimes or content fingerprints can never collide.
 *
 * @param {object} input
 * @param {string} input.root                workspace root
 * @param {string} input.workspaceFingerprint content fingerprint (WorkspaceStateOwner)
 * @param {string} input.gateName            stable gate identity (e.g. "test", "syntax")
 * @param {string} input.command             executable
 * @param {string[]} [input.args]            arguments
 * @param {string} [input.cwd]               working directory (root-relative or absolute)
 * @param {string} [input.environmentPolicyDigest] stable digest of relevant env policy
 * @param {string} [input.verificationPolicyVersion] verification policy version
 * @param {string} [input.testInventoryVersion] test inventory version
 * @param {string} [input.dependencyStateDigest] explicit dependency-state digest
 * @param {string} [input.configDigest] explicit config digest
 */
export function receiptCacheKey(input = {}) {
  const root = path.resolve(String(input.root || process.cwd()))
  return digest(JSON.stringify([
    RECEIPT_CACHE_POLICY,
    RECEIPT_CACHE_SCHEMA_VERSION,
    root,
    String(input.workspaceFingerprint || "unknown"),
    String(input.gateName || "gate"),
    String(input.command || ""),
    (Array.isArray(input.args) ? input.args : []).map(String),
    normalizeCwd(root, input.cwd),
    String(input.environmentPolicyDigest || ""),
    runtimeIdentity(),
    String(input.verificationPolicyVersion || ""),
    String(input.testInventoryVersion || ""),
    String(input.dependencyStateDigest || ""),
    String(input.configDigest || ""),
  ]), 64)
}

/**
 * A stored receipt is reusable as a PASS only when it PROVES a completed pass.
 * This is the one predicate the whole feature rests on.
 */
export function receiptProvesPass(receipt) {
  if (!receipt || typeof receipt !== "object") return false
  if (receipt.schemaVersion !== RECEIPT_CACHE_SCHEMA_VERSION) return false
  if (String(receipt.outcome || "") !== RECEIPT_OUTCOME.PASSED) return false
  if (Number(receipt.exitCode) !== 0) return false
  if (receipt.completed !== true) return false
  if (receipt.aborted === true) return false
  if (receipt.timedOut === true) return false
  if (receipt.partial === true) return false
  if (!String(receipt.gateName || "").trim()) return false
  if (!String(receipt.command || "").trim()) return false
  if (!Number.isFinite(Date.parse(receipt.finishedAt || ""))) return false
  return true
}

/** Reuse is disabled entirely in final-release mode. */
export function finalReleaseMode(options = {}) {
  return options.finalRelease === true || String(options.mode || "") === "final-release"
}

function freshEnough(entry, ttlMs, now = Date.now()) {
  const finished = Date.parse(entry?.receipt?.finishedAt || "")
  if (!Number.isFinite(finished)) return false
  if (finished > now + 60_000) return false
  if (!ttlMs) return true
  return now - finished <= ttlMs
}

// Windows-specific transient rename failures. A rename over an existing target
// can fail with EBUSY / EPERM / EACCES while another handle is still closing,
// and EEXIST under some filesystems. These are RETRIED; anything else fails fast.
export const ATOMIC_RETRY_CODES = Object.freeze(["EBUSY", "EPERM", "EACCES", "EEXIST"])

export async function atomicWriteJson(file, value, options = {}) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + Date.now() + "." + Math.random().toString(36).slice(2, 8) + ".tmp"
  // Injectable for tests (deterministic EBUSY/EPERM simulation) and for a
  // caller that needs its own atomic-rename primitive. Production defaults to
  // node:fs/promises.
  const writeImpl = typeof options.writeFileImpl === "function" ? options.writeFileImpl : writeFile
  const renameImpl = typeof options.renameImpl === "function" ? options.renameImpl : rename
  const retries = Number.isInteger(options.renameRetries) ? Math.max(1, options.renameRetries) : 5
  await writeImpl(temp, JSON.stringify(value, null, 2) + "\n", "utf8")
  // Windows: rename over an existing target can transiently fail with EBUSY /
  // EPERM / EACCES. Retry a bounded number of times, then surface as a write
  // failure (never a wrong answer).
  let lastError = null
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await renameImpl(temp, file)
      return
    } catch (error) {
      lastError = error
      if (!ATOMIC_RETRY_CODES.includes(error?.code)) break
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  await rm(temp, { force: true }).catch(() => {})
  throw lastError || new Error("atomic rename failed")
}

async function readEntry(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    if (parsed?.schemaVersion !== RECEIPT_CACHE_SCHEMA_VERSION) {
      STATS.corrupt += 1
      return null
    }
    return parsed
  } catch (error) {
    if (error?.code !== "ENOENT") STATS.corrupt += 1
    return null
  }
}

/**
 * Look up a reusable PASS receipt. Returns `null` on any miss, mismatch, expiry,
 * corruption, final-release mode, or unprovable validity. Never throws.
 */
export async function findReusableReceipt(root, input = {}, options = {}) {
  root = path.resolve(root)
  STATS.lookups += 1
  if (finalReleaseMode(options)) {
    STATS.finalModeRefusals += 1
    return null
  }

  const fingerprint = String(
    input.workspaceFingerprint ||
    captureOwnedWorkspaceState(root).fingerprint ||
    "unknown",
  )
  const key = receiptCacheKey({ ...input, root, workspaceFingerprint: fingerprint })
  const file = entryPath(root, key)
  // L1 hot path: a recently written/served entry is served from memory without a
  // disk read. The SAME validation below still runs, so this is never less safe
  // than a disk read - it only avoids the I/O.
  let entry = null
  const cached = MEMORY.get(key)
  if (cached && Date.now() - cached.at <= boundedInt(options.ttlMs ?? cached.entry?.ttlMs, DEFAULTS.ttlMs, 0, 24 * 60 * 60_000)) {
    entry = cached.entry
  } else {
    entry = await readEntry(file)
  }
  if (!entry) {
    STATS.misses += 1
    return null
  }
  if (entry.key !== key) {
    STATS.corrupt += 1
    STATS.misses += 1
    return null
  }
  if (String(entry.workspaceFingerprint || "") !== fingerprint) {
    // The workspace changed since this entry was written. Invalidate, never reuse.
    STATS.invalidations += 1
    STATS.misses += 1
    await rm(file, { force: true }).catch(() => {})
    MEMORY.delete(key)
    return null
  }
  if (!receiptProvesPass(entry.receipt)) {
    STATS.misses += 1
    return null
  }
  if (!freshEnough(entry, boundedInt(options.ttlMs ?? entry.ttlMs, DEFAULTS.ttlMs, 0, 24 * 60 * 60_000))) {
    STATS.misses += 1
    return null
  }

  // Serve from L1 when we had a valid in-memory entry (no disk read this call).
  if (cached && entry === cached.entry) {
    STATS.memoryHits += 1
    MEMORY.delete(key)
    MEMORY.set(key, { entry, at: Date.now() }) // LRU touch
  }
  STATS.hits += 1
  return {
    schemaVersion: RECEIPT_CACHE_SCHEMA_VERSION,
    policy: RECEIPT_CACHE_POLICY,
    reusable: true,
    provenance: RECEIPT_PROVENANCE.REUSED,
    key,
    receipt: entry.receipt,
    gateName: entry.receipt.gateName,
    workspaceFingerprint: fingerprint,
    stdoutRef: entry.stdoutRef || null,
    stderrRef: entry.stderrRef || null,
    ageMs: Math.max(0, Date.now() - Date.parse(entry.receipt.finishedAt)),
  }
}

/**
 * Record a MEASURED gate result. A non-passing result is stored ONLY as an
 * invalidation marker (so a later lookup never confuses it with a PASS); it is
 * never returned as reusable.
 *
 * @param {string} root
 * @param {object} input { gateName, command, args, cwd, exitCode, stdout, stderr,
 *   startedAt, finishedAt, durationMs, workspaceFingerprint, outcome,
 *   completed, aborted, timedOut, partial, environmentPolicyDigest,
 *   verificationPolicyVersion, testInventoryVersion, dependencyStateDigest,
 *   configDigest, ttlMs }
 */
export async function recordReceipt(root, input = {}, options = {}) {
  root = path.resolve(root)
  const outcome = String(input.outcome || (Number(input.exitCode) === 0 ? RECEIPT_OUTCOME.PASSED : RECEIPT_OUTCOME.FAILED))
  const fingerprint = String(
    input.workspaceFingerprint ||
    captureOwnedWorkspaceState(root).fingerprint ||
    "unknown",
  )
  const key = receiptCacheKey({ ...input, root, workspaceFingerprint: fingerprint })
  const now = new Date().toISOString()
  const receipt = {
    schemaVersion: RECEIPT_CACHE_SCHEMA_VERSION,
    gateName: String(input.gateName || "gate"),
    command: String(input.command || ""),
    args: (Array.isArray(input.args) ? input.args : []).map(String),
    cwd: normalizeCwd(root, input.cwd),
    outcome,
    exitCode: Number.isInteger(Number(input.exitCode)) ? Number(input.exitCode) : null,
    completed: input.completed !== false && outcome !== RECEIPT_OUTCOME.ABORTED,
    aborted: input.aborted === true || outcome === RECEIPT_OUTCOME.ABORTED,
    timedOut: input.timedOut === true || outcome === RECEIPT_OUTCOME.TIMED_OUT,
    partial: input.partial === true || outcome === RECEIPT_OUTCOME.PARTIAL,
    startedAt: String(input.startedAt || now),
    finishedAt: String(input.finishedAt || now),
    durationMs: Math.max(0, Number(input.durationMs) || 0),
    workspaceFingerprint: fingerprint,
    environmentPolicyDigest: String(input.environmentPolicyDigest || ""),
    verificationPolicyVersion: String(input.verificationPolicyVersion || ""),
    testInventoryVersion: String(input.testInventoryVersion || ""),
    dependencyStateDigest: String(input.dependencyStateDigest || ""),
    configDigest: String(input.configDigest || ""),
    provenance: RECEIPT_PROVENANCE.MEASURED,
  }

  const entry = {
    schemaVersion: RECEIPT_CACHE_SCHEMA_VERSION,
    policy: RECEIPT_CACHE_POLICY,
    key,
    workspaceFingerprint: fingerprint,
    ttlMs: boundedInt(input.ttlMs, DEFAULTS.ttlMs, 0, 24 * 60 * 60_000),
    receipt,
    stdoutRef: null,
    stderrRef: null,
  }

  // Preserve stdout/stderr through the ONE evidence store (never a second
  // giant blob store). Bounded: only kept when there is content.
  try {
    if (typeof input.stdout === "string" && input.stdout.length) {
      const saved = await putEvidence(root, input.stdout, {
        kind: "verification-receipt-stdout",
        source: `receipt:${receipt.gateName}`,
        summary: "Captured stdout for a V16.12 verification receipt",
      })
      entry.stdoutRef = saved?.ref || null
    }
    if (typeof input.stderr === "string" && input.stderr.length) {
      const saved = await putEvidence(root, input.stderr, {
        kind: "verification-receipt-stderr",
        source: `receipt:${receipt.gateName}`,
        summary: "Captured stderr for a V16.12 verification receipt",
      })
      entry.stderrRef = saved?.ref || null
    }
  } catch {
    // Evidence preservation is best-effort; the receipt itself is still valid.
  }

  try {
    await atomicWriteJson(entryPath(root, key), entry, options)
    STATS.writes += 1
    // L1 holds the parsed entry (bounded LRU), so the very next reuse is served
    // from memory without a disk read.
    MEMORY.delete(key)
    MEMORY.set(key, { entry, at: Date.now() })
    while (MEMORY.size > MEMORY_MAX_ENTRIES) {
      const oldest = MEMORY.keys().next().value
      if (oldest === undefined) break
      MEMORY.delete(oldest)
    }
    WRITE_HINTS.set(root, (WRITE_HINTS.get(root) || 0) + 1)
  } catch {
    // A failed write is a bounded degradation: the gate simply is not cached.
    // It is NEVER a wrong answer and NEVER a fabricated reuse.
    STATS.writeFailures += 1
  }

  // Bounded maintenance: skip the full-directory walk while the cache is
  // obviously far under its default entry limit. A caller can force a scan by
  // passing explicit bounds, and the explicit `enforceBounds` export always runs.
  const explicitBounds = options.maxEntries != null || options.maxBytes != null
  const approx = WRITE_HINTS.get(root) || 0
  if (explicitBounds || approx >= Math.floor(DEFAULTS.maxEntries * 0.75)) {
    await enforceBounds(root, options).catch(() => null)
    WRITE_HINTS.set(root, 0)
  } else {
    STATS.boundsSkipped += 1
  }
  return { ...entry, reusable: receiptProvesPass(receipt) }
}

/** Read the preserved stdout/stderr for a reused receipt (bounded). */
export async function readReceiptOutput(root, ref, options = {}) {
  if (!ref) return ""
  try {
    const evidence = await getEvidence(root, ref, { maxBytes: boundedInt(options.maxBytes, 16_000, 1, 128_000) })
    return evidence?.content || ""
  } catch {
    return ""
  }
}

async function listEntryFiles(root) {
  const dir = cacheRoot(root)
  if (!existsSync(dir)) return []
  const files = []
  async function walk(current, depth) {
    if (depth > 3) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full)
    }
  }
  await walk(dir, 0)
  return files
}

/**
 * Bound the store by entry count AND total bytes. Evicts oldest-finished first.
 * Corrupt/expired entries are removed. Never unbounded.
 */
export async function enforceBounds(root, options = {}) {
  const maxEntries = boundedInt(options.maxEntries, DEFAULTS.maxEntries, 1, 5000)
  const maxBytes = boundedInt(options.maxBytes, DEFAULTS.maxBytes, 64 * 1024, 256 * 1024 * 1024)
  const files = await listEntryFiles(root)
  if (!files.length) return { removed: 0, retained: 0 }

  const rows = []
  for (const file of files) {
    const info = await stat(file).catch(() => null)
    const entry = await readEntry(file)
    rows.push({
      file,
      bytes: info?.size || 0,
      finished: Date.parse(entry?.receipt?.finishedAt || "") || 0,
      valid: Boolean(entry),
    })
  }

  let removed = 0
  // 1. Remove corrupt entries outright.
  for (const row of rows.filter((r) => !r.valid)) {
    await rm(row.file, { force: true }).catch(() => {})
    removed += 1
  }
  let live = rows.filter((r) => r.valid)
  live.sort((a, b) => b.finished - a.finished) // newest first

  // 2. Evict by count.
  const overCount = live.slice(maxEntries)
  for (const row of overCount) {
    await rm(row.file, { force: true }).catch(() => {})
    STATS.evictions += 1
    removed += 1
  }
  live = live.slice(0, maxEntries)

  // 3. Evict by bytes.
  let totalBytes = live.reduce((sum, row) => sum + row.bytes, 0)
  while (totalBytes > maxBytes && live.length > 1) {
    const row = live.pop()
    await rm(row.file, { force: true }).catch(() => {})
    STATS.evictions += 1
    removed += 1
    totalBytes -= row.bytes
  }
  return { removed, retained: live.length }
}

/** Remove every entry for this workspace. */
export async function purgeReceiptCache(root) {
  const dir = cacheRoot(root)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  MEMORY.clear()
  WRITE_HINTS.delete(path.resolve(root))
  return { purged: true }
}

export function receiptCacheStats() {
  return { ...STATS, memoryEntries: MEMORY.size, policy: RECEIPT_CACHE_POLICY }
}

export function resetReceiptCacheStats() {
  for (const key of Object.keys(STATS)) STATS[key] = 0
  MEMORY.clear()
  WRITE_HINTS.clear()
}

export const verificationReceiptCacheExports = Object.freeze({
  receiptCacheKey,
  receiptProvesPass,
  finalReleaseMode,
  atomicWriteJson,
  ATOMIC_RETRY_CODES,
  findReusableReceipt,
  recordReceipt,
  readReceiptOutput,
  enforceBounds,
  purgeReceiptCache,
  receiptCacheStats,
  resetReceiptCacheStats,
  RECEIPT_OUTCOME,
  RECEIPT_PROVENANCE,
})
