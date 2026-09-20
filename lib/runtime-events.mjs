import { randomUUID } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"

export async function appendRuntimeEvent(file, type, data = {}) {
  const event = {
    schemaVersion: 1,
    id: randomUUID(),
    type: String(type || "unknown"),
    at: new Date().toISOString(),
    ...data,
  }
  await appendFile(file, JSON.stringify(event) + "\n", "utf8")
  return event
}

export async function readRuntimeEvents(file, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 200), 5000))
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
