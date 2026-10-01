import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const STORE_VERSION = 1
const REF_PREFIX = "evidence:sha256:"
const DEFAULT_MAX_STORE_BYTES = 192 * 1024 * 1024
const DEFAULT_MAX_STORE_ENTRIES = 1200
const DEFAULT_MAX_STORE_AGE_DAYS = 14
const AUTO_GC_EVERY_WRITES = 8
const AUTO_GC_LARGE_ITEM_BYTES = 16 * 1024 * 1024
const PUT_COUNTS = new Map()

const STORE_MUTATION_TAILS = new Map()
const STORE_LOCK_STALE_MS = 30_000
const STORE_LOCK_WAIT_MS = 40_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function storeLockPath(root) {
  return path.join(evidenceStoreRoot(root), ".mutation.lock")
}

async function withCrossProcessStoreLock(root, fn) {
  const lockDir = storeLockPath(root)
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + STORE_LOCK_WAIT_MS
  let delayMs = 8
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockDir).catch(() => null)
      if (info && Date.now() - info.mtimeMs > STORE_LOCK_STALE_MS) {
        const confirmed = await stat(lockDir).catch(() => null)
        if (
          confirmed &&
          confirmed.ino === info.ino &&
          confirmed.mtimeMs === info.mtimeMs
        ) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for evidence-store mutation lock")
      await sleep(delayMs)
      delayMs = Math.min(100, delayMs * 2)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function withStoreMutationLock(root, fn) {
  const key = path.resolve(root)
  const previous = STORE_MUTATION_TAILS.get(key) || Promise.resolve()
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => barrier)
  STORE_MUTATION_TAILS.set(key, tail)

  await previous.catch(() => {})
  try {
    return await withCrossProcessStoreLock(root, fn)
  } finally {
    release()
    if (STORE_MUTATION_TAILS.get(key) === tail) STORE_MUTATION_TAILS.delete(key)
  }
}

async function atomicWrite(file, value, encoding) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp"
  await writeFile(temp, value, encoding)
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function defaultStoreLimits() {
  return {
    maxBytes: boundedNumber(
      process.env.UES_EVIDENCE_MAX_BYTES,
      DEFAULT_MAX_STORE_BYTES,
      16 * 1024 * 1024,
      2 * 1024 * 1024 * 1024,
    ),
    maxEntries: boundedNumber(
      process.env.UES_EVIDENCE_MAX_ENTRIES,
      DEFAULT_MAX_STORE_ENTRIES,
      100,
      20_000,
    ),
    maxAgeDays: boundedNumber(
      process.env.UES_EVIDENCE_MAX_AGE_DAYS,
      DEFAULT_MAX_STORE_AGE_DAYS,
      1,
      365,
    ),
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object" || Buffer.isBuffer(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  )
}

function toBytes(value, options = {}) {
  if (Buffer.isBuffer(value)) return { bytes: value, encoding: "binary", mediaType: options.mediaType || "application/octet-stream" }
  if (typeof value === "string") return { bytes: Buffer.from(value, "utf8"), encoding: "utf8", mediaType: options.mediaType || "text/plain; charset=utf-8" }
  const text = JSON.stringify(stableValue(value), null, options.pretty === false ? 0 : 2)
  return { bytes: Buffer.from(text, "utf8"), encoding: "utf8", mediaType: options.mediaType || "application/json" }
}

const ACTIVE_WORK_DIR = ".ues-work"
const ACTIVE_WORK_SCAN_FILES = 256
const ACTIVE_WORK_SCAN_DEPTH = 4
const ACTIVE_CONTEXT_GRACE_MS = 24 * 60 * 60_000
const CONTEXT_GRACE_KINDS = new Set([
  "context-block",
  "document-ingestion",
  "dependency-report",
  "work-spec",
])

async function protectedMemoryEvidenceHashes(root) {
  const file = path.join(path.resolve(root), ".ues-memory", "MEMORY.json")
  const parsed = await readFile(file, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null)
  const protectedHashes = new Set()
  const now = Date.now()
  for (const memory of parsed?.memories || []) {
    if (memory?.status !== "verified" || memory?.supersededBy) continue
    const expiresAt = Date.parse(String(memory?.expiresAt || ""))
    if (expiresAt && expiresAt <= now) continue
    for (const ref of memory?.evidenceRefs || []) {
      try { protectedHashes.add(normalizeHash(String(ref).split("#", 1)[0])) } catch {}
    }
  }
  return protectedHashes
}

function collectEvidenceRefsFromText(text, output) {
  for (const match of String(text || "").matchAll(/evidence:sha256:[a-f0-9]{64}/gi)) {
    try { output.add(normalizeHash(match[0])) } catch {}
  }
}

async function collectActiveWorkJsonRefs(dir, output, state = { files: 0 }, depth = 0) {
  if (depth > ACTIVE_WORK_SCAN_DEPTH || state.files >= ACTIVE_WORK_SCAN_FILES) return
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (state.files >= ACTIVE_WORK_SCAN_FILES) break
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectActiveWorkJsonRefs(file, output, state, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue
    const info = await stat(file).catch(() => null)
    if (!info?.isFile() || info.size > 2 * 1024 * 1024) continue
    state.files += 1
    const raw = await readFile(file, "utf8").catch(() => "")
    collectEvidenceRefsFromText(raw, output)
  }
}

async function protectedActiveWorkEvidenceHashes(root) {
  const base = path.join(path.resolve(root), ACTIVE_WORK_DIR)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const protectedHashes = new Set()

  for (const entry of entries.slice(0, 64)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(base, entry.name)
    const state = await readFile(path.join(dir, "STATE.json"), "utf8")
      .then((raw) => JSON.parse(raw))
      .catch(() => null)
    if (!state) continue
    const status = String(state.status || "").toLowerCase()
    if (["completed", "finalized", "cancelled", "canceled"].includes(status)) continue
    await collectActiveWorkJsonRefs(dir, protectedHashes)
  }
  return protectedHashes
}

async function protectedEvidenceHashes(root, options = {}) {
  const protectedHashes = new Set()
  if (options.memory !== false) {
    for (const hash of await protectedMemoryEvidenceHashes(root)) protectedHashes.add(hash)
  }
  if (options.activeWork !== false) {
    for (const hash of await protectedActiveWorkEvidenceHashes(root)) protectedHashes.add(hash)
  }
  return protectedHashes
}

function normalizeHash(ref) {
  const value = String(ref || "").trim()
  const hash = value.startsWith(REF_PREFIX) ? value.slice(REF_PREFIX.length) : value.replace(/^sha256:/, "")
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error("Invalid evidence reference")
  return hash.toLowerCase()
}

export function evidenceReference(hash) {
  return REF_PREFIX + normalizeHash(hash)
}

export function evidenceStoreRoot(root = process.cwd()) {
  return path.join(path.resolve(root), ".ues-cache", "evidence-v1")
}

function evidencePaths(root, hash) {
  const normalized = normalizeHash(hash)
  const dir = path.join(evidenceStoreRoot(root), normalized.slice(0, 2))
  return {
    dir,
    meta: path.join(dir, normalized + ".json"),
    data: path.join(dir, normalized + ".blob"),
  }
}

export async function putEvidence(root, value, options = {}) {
  root = path.resolve(root)
  const encoded = toBytes(value, options)
  const hash = createHash("sha256").update(encoded.bytes).digest("hex")
  const target = evidencePaths(root, hash)

  const mutation = await withStoreMutationLock(root, async () => {
    await mkdir(target.dir, { recursive: true })
    const now = new Date().toISOString()
    const existing = existsSync(target.meta)
      ? JSON.parse(await readFile(target.meta, "utf8").catch(() => "{}"))
      : null

    if (!existsSync(target.data)) {
      await atomicWrite(target.data, encoded.bytes)
    }

    const preview = encoded.encoding === "utf8"
      ? encoded.bytes.toString("utf8", 0, Math.min(encoded.bytes.length, 600))
      : null

    const metadata = {
      schemaVersion: STORE_VERSION,
      ref: evidenceReference(hash),
      sha256: hash,
      bytes: encoded.bytes.length,
      encoding: encoded.encoding,
      mediaType: encoded.mediaType,
      kind: options.kind || existing?.kind || "tool-output",
      source: options.source || existing?.source || null,
      summary: options.summary || existing?.summary || null,
      createdAt: existing?.createdAt || now,
      lastSeenAt: now,
      preview,
    }
    await atomicWrite(target.meta, JSON.stringify(metadata, null, 2) + "\n", "utf8")

    const writes = (PUT_COUNTS.get(root) || 0) + 1
    PUT_COUNTS.set(root, writes)
    return {
      metadata,
      shouldGc: writes % AUTO_GC_EVERY_WRITES === 0 || encoded.bytes.length >= AUTO_GC_LARGE_ITEM_BYTES,
    }
  })

  if (mutation.shouldGc) {
    await gcEvidenceStore(root, defaultStoreLimits()).catch(() => null)
  }
  return mutation.metadata
}

export async function getEvidence(root, ref, options = {}) {
  const hash = normalizeHash(ref)
  const target = evidencePaths(root, hash)
  const metadata = JSON.parse(await readFile(target.meta, "utf8"))
  const bytes = await readFile(target.data)
  const start = Math.max(0, Number(options.start || 0))
  const maxBytes = Math.max(1, Number(options.maxBytes || options.maxChars || 24_000))
  const slice = bytes.subarray(start, Math.min(bytes.length, start + maxBytes))
  return {
    ...metadata,
    truncated: start + slice.length < bytes.length,
    start,
    returnedBytes: slice.length,
    content: metadata.encoding === "utf8" ? slice.toString("utf8") : slice.toString("base64"),
  }
}


function evidenceSelector(ref) {
  const value = String(ref || "").trim()
  const index = value.indexOf("#")
  if (index < 0) return { ref: value, selector: null }
  return {
    ref: value.slice(0, index),
    selector: value.slice(index + 1),
  }
}

function selectorParts(selector) {
  const value = String(selector || "").trim()
  if (!value) return []
  if (value.startsWith("/")) {
    return value
      .split("/")
      .slice(1)
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
  }
  return value
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
}

function selectJsonValue(value, selector) {
  let current = value
  for (const part of selectorParts(selector)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) throw new Error("Invalid array selector segment: " + part)
      const index = Number(part)
      if (index < 0 || index >= current.length) throw new Error("Evidence selector index out of range: " + part)
      current = current[index]
      continue
    }
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) {
      throw new Error("Evidence selector path not found: " + part)
    }
    current = current[part]
  }
  return current
}

export async function getEvidenceSelected(root, refWithSelector, options = {}) {
  const split = evidenceSelector(refWithSelector)
  if (!split.selector) return getEvidence(root, split.ref, options)

  const hash = normalizeHash(split.ref)
  const target = evidencePaths(root, hash)
  const metadata = JSON.parse(await readFile(target.meta, "utf8"))
  if (metadata.encoding !== "utf8" || !String(metadata.mediaType || "").includes("json")) {
    throw new Error("Evidence selectors require JSON evidence")
  }

  const maxObjectBytes = Math.max(1024, Math.min(16 * 1024 * 1024, Number(options.maxObjectBytes || 4 * 1024 * 1024)))
  if (Number(metadata.bytes || 0) > maxObjectBytes) {
    throw new Error("JSON evidence is too large for selector retrieval; use byte slices instead")
  }
  const source = await readFile(target.data, "utf8")
  const selected = selectJsonValue(JSON.parse(source), split.selector)
  const encoded = typeof selected === "string"
    ? selected
    : JSON.stringify(stableValue(selected), null, 2)
  const maxBytes = Math.max(1, Number(options.maxBytes || options.maxChars || 24_000))
  const bytes = Buffer.from(encoded, "utf8")
  const start = Math.max(0, Number(options.start || 0))
  const slice = bytes.subarray(start, Math.min(bytes.length, start + maxBytes))
  return {
    ...metadata,
    ref: split.ref + "#" + split.selector,
    selector: split.selector,
    selectedBytes: bytes.length,
    truncated: start + slice.length < bytes.length,
    start,
    returnedBytes: slice.length,
    content: slice.toString("utf8"),
  }
}

async function metadataFiles(root) {
  const base = evidenceStoreRoot(root)
  const prefixes = await readdir(base, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue
    const dir = path.join(base, prefix.name)
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith(".json")) files.push(path.join(dir, entry.name))
    }
  }
  return files
}

export async function evidenceStoreStatus(root = process.cwd()) {
  const files = await metadataFiles(root)
  let bytes = 0
  let oldest = null
  let newest = null
  for (const file of files) {
    const meta = JSON.parse(await readFile(file, "utf8").catch(() => "{}"))
    bytes += Number(meta.bytes || 0)
    if (meta.createdAt && (!oldest || meta.createdAt < oldest)) oldest = meta.createdAt
    if (meta.lastSeenAt && (!newest || meta.lastSeenAt > newest)) newest = meta.lastSeenAt
  }
  return {
    schemaVersion: STORE_VERSION,
    root: evidenceStoreRoot(root),
    entries: files.length,
    bytes,
    oldest,
    newest,
  }
}

async function gcEvidenceStoreUnlocked(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const files = await metadataFiles(root)
  const defaults = defaultStoreLimits()
  const maxEntries = Math.max(10, Number(options.maxEntries ?? defaults.maxEntries))
  const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes ?? defaults.maxBytes))
  const maxAgeMs = Math.max(0, Number(options.maxAgeDays ?? defaults.maxAgeDays)) * 86_400_000
  const now = Date.now()
  const protectedHashes = await protectedEvidenceHashes(root, {
    memory: options.protectMemoryRefs !== false,
    activeWork: options.protectActiveWorkRefs !== false,
  })
  const rows = []
  for (const metaFile of files) {
    const meta = JSON.parse(await readFile(metaFile, "utf8").catch(() => "{}"))
    const time = Date.parse(meta.lastSeenAt || meta.createdAt || 0) || 0
    rows.push({ metaFile, meta, time, bytes: Math.max(0, Number(meta.bytes || 0)) })
  }
  rows.sort((a, b) => b.time - a.time)

  const removed = []
  let retainedEntries = 0
  let retainedBytes = 0
  let protectedEntries = 0
  let protectedBytes = 0
  for (const row of rows) {
    const hash = normalizeHash(row.meta.sha256 || path.basename(row.metaFile, ".json"))
    const protectedByDurableRef = protectedHashes.has(hash)
    const protectedByContextGrace =
      CONTEXT_GRACE_KINDS.has(String(row.meta.kind || "")) &&
      row.time > 0 &&
      now - row.time <= ACTIVE_CONTEXT_GRACE_MS
    const protectedRow = protectedByDurableRef || protectedByContextGrace
    const tooMany = retainedEntries >= maxEntries
    const tooOld = maxAgeMs > 0 && row.time > 0 && now - row.time > maxAgeMs
    const tooLarge = retainedBytes + row.bytes > maxBytes
    if (protectedRow || (!tooMany && !tooOld && !tooLarge)) {
      retainedEntries += 1
      retainedBytes += row.bytes
      if (protectedRow) {
        protectedEntries += 1
        protectedBytes += row.bytes
      }
      continue
    }
    const target = evidencePaths(root, hash)
    await rm(target.meta, { force: true })
    await rm(target.data, { force: true })
    removed.push(evidenceReference(hash))
  }

  return {
    removed,
    removedCount: removed.length,
    retainedEntries,
    retainedBytes,
    protectedEntries,
    protectedBytes,
    limits: { maxEntries, maxBytes, maxAgeMs },
    status: await evidenceStoreStatus(root),
  }
}


export async function gcEvidenceStore(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  return withStoreMutationLock(root, () => gcEvidenceStoreUnlocked(root, options))
}

export async function evidenceExists(root, ref) {
  try {
    const target = evidencePaths(root, normalizeHash(ref))
    const info = await stat(target.data)
    return info.isFile()
  } catch {
    return false
  }
}