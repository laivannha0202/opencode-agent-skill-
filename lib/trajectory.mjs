import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const TRACE_DIR = ".ues-traces"
const MAX_EVENT_BYTES = 64 * 1024
const DEFAULT_MAX_TRACE_FILE_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_TRACE_TOTAL_BYTES = 24 * 1024 * 1024
const DEFAULT_MAX_TRACE_FILES = 32
const DEFAULT_MAX_TRACE_AGE_MS = 7 * 86_400_000

const TRACE_WRITE_TAILS = new Map()

async function withTraceWriteLock(root, fn) {
  const key = path.resolve(root)
  const previous = TRACE_WRITE_TAILS.get(key) || Promise.resolve()
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => barrier)
  TRACE_WRITE_TAILS.set(key, tail)

  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (TRACE_WRITE_TAILS.get(key) === tail) TRACE_WRITE_TAILS.delete(key)
  }
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function traceLimits(options = {}) {
  return {
    maxFileBytes: positiveInt(
      options.maxFileBytes ?? process.env.UES_TRACE_MAX_FILE_BYTES,
      DEFAULT_MAX_TRACE_FILE_BYTES,
      256 * 1024,
      64 * 1024 * 1024,
    ),
    maxTotalBytes: positiveInt(
      options.maxTotalBytes ?? process.env.UES_TRACE_MAX_TOTAL_BYTES,
      DEFAULT_MAX_TRACE_TOTAL_BYTES,
      1024 * 1024,
      512 * 1024 * 1024,
    ),
    maxFiles: positiveInt(
      options.maxFiles ?? process.env.UES_TRACE_MAX_FILES,
      DEFAULT_MAX_TRACE_FILES,
      4,
      256,
    ),
    maxAgeMs: positiveInt(
      options.maxAgeMs ?? process.env.UES_TRACE_MAX_AGE_MS,
      DEFAULT_MAX_TRACE_AGE_MS,
      60_000,
      90 * 86_400_000,
    ),
  }
}

async function compactTraceFile(file, maxFileBytes) {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size < maxFileBytes) return false

  const source = await readFile(file)
  const keepBytes = Math.max(128 * 1024, Math.floor(maxFileBytes / 2))
  let kept = source.subarray(Math.max(0, source.length - keepBytes))
  const newline = kept.indexOf(0x0a)
  if (newline >= 0 && source.length > keepBytes) kept = kept.subarray(newline + 1)
  const marker = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    type: "trace.compacted",
    at: new Date().toISOString(),
    payload: { previousBytes: source.length, retainedBytes: kept.length },
  }) + "\n")
  await writeFile(file, Buffer.concat([marker, kept]))
  return true
}

export async function pruneTrajectoryStore(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const dir = path.join(root, TRACE_DIR)
  const limits = traceLimits(options)
  const protect = options.protectTraceID ? cleanID(options.protectTraceID) + ".jsonl" : null
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    const file = path.join(dir, entry.name)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) continue
    rows.push({ name: entry.name, file, bytes: info.size, mtimeMs: info.mtimeMs })
  }

  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let retainedBytes = 0
  let retainedFiles = 0
  const removed = []
  const now = Date.now()

  for (const row of rows) {
    if (row.name === protect) {
      retainedBytes += row.bytes
      retainedFiles += 1
      continue
    }
    const expired = limits.maxAgeMs > 0 && now - row.mtimeMs > limits.maxAgeMs
    const overFiles = retainedFiles >= limits.maxFiles
    const overBytes = retainedBytes + row.bytes > limits.maxTotalBytes
    if (expired || overFiles || overBytes) {
      await rm(row.file, { force: true }).catch(() => {})
      removed.push(row.name)
      continue
    }
    retainedBytes += row.bytes
    retainedFiles += 1
  }

  return {
    removed,
    removedCount: removed.length,
    retainedFiles,
    retainedBytes,
    limits,
  }
}

function cleanID(value) {
  const text = String(value || "").trim()
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(text)) return text
  return "trace-" + randomUUID()
}

function redactString(value) {
  let text = String(value)
  const patterns = [
    [/(authorization\s*[:=]\s*bearer\s+)[^\s"'\\]+/gi, "$1[REDACTED]"],
    [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_OPENAI_KEY]"],
    [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\b(npm_[A-Za-z0-9]{20,})\b/g, "[REDACTED_NPM_TOKEN]"],
    [/((?:api[_-]?key|token|secret|password|passwd|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[REDACTED]"],
  ]
  for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement)
  return text
}

export function scrubTrajectoryValue(value, depth = 0) {
  if (depth > 12) return "[TRUNCATED_DEPTH]"
  if (typeof value === "string") return redactString(value)
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => scrubTrajectoryValue(item, depth + 1))
  if (!value || typeof value !== "object") return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (/^(authorization|cookie|set-cookie|api[_-]?key|token|secret|password|passwd|credential)$/i.test(key)) {
      result[key] = "[REDACTED]"
      continue
    }
    result[key] = scrubTrajectoryValue(child, depth + 1)
  }
  return result
}

export function createTraceID(prefix = "run") {
  return cleanID(prefix + "-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8))
}

export function trajectoryFile(root, traceID) {
  return path.join(path.resolve(root), TRACE_DIR, cleanID(traceID) + ".jsonl")
}

async function appendTrajectoryEventUnlocked(root, traceID, type, payload = {}) {
  root = path.resolve(root)
  const file = trajectoryFile(root, traceID)
  await mkdir(path.dirname(file), { recursive: true })
  const limits = traceLimits()
  await compactTraceFile(file, limits.maxFileBytes).catch(() => false)
  await pruneTrajectoryStore(root, { ...limits, protectTraceID: traceID }).catch(() => null)
  const scrubbed = scrubTrajectoryValue(payload)
  const rawPayload = JSON.stringify(scrubbed)
  const bounded = Buffer.byteLength(rawPayload, "utf8") <= MAX_EVENT_BYTES
    ? scrubbed
    : {
        truncated: true,
        sha256: createHash("sha256").update(rawPayload).digest("hex"),
        preview: redactString(rawPayload.slice(0, MAX_EVENT_BYTES - 1024)),
      }
  const event = {
    schemaVersion: 1,
    id: randomUUID(),
    traceID: cleanID(traceID),
    type: String(type || "event"),
    at: new Date().toISOString(),
    payload: bounded,
  }
  await writeFile(file, JSON.stringify(event) + "\n", { encoding: "utf8", flag: "a" })
  return { file: path.relative(path.resolve(root), file).replaceAll("\\", "/"), event }
}

export async function appendTrajectoryEvent(root, traceID, type, payload = {}) {
  root = path.resolve(root)
  return withTraceWriteLock(root, () => appendTrajectoryEventUnlocked(root, traceID, type, payload))
}

export async function readTrajectory(root, traceID, options = {}) {
  const file = trajectoryFile(root, traceID)
  const source = await readFile(file, "utf8").catch(() => "")
  const limit = Math.max(1, Math.min(Number(options.limit || 200), 2000))
  const events = source.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  return {
    traceID: cleanID(traceID),
    file: path.relative(path.resolve(root), file).replaceAll("\\", "/"),
    events: events.slice(-limit),
    total: events.length,
    note: "Operational prompts/actions/observations only; hidden chain-of-thought is never recorded.",
  }
}
