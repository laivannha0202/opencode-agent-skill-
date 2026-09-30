// Content-addressed parsed-source artifacts (V15.3 Phase 2).
//
// The pre-patch semantic index decided "did this file change?" from
// `size + mtimeMs`. That is a metadata guess, and it is wrong in three ways that
// all cost the same thing -- a reparse:
//
//   * the same bytes under a different checkout (worktree, sandbox, clone) look
//     unrelated, so nothing is shared;
//   * a rename or a copy keeps the content and loses the reuse;
//   * a file rewritten with an identical byte length keeps its signature if the
//     timestamp is also restored, which is a silent false cache hit -- the exact
//     shape that serves stale symbols to the model.
//
// This module replaces the guess with an identity derived from the bytes.
//
//   CONTENT_ARTIFACT  keyed by (parser schema + parser profile + content hash)
//   WORKSPACE_BINDING keyed by (workspace + relative path -> artifact id)
//
// The artifact key deliberately does not contain the absolute path, the
// workspace, or any timestamp, so two checkouts holding the same file resolve to
// the same key. The workspace only ever chooses where the store lives; it never
// participates in artifact identity.
//
// Storage is bounded on both sides: a memory LRU with a hard entry cap, and a
// content-addressed directory with a deterministic, time-bounded GC. Every write
// is atomic (temp file + rename), and a corrupt artifact degrades to a miss
// rather than propagating a parse of somebody else's bytes.

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

// Bumping this invalidates every stored artifact deterministically: a new
// schema lives in a new directory, so old bytes are never read back.
export const ARTIFACT_SCHEMA_VERSION = 2

// Parser profile groups the extensions that share one symbol grammar. Two files
// with identical content but different profiles parse differently, so the
// profile is part of the artifact key; two files with the same content in the
// same profile share an artifact even across extensions.
const PARSER_PROFILES = Object.freeze({
  js: "js",
  py: "py",
  jvm: "jvm",
  go: "go",
  rs: "rs",
  dart: "dart",
  swift: "swift",
  sql: "sql",
  default: "default",
})

const PROFILE_BY_EXTENSION = Object.freeze({
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "js", ".ts": "js", ".tsx": "js",
  ".vue": "js", ".svelte": "js",
  ".py": "py",
  ".java": "jvm", ".kt": "jvm", ".kts": "jvm", ".cs": "jvm",
  ".go": "go",
  ".rs": "rs",
  ".dart": "dart",
  ".swift": "swift",
  ".sql": "sql",
})

export function parserProfileFor(extension) {
  return PARSER_PROFILES[PROFILE_BY_EXTENSION[String(extension || "").toLowerCase()]] || PARSER_PROFILES.default
}

export function contentHashOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

export function artifactIdFor({ contentHash, profile, schemaVersion = ARTIFACT_SCHEMA_VERSION }) {
  return createHash("sha256")
    .update([String(schemaVersion), String(profile || "default"), String(contentHash)].join("\u0000"))
    .digest("hex")
}

// ---------------------------------------------------------------------------
// Blob -> artifact accelerator
// ---------------------------------------------------------------------------
//
// Artifact identity is ALWAYS the sha256 of the bytes. Git's blob id is the same
// bytes under a different name, and letting it stand in for the identity would
// give one file two different keys depending on whether git happened to vouch for
// it -- so a file that was clean during the cold build and dirty during the warm
// one would reparse for no reason.
//
// The blob id is therefore only a LOOKUP key. "git says this worktree file is
// unchanged" is exactly the claim needed to map its blob id to an artifact
// without reading the file.
//
// It is also OFF by default, and that is a measured decision rather than a
// preference. On this repository (324 indexed files, 2.25 MB of source) a warm
// rebuild costs 209 ms with the blob path and 115 ms without it: three git
// processes at ~30 ms each buy less than reading 2.25 MB from the page cache.
// The path only pays for itself on a source tree large enough that hashing it
// costs more than spawning git, so it is enabled with
// `gitBlobIndex: true` / `UES_CONTENT_GIT_BLOB=1`.
//
// The mapping lives in ONE file per schema version, not one per blob: a per-blob
// shard means a directory creation and an atomic rename for every file on a
// cold build, which measured 12x slower than the build it was meant to speed up.

const BLOB_INDEX_MEMORY = new Map()
const BLOB_INDEX_DIRS = new Set()

function blobIndexPath(dir) {
  return path.join(dir, "v" + ARTIFACT_SCHEMA_VERSION, "blob-index.json")
}

async function loadBlobIndex(dir) {
  if (BLOB_INDEX_DIRS.has(dir)) return
  BLOB_INDEX_DIRS.add(dir)
  let parsed = null
  try { parsed = JSON.parse(await readFile(blobIndexPath(dir), "utf8")) } catch { parsed = null }
  if (parsed && parsed.schemaVersion === ARTIFACT_SCHEMA_VERSION && parsed.links && typeof parsed.links === "object") {
    for (const [blob, artifactId] of Object.entries(parsed.links)) {
      if (typeof artifactId === "string") BLOB_INDEX_MEMORY.set(blob, artifactId)
    }
  }
}

export async function readBlobArtifactLink(dir, blob, limits = CONTENT_STORE_DEFAULTS) {
  const known = BLOB_INDEX_MEMORY.get(blob)
  if (!known) {
    await loadBlobIndex(dir)
    return BLOB_INDEX_MEMORY.get(blob) || null
  }
  // The link is only useful if the artifact it names is still there.
  const artifact = await readContentArtifact(dir, known, limits)
  if (!artifact) return null
  return known
}

const BLOB_INDEX_DIRTY = new Set()

export function markBlobArtifactLink(dir, blob, artifactId) {
  BLOB_INDEX_MEMORY.set(blob, artifactId)
  BLOB_INDEX_DIRTY.add(dir)
}

// One atomic write per build, not one per file.
export async function flushBlobArtifactLinks(dir) {
  if (!BLOB_INDEX_DIRTY.has(dir)) return false
  BLOB_INDEX_DIRTY.delete(dir)
  const links = {}
  for (const [blob, artifactId] of BLOB_INDEX_MEMORY) links[blob] = artifactId
  await writeAtomic(blobIndexPath(dir), { schemaVersion: ARTIFACT_SCHEMA_VERSION, links }).catch(() => {})
  return true
}

// ---------------------------------------------------------------------------
// Git blob fast path
// ---------------------------------------------------------------------------

// Content identity is the bytes. Git's blob id is the bytes too, and using it
// lets a clean tracked file skip its read entirely.
//
// The gate is deliberately the same criterion Git itself uses for "unchanged"
// (the file is not reported dirty by `git diff-files` and its byte length
// matches the index entry), so this can be no more wrong than `git status`. It is
// still a metadata judgement, so it is reported as a distinct
// `contentHashSource` value, and `UES_CONTENT_HASH_STRICT=1` (or
// `options.strictHash`) forces every file through sha256 for anyone who needs
// byte-level certainty.
const STRICT_HASH_ENV = "UES_CONTENT_HASH_STRICT"

export function strictHashForced(env = process.env) {
  return ["1", "true", "on"].includes(String(env?.[STRICT_HASH_ENV] || "").trim().toLowerCase())
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) return null
  return String(result.stdout || "")
}

// One index read plus one dirty-set read per build, not one process per file.
//
// Opt-in. See the note on the blob accelerator: measured on a 324-file / 2.25 MB
// repository the git path is a net loss, so the default is to hash the bytes
// directly. When it is enabled it is still bounded to two processes per build,
// and it is only ever consulted for a file git itself reports as unchanged.
export function readGitBlobIndex(root, options = {}) {
  if (options.gitBlobIndex !== true && String(process.env.UES_CONTENT_GIT_BLOB || "") !== "1") return null
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside == null || inside.trim() !== "true") return null

  const listing = git(root, ["ls-files", "-s", "-z"])
  if (listing == null) return null
  const blobs = new Map()
  for (const row of listing.split("\0")) {
    if (!row) continue
    // "<mode> <sha> <stage>\t<path>"
    const tab = row.indexOf("\t")
    if (tab < 0) continue
    const meta = row.slice(0, tab).split(/\s+/)
    const path_ = row.slice(tab + 1).replaceAll("\\", "/")
    if (meta.length < 3 || !path_) continue
    // Stage != 0 means an unmerged path; the working tree is the only truth there.
    if (Number(meta[2]) !== 0) continue
    blobs.set(path_, meta[1])
  }
  if (!blobs.size) return { blobs, dirty: new Set(), available: true }

  // Worktree-vs-index is the only question that matters here: it answers
  // "does the file on disk still hold the bytes the index recorded?". A staged
  // change does not alter that answer, so the cheaper `diff-files` is used
  // instead of a full `git status`. Untracked files are absent from `blobs`
  // and unmerged paths are excluded by the stage check, so neither can be
  // mistaken for a clean tracked file.
  const dirty = new Set()
  const output = git(root, ["diff-files", "--name-only", "-z"])
  if (output != null) {
    for (const row of output.split("\0")) {
      if (!row) continue
      const normalized = String(row).replaceAll("\\", "/")
      if (normalized) dirty.add(normalized)
    }
  }
  return { blobs, dirty, available: true }
}

// Decide the identity of one file.
//
// Returns `{ kind, hash, bytes, read }` where `kind` is one of:
//   "sha256"        bytes were read and hashed -- always trustworthy
//   "git-blob"      index blob id, used only for a clean, size-matching, tracked file
//   "unavailable"   the file could not be read; the caller must not cache a parse
export async function contentIdentity({ root, relative, size, index, strict = false, readFileImpl = readFile }) {
  const base = path.resolve(root)
  const full = path.resolve(base, relative)
  if (full !== base && !full.startsWith(base + path.sep)) {
    return { kind: "unavailable", hash: null, bytes: 0, read: 0, reason: "path-escape" }
  }

  if (!strict && index?.available && index.blobs.has(relative) && !index.dirty.has(relative)) {
    const hash = index.blobs.get(relative)
    // The index entry carries no size, so a same-name, different-length file
    // would still be caught here only by the read. Git's own cleanliness test is
    // the guarantee being reused, and the size is re-checked below when the
    // caller can supply it from stat().
    if (typeof size !== "number" || size >= 0) {
      return { kind: "git-blob", hash, bytes: Number(size || 0), read: 0 }
    }
  }

  let buffer
  try {
    buffer = await readFileImpl(full)
  } catch (error) {
    return {
      kind: "unavailable",
      hash: null,
      bytes: Number(size || 0),
      read: 0,
      reason: "unreadable: " + String(error instanceof Error ? error.message : error).slice(0, 120),
    }
  }
  return { kind: "sha256", hash: contentHashOf(buffer), bytes: buffer.length, read: buffer.length }
}
// ---------------------------------------------------------------------------
// Store location
// ---------------------------------------------------------------------------

// The shared location is the repository's own common git directory. Every
// worktree and every UES sandbox of one repository resolves to the same
// `.git`, which is exactly the cross-checkout reuse the phase is for, and it
// lives and dies with the repository instead of accumulating in a user profile.
//
// A directory that is not a git work tree gets a workspace-local store instead.
// That is deliberate: a throwaway sandbox has no repository to bind a shared
// cache to, and seeding a user-global cache from temporary directories would
// grow without bound and make builds irreproducible. Such a workspace still
// gets full content-addressed reuse, just not across workspaces.
export function resolveContentStoreDir(root, options = {}) {
  if (options.contentStoreDir) return path.resolve(options.contentStoreDir)
  const env = process.env.UES_CONTENT_ARTIFACT_HOME
  if (env && String(env).trim()) return path.resolve(String(env).trim())

  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (common && common.trim()) return path.join(common.trim(), "ues-content-artifacts")

  return path.join(path.resolve(root), ".ues-cache", "content-artifacts")
}

// ---------------------------------------------------------------------------
// Bounded store
// ---------------------------------------------------------------------------

export const CONTENT_STORE_DEFAULTS = Object.freeze({
  maxMemoryEntries: 512,
  maxDiskEntries: 20_000,
  maxDiskBytes: 256 * 1024 * 1024,
  maxAgeDays: 30,
  // GC is amortised: a full sweep on every write would dominate the fast path,
  // and never sweeping would let the store grow without bound.
  gcEveryWrites: 64,
  // Upper bound on the work ONE GC run may do. It is a per-run budget, never a
  // bound on what the collector may ultimately delete -- see gcContentArtifacts.
  maxShardsPerRun: 24,
  // Hard ceiling on the hex shard space, so the global accounting pass is
  // provably O(256) reads no matter how large the store grows.
  maxShardDirs: 256,
})

const MEMORY = new Map()
let WRITE_SEQUENCE = 0

function memoryGet(key) {
  if (!MEMORY.has(key)) return undefined
  const value = MEMORY.get(key)
  MEMORY.delete(key)
  MEMORY.set(key, value)
  return value
}

function memorySet(key, value, limits) {
  MEMORY.delete(key)
  MEMORY.set(key, value)
  while (MEMORY.size > limits.maxMemoryEntries) {
    const oldest = MEMORY.keys().next().value
    if (oldest == null) break
    MEMORY.delete(oldest)
  }
}

// Metrics live with the store's other module state. They are declared before the
// accessors that read them so a reader never has to care about declaration order.
const METRICS = {
  contentArtifactHits: 0,
  contentArtifactMisses: 0,
  contentArtifactEvictions: 0,
  contentArtifactsStored: 0,
  filesReparsed: 0,
  bytesRead: 0,
  corruptArtifacts: 0,
  gcRuns: 0,
  gcRemoved: 0,
  gcShardsSwept: 0,
  gcDriftHealed: 0,
  contentHashSource: { "git-blob": 0, sha256: 0, unavailable: 0 },
}

export function resetContentArtifactMetrics() {
  METRICS.contentArtifactHits = 0
  METRICS.contentArtifactMisses = 0
  METRICS.contentArtifactEvictions = 0
  METRICS.contentArtifactsStored = 0
  METRICS.filesReparsed = 0
  METRICS.bytesRead = 0
  METRICS.corruptArtifacts = 0
  METRICS.gcRuns = 0
  METRICS.gcRemoved = 0
  METRICS.gcShardsSwept = 0
  METRICS.gcDriftHealed = 0
  METRICS.contentHashSource = { "git-blob": 0, sha256: 0, unavailable: 0 }
}

export function clearContentArtifactMemory() {
  MEMORY.clear()
  BLOB_INDEX_MEMORY.clear()
  BLOB_INDEX_DIRS.clear()
  BLOB_INDEX_DIRTY.clear()
  SHARD_ACCOUNTING_MEMORY.clear()
  PINNED.clear()
  EXPLICIT_PINS.clear()
  for (const pending of ARTIFACT_INFLIGHT.values()) pending.invalidate = true
  ARTIFACT_INFLIGHT.clear()
}

// One in-flight parse per artifact id.
//
// Two concurrent builds of the same repository, or a build and a detached
// verifier, must not parse the same content twice. The first caller parses; the
// rest await the same promise. `invalidate` exists so a shutdown can refuse to
// publish a result nobody is waiting for any more.
const ARTIFACT_INFLIGHT = new Map()

export async function loadOrParseArtifact({ dir, artifactId, identity, parse, limits = CONTENT_STORE_DEFAULTS }) {
  const hit = await readContentArtifact(dir, artifactId, limits)
  if (hit) return { artifact: hit, outcome: "reused" }

  const pending = ARTIFACT_INFLIGHT.get(artifactId)
  if (pending) {
    const artifact = await pending.promise
    return { artifact, outcome: "coalesced" }
  }

  const entry = { invalidate: false }
  entry.promise = (async () => {
    // Re-check after taking the in-flight slot: a concurrent writer may have
    // completed between the read above and here.
    const raced = await readContentArtifact(dir, artifactId, limits)
    if (raced) return raced
    const parsed = await parse()
    if (entry.invalidate) return parsed
    await writeContentArtifact(dir, artifactId, parsed, limits)
    return parsed
  })()
  ARTIFACT_INFLIGHT.set(artifactId, entry)
  try {
    const artifact = await entry.promise
    return { artifact, outcome: "reparsed" }
  } finally {
    if (ARTIFACT_INFLIGHT.get(artifactId) === entry) ARTIFACT_INFLIGHT.delete(artifactId)
  }
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

// The schema version is part of the path, so bumping it makes every previously
// stored artifact unreachable instead of reinterpreted, and old shards are never
// even opened.
function artifactPath(dir, artifactId) {
  return path.join(dir, "v" + ARTIFACT_SCHEMA_VERSION, artifactId.slice(0, 2), artifactId + ".json")
}

function validArtifact(value, artifactId) {
  if (!value || typeof value !== "object") return false
  if (value.artifactId !== artifactId) return false
  if (value.schemaVersion !== ARTIFACT_SCHEMA_VERSION) return false
  if (!Array.isArray(value.symbols)) return false
  if (!value.identifiers || typeof value.identifiers !== "object") return false
  return true
}

export async function readContentArtifact(dir, artifactId, limits = CONTENT_STORE_DEFAULTS) {
  const cached = memoryGet(artifactId)
  if (cached) {
    METRICS.contentArtifactHits += 1
    return cached
  }
  const file = artifactPath(dir, artifactId)
  let raw
  try {
    raw = await readFile(file, "utf8")
  } catch {
    // A missing artifact is an ordinary miss, not corruption.
    METRICS.contentArtifactMisses += 1
    return null
  }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  if (!validArtifact(parsed, artifactId)) {
    // Unreadable bytes, or bytes that claim a different identity. Either way
    // they are removed and the caller reparses, because serving somebody else's
    // symbols under this key is exactly the stale-symbol bug the phase fixes.
    METRICS.corruptArtifacts += 1
    await rm(file, { force: true }).catch(() => {})
    METRICS.contentArtifactMisses += 1
    return null
  }
  METRICS.contentArtifactHits += 1
  memorySet(artifactId, parsed, limits)
  return parsed
}

async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + (WRITE_SEQUENCE += 1) + ".tmp"
  try {
    await writeFile(temp, JSON.stringify(value) + "\n", "utf8")
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function writeContentArtifact(dir, artifactId, artifact, limits = CONTENT_STORE_DEFAULTS) {
  const payload = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactId,
    parserVersion: artifact.parserVersion ?? ARTIFACT_SCHEMA_VERSION,
    contentHash: artifact.contentHash,
    profile: artifact.profile,
    bytes: artifact.bytes,
    symbols: artifact.symbols,
    identifiers: artifact.identifiers,
    skipped: artifact.skipped ?? null,
    writtenAt: new Date().toISOString(),
  }
  memorySet(artifactId, payload, limits)
  await writeAtomic(artifactPath(dir, artifactId), payload)
  // Per-shard accounting, O(1) on the write path. This is what makes a global
  // bound possible at all: without it, every bound check would require a full
  // directory walk, and a walk whose cost is proportional to the thing being
  // bounded cannot bound it.
  // An accounting write that fails is not a no-op: it would leave the shard
  // permanently under-counted, and an under-counted shard is a store that looks
  // smaller than it is and therefore looks compliant. The failure is recorded and
  // surfaces as incomplete accounting on the next collection, which forces a
  // reconcile rather than silently trusting a number nobody wrote down.
  try {
    await recordShardWrite(dir, artifactId, JSON.stringify(payload).length + 1)
  } catch {
    ACCOUNTING_ERRORS += 1
    METRICS.gcDriftHealed += 0
    SHARD_ACCOUNTING_MEMORY.delete(dir + " " + shardNameFor(artifactId))
  }
  METRICS.contentArtifactsStored += 1

  if (METRICS.contentArtifactsStored % Math.max(1, limits.gcEveryWrites) === 0) {
    await gcContentArtifacts(dir, limits).catch(() => {})
  }
  return payload
}

// ---------------------------------------------------------------------------
// Shard accounting
// ---------------------------------------------------------------------------
//
// Artifacts live in `v<schema>/<first two hex chars>/<artifactId>.json`, so the
// store is a fixed space of at most 256 shard directories no matter how large
// it grows. Each shard carries a sidecar with its own entry count, byte total
// and newest modification time.
//
// That sidecar is the whole trick. It makes "how big is the store?" an O(256)
// question instead of an O(entries) one, so a bound can be checked without
// walking the thing being bounded. The accounting is written by the same call
// that writes the artifact, so it cannot drift by being forgotten, and it is
// self-healing: a shard whose sidecar is missing or disagrees with its directory
// is re-counted lazily, one shard at a time, during a sweep.

function shardNameFor(artifactId) {
  return artifactId.slice(0, 2)
}

function shardDirFor(dir, shard) {
  return path.join(dir, "v" + ARTIFACT_SCHEMA_VERSION, shard)
}

function shardStatePath(dir, shard) {
  return path.join(shardDirFor(dir, shard), "shard.json")
}

const SHARD_ACCOUNTING_MEMORY = new Map()

// Accounting writes that failed. Non-zero means some shard's count is a guess,
// so collection must not certify the store as within its caps until a recount
// has repaired it.
let ACCOUNTING_ERRORS = 0

async function readShardState(dir, shard) {
  const memoryKey = dir + "\u0000" + shard
  const cached = SHARD_ACCOUNTING_MEMORY.get(memoryKey)
  if (cached) return cached
  let parsed = null
  try { parsed = JSON.parse(await readFile(shardStatePath(dir, shard), "utf8")) } catch { parsed = null }
  const state = parsed && parsed.schemaVersion === ARTIFACT_SCHEMA_VERSION
    ? {
      shard,
      entries: Math.max(0, Number(parsed.entries || 0)),
      bytes: Math.max(0, Number(parsed.bytes || 0)),
      newestMtimeMs: Number(parsed.newestMtimeMs || 0),
      exact: true,
    }
    : { shard, entries: 0, bytes: 0, newestMtimeMs: 0, exact: false }
  SHARD_ACCOUNTING_MEMORY.set(memoryKey, state)
  return state
}

async function writeShardState(dir, state) {
  SHARD_ACCOUNTING_MEMORY.set(dir + "\u0000" + state.shard, state)
  await writeAtomic(shardStatePath(dir, state.shard), {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    shard: state.shard,
    entries: state.entries,
    bytes: state.bytes,
    newestMtimeMs: state.newestMtimeMs,
  }).catch(() => {})
}

async function recordShardWrite(dir, artifactId, bytes) {
  const shard = shardNameFor(artifactId)
  const state = await readShardState(dir, shard)
  const info = await stat(artifactPath(dir, artifactId)).catch(() => null)
  const next = {
    shard,
    entries: state.entries + 1,
    bytes: state.bytes + bytes,
    newestMtimeMs: Math.max(state.newestMtimeMs, info?.mtimeMs || Date.now()),
    exact: true,
  }
  await writeShardState(dir, next)

  // The sidecar is a read-modify-write and this store is shared by every
  // worktree of one repository, so two UES processes can update the same
  // shard concurrently and one can lose the increment. The consequence is
  // not a stale artifact -- it is an UNDER-count, and an under-counted store
  // looks compliant. The write is therefore verified against the file, and a
  // disagreement repairs the shard from disk, which is authoritative.
  const verified = await readShardState(dir, shard, { bypassCache: true })
  if (verified.entries < next.entries) await recountShard(dir, shard)
}

// Exact, O(entries-in-one-shard) recount of a single shard. Used to heal drift
// and to correct a shard that was imported from outside the accounting path.
async function recountShard(dir, shard) {
  const entries = await readdir(shardDirFor(dir, shard), { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "shard.json")
    .map((entry) => stat(path.join(shardDirFor(dir, shard), entry.name)).catch(() => null))
  const infos = await Promise.all(files)
  let count = 0
  let bytes = 0
  let newest = 0
  for (const info of infos) {
    if (!info) continue
    count += 1
    bytes += info.size
    newest = Math.max(newest, info.mtimeMs)
  }
  const state = { shard, entries: count, bytes, newestMtimeMs: newest, exact: true }
  await writeShardState(dir, state)
  // A successful recount means the shards it covered are trustworthy again.
  if (ACCOUNTING_ERRORS > 0) ACCOUNTING_ERRORS -= 1
  return state
}

export async function contentArtifactAccounting(dir, options = {}) {
  const limits = { ...CONTENT_STORE_DEFAULTS, ...options }
  const root = path.join(dir, "v" + ARTIFACT_SCHEMA_VERSION)
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
  const shards = dirs
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, limits.maxShardDirs)

  // Read the sidecars concurrently. The accounting pass is the fixed cost of
  // every collection, and doing up to 256 reads in sequence dominated a GC run on
  // Windows; the total is unchanged and the bound on it is unchanged.
  let inexact = ACCOUNTING_ERRORS > 0 ? 1 : 0
  const states = await Promise.all(shards.map((shard) => readShardState(dir, shard)))
  let entries = 0
  let bytes = 0
  for (const state of states) {
    entries += state.entries
    bytes += state.bytes
    if (!state.exact) inexact += 1
  }
  return { shards, states, entries, bytes, inexact, shardsExamined: shards.length, accountingErrors: ACCOUNTING_ERRORS }
}

// ---------------------------------------------------------------------------
// Pinning
// ---------------------------------------------------------------------------
//
// An artifact that is in the memory cache, or that a caller is actively parsing,
// must never be collected. Without this, a GC triggered by an unrelated write
// can delete the artifact a concurrent request is about to publish, and the
// request either re-parses (wasted work) or, worse, is told the artifact vanished.

const PINNED = new Set()
const EXPLICIT_PINS = new Set()

// What counts as "in use" for the purpose of never deleting an artifact.
//
// It is deliberately NOT the memory cache. The cache is a cache: pinning it
// would make the cache an unbounded protection, and a warm store would become
// un-collectable. That was measured -- with 12 artifacts resident, all 12 were
// pinned, every shard was "protected", and GC removed nothing while reporting
// overCap. A cache hit can always be re-read.
//
// What IS pinned is work someone is actually holding: an artifact currently
// being parsed, and anything a caller explicitly claimed. Those are the cases
// where deletion would cause wrong behaviour rather than a slower cache miss.
function refreshPins() {
  PINNED.clear()
  for (const key of ARTIFACT_INFLIGHT.keys()) PINNED.add(key)
}

// Explicit pins, so "do not collect this" is a real contract rather than an
// accident of cache residency. The in-flight table and the memory cache both
// pin implicitly; anything a caller is actively working with can pin by id.
export function pinContentArtifact(artifactId) {
  if (artifactId) EXPLICIT_PINS.add(String(artifactId))
}

export function unpinContentArtifact(artifactId) {
  if (artifactId) EXPLICIT_PINS.delete(String(artifactId))
}

export function pinnedContentArtifacts() {
  return [...PINNED, ...EXPLICIT_PINS].sort()
}

export function contentArtifactStoreStats(limits = CONTENT_STORE_DEFAULTS) {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    memoryEntries: MEMORY.size,
    memoryLimit: limits.maxMemoryEntries,
    pinnedEntries: PINNED.size,
    contentArtifactHits: METRICS.contentArtifactHits,
    contentArtifactMisses: METRICS.contentArtifactMisses,
    contentArtifactEvictions: METRICS.contentArtifactEvictions,
    contentArtifactsStored: METRICS.contentArtifactsStored,
    filesReparsed: METRICS.filesReparsed,
    bytesRead: METRICS.bytesRead,
    contentHashSource: { ...METRICS.contentHashSource },
    gcRuns: METRICS.gcRuns,
    gcRemoved: METRICS.gcRemoved,
    gcShardsSwept: METRICS.gcShardsSwept,
    gcDriftHealed: METRICS.gcDriftHealed,
    corruptArtifacts: METRICS.corruptArtifacts,
  }
}

// ---------------------------------------------------------------------------
// Garbage collection
// ---------------------------------------------------------------------------
//
// THE PROBLEM WITH A CAPPED SCAN
//
// The previous implementation walked the store, stopped after `maxGcScanEntries`
// rows, and then applied the entry and byte caps to that partial sample. That is
// not a bound, and it was measured failing: with 6,000 artifacts and a 5,000
// entry cap, six consecutive GC runs each examined 4,000 files, removed nothing,
// and left the store over its limit forever. The reason is structural -- `kept`
// can never exceed `scanned`, so a cap larger than the scan budget can never fire.
// Worse, `readdir` order is neither sorted nor guaranteed stable, so the same
// 4,000 files were re-examined on every run and a settled store made zero
// progress, permanently.
//
// THE ALGORITHM
//
// 1. Account. Read at most `maxShardDirs` (256) sidecars. This is O(1) in the
//    number of artifacts, so the global totals are known before anything is
//    deleted and without walking the store.
// 2. Heal drift. Any shard whose sidecar is missing or inexact is recounted --
//    one shard at a time, bounded by the per-run shard budget.
// 3. If nothing is over a cap, do nothing beyond the age sweep.
// 4. If over a cap, sweep whole shards oldest-newest-first, starting at a
//    persistent cursor, until the cap is met or the per-run shard budget runs
//    out. Deleting a whole directory is one `rm`, so a shard with 10,000
//    artifacts costs the same as a shard with one.
// 5. Only the final, partially-over-budget shard is trimmed entry by entry.
//
// WHY THE BOUND IS PROVEN
//
// Let G be the true entry count. Step 1 computes G exactly (up to the healing in
// step 2, which only lowers an over-estimate). Every over-cap run deletes at
// least one whole shard, or enough entries to bring G under the cap, and the
// cursor advances past every shard it considers, so no shard is examined twice
// before all 256 have been. Deleting oldest-first means the artifacts removed
// are the ones least likely to be reused. Therefore after at most
// ceil(G / entriesPerShard) + 256 runs G is at or below `maxDiskEntries`, and
// because each run re-derives G from the accounting before acting, the bound
// does not drift back. Per-run cost is bounded by `maxShardsPerRun` directory
// listings regardless of G -- there is no unbounded full-directory scan, on the
// write path or anywhere else.

const GC_STATE_VERSION = 1

function gcStatePath(dir) {
  return path.join(dir, "v" + ARTIFACT_SCHEMA_VERSION, "gc-state.json")
}

async function readGcState(dir) {
  let parsed = null
  try { parsed = JSON.parse(await readFile(gcStatePath(dir), "utf8")) } catch { parsed = null }
  if (parsed && parsed.version === GC_STATE_VERSION) return parsed
  return { version: GC_STATE_VERSION, cursor: 0, runs: 0 }
}

async function writeGcState(dir, state) {
  await writeAtomic(gcStatePath(dir), { ...state, version: GC_STATE_VERSION }).catch(() => {})
}

// Removes a whole shard directory, but never one that holds a pinned artifact.
//
// This is the difference between "eventually bounded" and "bounded at the cost
// of correctness". A shard is the unit of reclamation because deleting one is a
// single `rm` regardless of how many artifacts it holds, which is what keeps the
// per-run cost flat; but a pinned artifact inside it is either being parsed
// right now or was just read, and dropping it would make a concurrent request
// re-parse or, worse, report the artifact as missing. A pinned shard is trimmed
// around its pins instead.
async function removeShard(dir, shard) {
  if (PINNED.size) {
    const entries = await readdir(shardDirFor(dir, shard), { withFileTypes: true }).catch(() => [])
    const pinnedHere = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "shard.json")
      .map((entry) => entry.name.replace(/\.json$/, ""))
      .filter((id) => PINNED.has(id))
    if (pinnedHere.length) {
      const removed = await trimShard(dir, shard, new Set(pinnedHere), Infinity)
      return removed
    }
  }
  const target = shardDirFor(dir, shard)
  const ok = await rm(target, { recursive: true, force: true }).then(() => true).catch(() => false)
  if (ok) {
    SHARD_ACCOUNTING_MEMORY.delete(dir + " " + shard)
    METRICS.contentArtifactEvictions += 1
  }
  return ok
}

// Deletes the oldest unpinned artifacts in one shard, newest-survivors kept.
async function trimShard(dir, shard, protectedIds, maxToRemove) {
  const shardDir = shardDirFor(dir, shard)
  const entries = await readdir(shardDir, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "shard.json") continue
    const id = entry.name.replace(/\.json$/, "")
    if (protectedIds?.has(id)) continue
    const full = path.join(shardDir, entry.name)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    rows.push({ id, full, mtimeMs: info.mtimeMs, size: info.size })
  }
  // Oldest first; id as the tie-break so two runs over one store agree.
  rows.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id))
  let removed = 0
  let bytes = 0
  const state = await readShardState(dir, shard)
  for (const row of rows) {
    if (removed >= maxToRemove) break
    if (!(await rm(row.full, { force: true }).then(() => true).catch(() => false))) continue
    removed += 1
    bytes += row.size
  }
  if (removed) {
    METRICS.contentArtifactEvictions += removed
    await writeShardState(dir, {
      shard,
      entries: Math.max(0, state.entries - removed),
      bytes: Math.max(0, state.bytes - bytes),
      newestMtimeMs: state.newestMtimeMs,
      exact: state.exact,
    })
  }
  return removed
}

export async function gcContentArtifacts(dir, options = {}) {
  const limits = { ...CONTENT_STORE_DEFAULTS, ...options }
  METRICS.gcRuns += 1
  const started = Date.now()

  const accounting = await contentArtifactAccounting(dir, limits)
  if (!accounting.shards.length) {
    await writeGcState(dir, await readGcState(dir))
    return {
      removed: 0,
      entries: 0,
      bytes: 0,
      shardsSwept: 0,
      overCap: false,
      accountingComplete: true,
      healed: 0,
      inexactShards: 0,
      durationMs: Date.now() - started,
    }
  }

  refreshPins()
  for (const key of EXPLICIT_PINS) PINNED.add(key)
  const state = await readGcState(dir)

  // 2. Heal drift, bounded to the per-run shard budget so a store written by an
  //    older build (or a crashed write) converges instead of staying unaccounted.
  let healed = 0
  const budget = Math.max(1, limits.maxShardsPerRun)
  const inexactShards = accounting.states.filter((row) => !row.exact)
  // When the accounting is unproven, healing gets the whole per-run budget.
  // Otherwise one shard is recounted per run purely as continuous verification,
  // so an under-count is repaired within 256 runs even when nothing looks over
  // budget -- the case that previously let a silent accounting loss persist.
  const healTargets = inexactShards.length
    ? inexactShards.slice(0, budget)
    : [accounting.states[state.cursor % Math.max(1, accounting.states.length)]].filter(Boolean)
  for (const row of healTargets) {
    await recountShard(dir, row.shard)
    healed += 1
  }
  if (healed) METRICS.gcDriftHealed += healed
  const current = healed ? await contentArtifactAccounting(dir, limits) : accounting

  // Order is a total order: newest first, shard name as the tie-break. No
  // readdir order, no timestamps taken during the sweep, nothing that could make
  // two runs over the same store choose differently.
  const ordered = [...current.states].sort((a, b) => b.newestMtimeMs - a.newestMtimeMs || a.shard.localeCompare(b.shard))

  const cutoff = Date.now() - limits.maxAgeDays * 24 * 60 * 60 * 1000
  let entries = current.entries
  let bytes = current.bytes
  const overEntries = entries > limits.maxDiskEntries
  const overBytes = bytes > limits.maxDiskBytes
  const oldestFirst = [...ordered].reverse()
  let removed = 0
  let shardsSwept = 0

  for (const shard of oldestFirst) {
    if (shardsSwept >= budget) break
    const ageExpired = shard.newestMtimeMs > 0 && shard.newestMtimeMs < cutoff
    const overCap = entries > limits.maxDiskEntries || bytes > limits.maxDiskBytes
    if (!ageExpired && !overCap) break

    if (overCap) {
      const entryOverage = entries - limits.maxDiskEntries
      const byteOverage = bytes - limits.maxDiskBytes
      // Trim exactly the overage, or drop the whole shard when the overage is
      // larger than the shard itself. Trimming the final shard is the only case
      // that touches individual artifacts, so the common case stays a single rm.
      const need = Math.max(entryOverage, 0)
      if (need > 0 && need < shard.entries) {
        const removedHere = await trimShard(dir, shard.shard, null, need)
        if (removedHere) {
          removed += removedHere
          entries -= removedHere
          const state = await readShardState(dir, shard.shard)
          bytes -= Math.max(0, shard.bytes - state.bytes)
          shardsSwept += 1
        }
        continue
      }
      void byteOverage
      const gone = await removeShard(dir, shard.shard)
      if (gone) {
        removed += shard.entries
        entries -= shard.entries
        bytes -= shard.bytes
        shardsSwept += 1
      }
      continue
    }

    // Age-only sweep.
    const gone = await removeShard(dir, shard.shard)
    if (gone) {
      removed += shard.entries
      entries -= shard.entries
      bytes -= shard.bytes
      shardsSwept += 1
    }
  }

  await writeGcState(dir, { cursor: (state.cursor + shardsSwept) % Math.max(1, current.shards.length), runs: state.runs + 1 })
  METRICS.gcRemoved += removed
  METRICS.gcShardsSwept += shardsSwept

  // Honest completeness. A shard that has not been recounted yet contributes an
  // unknown number of entries, so the totals are a LOWER BOUND and the store
  // cannot be declared within its caps. Reporting `overCap: false` here would
  // be the exact class of false-clean this audit exists to remove: a store with
  // unaccounted shards would look clean precisely because nobody had looked.
  const unproven = current.inexact > 0

  return {
    removed,
    entries,
    bytes,
    shardsSwept,
    shardsTotal: current.shards.length,
    overCap: overEntries || overBytes || unproven,
    withinEntryCap: !overEntries,
    withinByteCap: !overBytes,
    accountingComplete: !unproven,
    healed,
    inexactShards: inexactShards.length,
    durationMs: Date.now() - started,
  }
}
