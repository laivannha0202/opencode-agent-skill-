import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const TRACE_DIR = ".ues-traces"
const MAX_EVENT_BYTES = 64 * 1024

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

export async function appendTrajectoryEvent(root, traceID, type, payload = {}) {
  const file = trajectoryFile(root, traceID)
  await mkdir(path.dirname(file), { recursive: true })
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
