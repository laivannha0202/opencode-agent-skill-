import { randomUUID } from "node:crypto"
import { appendFile, readFile, stat, writeFile } from "node:fs/promises"

const DEFAULT_MAX_EVENT_FILE_BYTES = 4 * 1024 * 1024
const DEFAULT_RETAIN_EVENT_BYTES = 2 * 1024 * 1024

const EVENT_WRITE_TAILS = new Map()

async function withEventWriteLock(file, fn) {
  const key = String(file)
  const previous = EVENT_WRITE_TAILS.get(key) || Promise.resolve()
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => barrier)
  EVENT_WRITE_TAILS.set(key, tail)

  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (EVENT_WRITE_TAILS.get(key) === tail) EVENT_WRITE_TAILS.delete(key)
  }
}

async function compactRuntimeEventFile(file, options = {}) {
  const maxBytes = Math.max(
    256 * 1024,
    Math.min(64 * 1024 * 1024, Number(options.maxBytes || process.env.UES_EVENT_LOG_MAX_BYTES || DEFAULT_MAX_EVENT_FILE_BYTES)),
  )
  const retainBytes = Math.max(
    128 * 1024,
    Math.min(maxBytes, Number(options.retainBytes || DEFAULT_RETAIN_EVENT_BYTES)),
  )
  const info = await stat(file).catch(() => null)
  if (!info?.isFile() || info.size < maxBytes) return false

  const raw = await readFile(file)
  let kept = raw.subarray(Math.max(0, raw.length - retainBytes))
  const newline = kept.indexOf(0x0a)
  if (newline >= 0 && raw.length > retainBytes) kept = kept.subarray(newline + 1)
  const marker = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    id: randomUUID(),
    type: "runtime-events.compacted",
    at: new Date().toISOString(),
    previousBytes: raw.length,
    retainedBytes: kept.length,
  }) + "\n")
  await writeFile(file, Buffer.concat([marker, kept]))
  return true
}

export async function appendRuntimeEvent(file, type, data = {}) {
  return withEventWriteLock(file, async () => {
    await compactRuntimeEventFile(file).catch(() => false)
    const event = {
      schemaVersion: 1,
      id: randomUUID(),
      type: String(type || "unknown"),
      at: new Date().toISOString(),
      ...data,
    }
    await appendFile(file, JSON.stringify(event) + "\n", "utf8")
    return event
  })
}

export async function readRuntimeEvents(file, options = {}) {
  const requested = Number(options.limit)
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.max(1, Math.min(Math.trunc(requested), 5000))
    : 200
  const raw = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return ""
    throw error
  })
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const events = []
  for (const line of lines.slice(-limit)) {
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}
