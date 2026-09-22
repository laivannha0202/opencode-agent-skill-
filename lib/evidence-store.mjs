import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const STORE_VERSION = 1
const REF_PREFIX = "evidence:sha256:"

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
  await mkdir(target.dir, { recursive: true })

  const now = new Date().toISOString()
  const existing = existsSync(target.meta)
    ? JSON.parse(await readFile(target.meta, "utf8").catch(() => "{}"))
    : null

  if (!existsSync(target.data)) await writeFile(target.data, encoded.bytes)

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
  await writeFile(target.meta, JSON.stringify(metadata, null, 2) + "\n", "utf8")
  return metadata
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

export async function gcEvidenceStore(root = process.cwd(), options = {}) {
  const files = await metadataFiles(root)
  const maxEntries = Math.max(10, Number(options.maxEntries || 2_000))
  const maxAgeMs = Math.max(0, Number(options.maxAgeDays ?? 30)) * 86_400_000
  const now = Date.now()
  const rows = []
  for (const metaFile of files) {
    const meta = JSON.parse(await readFile(metaFile, "utf8").catch(() => "{}"))
    const time = Date.parse(meta.lastSeenAt || meta.createdAt || 0) || 0
    rows.push({ metaFile, meta, time })
  }
  rows.sort((a, b) => b.time - a.time)

  const removed = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const tooMany = index >= maxEntries
    const tooOld = maxAgeMs > 0 && row.time > 0 && now - row.time > maxAgeMs
    if (!tooMany && !tooOld) continue
    const hash = row.meta.sha256 || path.basename(row.metaFile, ".json")
    const target = evidencePaths(root, hash)
    await rm(target.meta, { force: true })
    await rm(target.data, { force: true })
    removed.push(evidenceReference(hash))
  }

  return {
    removed,
    removedCount: removed.length,
    status: await evidenceStoreStatus(root),
  }
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
