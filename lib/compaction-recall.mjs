import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { appendRuntimeEvent, readRuntimeEvents } from "./runtime-events.mjs"

const DIR = ".ues-learning"
const FILE = "compaction-recall-v1.jsonl"

function cleanRef(value) { return String(value || "").trim().slice(0, 256) }
function boundedInt(value, fallback = 0, max = 64 * 1024 * 1024) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(max, Math.trunc(number)))
}
function analyticsFile(root) { return path.join(path.resolve(root), DIR, FILE) }
async function append(root, type, data) {
  const file = analyticsFile(root)
  await mkdir(path.dirname(file), { recursive: true })
  return appendRuntimeEvent(file, type, data)
}

export async function recordCompaction(root, input = {}) {
  const ref = cleanRef(input.ref)
  if (!ref) return null
  return append(root, "compaction.created", {
    schemaVersion: 1, ref,
    reducer: String(input.reducer || input.family || "generic").slice(0, 120),
    level: input.level ? String(input.level).slice(0, 32) : null,
    rawChars: boundedInt(input.rawChars),
    returnedChars: boundedInt(input.returnedChars),
    savedChars: Math.max(0, boundedInt(input.rawChars) - boundedInt(input.returnedChars)),
    sourceHash: input.source
      ? createHash("sha256").update(String(input.source)).digest("hex")
      : null,
  })
}

export async function recordCompactionRecall(root, input = {}) {
  const ref = cleanRef(input.ref)
  if (!ref) return null
  const query = input.query == null ? "" : String(input.query)
  return append(root, "compaction.recalled", {
    schemaVersion: 1, ref,
    kind: String(input.kind || "expand").slice(0, 32),
    start: boundedInt(input.start),
    returnedBytes: boundedInt(input.returnedBytes),
    queryHash: query ? createHash("sha256").update(query).digest("hex") : null,
  })
}

export async function readCompactionRecallEvents(root = process.cwd(), options = {}) {
  return readRuntimeEvents(analyticsFile(root), { limit: Math.max(1, Math.min(5000, Number(options.limit || 1000))) })
}

export function summarizeCompactionRecallRows(rows = []) {
  const created = new Map()
  const recalls = new Map()
  for (const row of rows || []) {
    if (row?.type === "compaction.created" && row.ref) { created.set(row.ref, row); continue }
    if (row?.type !== "compaction.recalled" || !row.ref) continue
    const state = recalls.get(row.ref) || { ref: row.ref, firstRecallAt: row.at || null, totalRecalls: 0, expandedBytes: 0, searchRequests: 0 }
    state.totalRecalls += 1
    state.expandedBytes += boundedInt(row.returnedBytes)
    if (row.kind === "search") state.searchRequests += 1
    recalls.set(row.ref, state)
  }
  const byReducer = {}
  for (const [ref, row] of created) {
    const reducer = String(row.reducer || "generic")
    const bucket = byReducer[reducer] || { compacted: 0, recalled: 0, rawChars: 0, returnedChars: 0, savedChars: 0, expandedBytes: 0 }
    bucket.compacted += 1
    bucket.rawChars += boundedInt(row.rawChars)
    bucket.returnedChars += boundedInt(row.returnedChars)
    bucket.savedChars += boundedInt(row.savedChars)
    if (recalls.has(ref)) { bucket.recalled += 1; bucket.expandedBytes += recalls.get(ref).expandedBytes }
    byReducer[reducer] = bucket
  }
  for (const bucket of Object.values(byReducer)) bucket.recallDemandRate = bucket.compacted ? bucket.recalled / bucket.compacted : 0
  const recalledRefs = [...recalls.keys()].filter((ref) => created.has(ref)).length
  return {
    schemaVersion: 1, compactedRefs: created.size, recalledRefs,
    recallDemandRate: created.size ? recalledRefs / created.size : null,
    totalRecallEvents: [...recalls.values()].reduce((sum, row) => sum + row.totalRecalls, 0),
    byReducer,
  }
}

export async function summarizeCompactionRecall(root = process.cwd(), options = {}) {
  return summarizeCompactionRecallRows(await readCompactionRecallEvents(root, options))
}
