import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { evidenceExists, putEvidence } from "./evidence-store.mjs"

const MEMORY_DIR = ".ues-memory"
const MEMORY_FILE = "MEMORY.json"
const SCHEMA_VERSION = 1
const VALID_TYPES = new Set(["episodic", "semantic", "procedural", "failure", "decision"])
const VALID_SCOPES = new Set(["global", "project", "module", "file"])
const STOP = new Set([
  "this","that","with","from","into","then","than","when","where","what","your","have","will","task","code",
  "file","files","change","changes","được","các","cho","với","trong","này","một","những","không","theo",
])

function now() {
  return new Date().toISOString()
}

function clamp(value, fallback = 0.7) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback
}

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))]
}

function normalizeFile(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "")
}

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$.-]+/u)
    .map((item) => item.replace(/^[-.$]+|[-.$]+$/g, ""))
    .filter((item) => item.length >= 2 && !STOP.has(item))
}

function normalizedContent(value) {
  return String(value || "").trim().replace(/\s+/g, " ")
}

function idFor(input) {
  const key = input.key || [
    input.scope || "project",
    input.type || "episodic",
    normalizedContent(input.content),
  ].join(":")
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 20)
}

function memoryPath(root) {
  return path.join(path.resolve(root), MEMORY_DIR, MEMORY_FILE)
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp"
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8")
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export async function readMemoryState(root = process.cwd()) {
  const file = memoryPath(root)
  if (!existsSync(file)) {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: null, memories: [] }
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: parsed.updatedAt || null,
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    }
  } catch {
    return { schemaVersion: SCHEMA_VERSION, updatedAt: null, memories: [], invalid: true }
  }
}

async function writeMemoryState(root, memories) {
  const state = { schemaVersion: SCHEMA_VERSION, updatedAt: now(), memories }
  await atomicJson(memoryPath(root), state)
  return state
}

export async function proposeMemory(root, input = {}) {
  const content = normalizedContent(input.content)
  if (!content) throw new Error("memory content is required")
  const type = VALID_TYPES.has(input.type) ? input.type : "episodic"
  const scope = VALID_SCOPES.has(input.scope) ? input.scope : "project"
  const state = await readMemoryState(root)
  const id = idFor({ ...input, type, scope, content })
  const timestamp = now()
  const existing = state.memories.find((item) => item.id === id)
  if (existing) {
    const reinforced = {
      ...existing,
      lastSeenAt: timestamp,
      reinforcementCount: Number(existing.reinforcementCount || 1) + 1,
      evidenceRefs: uniq([...(existing.evidenceRefs || []), ...(input.evidenceRefs || [])]),
      files: uniq([...(existing.files || []), ...(input.files || []).map(normalizeFile)]),
      tags: uniq([...(existing.tags || []), ...(input.tags || [])]),
      confidence: Math.max(clamp(existing.confidence), clamp(input.confidence, existing.confidence ?? 0.7)),
    }
    await writeMemoryState(root, state.memories.map((item) => item.id === id ? reinforced : item))
    return reinforced
  }

  const memory = {
    id,
    key: input.key || null,
    type,
    scope,
    content,
    status: "candidate",
    confidence: clamp(input.confidence),
    evidenceRefs: uniq(input.evidenceRefs || []),
    files: uniq((input.files || []).map(normalizeFile)),
    tags: uniq(input.tags || []),
    sourceTask: input.sourceTask || null,
    sourceCommit: input.sourceCommit || null,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    reinforcementCount: 1,
    verifiedAt: null,
    verifier: null,
    supersededBy: null,
  }
  await writeMemoryState(root, [...state.memories, memory])
  return memory
}

export async function verifyMemory(root, id, verification = {}) {
  if (String(verification.verdict || "").toUpperCase() !== "PASS") {
    throw new Error("memory verification requires verdict PASS")
  }
  if (!verification.verifier) throw new Error("memory verification requires an independent verifier identity")
  const state = await readMemoryState(root)
  const current = state.memories.find((item) => item.id === id)
  if (!current) throw new Error("unknown memory: " + id)
  if (current.status === "superseded") throw new Error("cannot verify a superseded memory")

  const refs = uniq([...(current.evidenceRefs || []), ...(verification.evidenceRefs || [])])
  if (!refs.length) throw new Error("memory verification requires at least one durable evidence reference")
  for (const ref of refs) {
    if (!(await evidenceExists(root, ref))) throw new Error("memory evidence reference is missing: " + ref)
  }

  const verified = {
    ...current,
    status: "verified",
    evidenceRefs: refs,
    verifier: String(verification.verifier),
    verifiedAt: now(),
    lastSeenAt: now(),
    confidence: Math.max(clamp(current.confidence), clamp(verification.confidence, current.confidence ?? 0.7)),
  }
  await writeMemoryState(root, state.memories.map((item) => item.id === id ? verified : item))
  return verified
}

export async function supersedeMemory(root, id, replacementId) {
  if (!replacementId || replacementId === id) throw new Error("replacement memory id must be different")
  const state = await readMemoryState(root)
  const current = state.memories.find((item) => item.id === id)
  const replacement = state.memories.find((item) => item.id === replacementId)
  if (!current) throw new Error("unknown memory: " + id)
  if (!replacement) throw new Error("unknown replacement memory: " + replacementId)
  if (replacement.status !== "verified") throw new Error("replacement memory must be verified before supersession")
  const timestamp = now()
  const superseded = {
    ...current,
    status: "superseded",
    supersededBy: replacementId,
    lastSeenAt: timestamp,
  }
  await writeMemoryState(root, state.memories.map((item) => item.id === id ? superseded : item))
  return superseded
}

function tokenVector(value, dims = 96) {
  const vector = new Array(dims).fill(0)
  for (const token of tokens(value)) {
    let hash = 2166136261
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index)
      hash = Math.imul(hash, 16777619) >>> 0
    }
    const slot = hash % dims
    const sign = (hash & 0x100) === 0 ? 1 : -1
    vector[slot] += sign
  }
  return vector
}

function cosine(a, b) {
  let dot = 0
  let left = 0
  let right = 0
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index]
    left += a[index] * a[index]
    right += b[index] * b[index]
  }
  return left && right ? dot / Math.sqrt(left * right) : 0
}

function bm25Scores(memories, queryTokens) {
  const docs = memories.map((item) => tokens([item.content, ...(item.tags || []), ...(item.files || [])].join(" ")))
  const avgLength = docs.length ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 1
  const df = new Map()
  for (const term of queryTokens) {
    df.set(term, docs.reduce((count, doc) => count + (doc.includes(term) ? 1 : 0), 0))
  }
  const k1 = 1.2
  const b = 0.75
  return docs.map((doc) => {
    const counts = new Map()
    for (const token of doc) counts.set(token, (counts.get(token) || 0) + 1)
    let score = 0
    for (const term of queryTokens) {
      const tf = counts.get(term) || 0
      if (!tf) continue
      const freq = df.get(term) || 0
      const idf = Math.log(1 + (memories.length - freq + 0.5) / (freq + 0.5))
      const denom = tf + k1 * (1 - b + b * (doc.length / Math.max(1, avgLength)))
      score += idf * ((tf * (k1 + 1)) / denom)
    }
    return score
  })
}

function commonPrefixParts(left, right) {
  const a = normalizeFile(left).split("/")
  const b = normalizeFile(right).split("/")
  let count = 0
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1
  return count
}

function graphAffinity(queryFiles, memoryFiles) {
  if (!queryFiles.length || !memoryFiles.length) return 0
  let best = 0
  for (const left of queryFiles) {
    for (const right of memoryFiles) {
      if (left === right) best = Math.max(best, 1)
      else {
        const common = commonPrefixParts(left, right)
        if (common >= 2) best = Math.max(best, 0.8)
        else if (common === 1) best = Math.max(best, 0.45)
      }
    }
  }
  return best
}

function recencyScore(value) {
  const timestamp = Date.parse(value || "")
  if (!timestamp) return 0
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000)
  return 1 / (1 + ageDays / 30)
}

function rankMap(rows, key) {
  return new Map(
    [...rows]
      .filter((row) => Number(row[key]) > 0)
      .sort((a, b) => b[key] - a[key] || a.item.id.localeCompare(b.item.id))
      .map((row, index) => [row.item.id, index + 1]),
  )
}

export async function retrieveMemories(root, query, options = {}) {
  const state = await readMemoryState(root)
  const memories = state.memories.filter((item) => item.status === "verified" && !item.supersededBy)
  const queryTokens = uniq(tokens(query))
  const queryVector = tokenVector(query)
  const queryFiles = uniq((options.files || []).map(normalizeFile))
  const lexical = bm25Scores(memories, queryTokens)
  const rows = memories.map((item, index) => ({
    item,
    lexical: lexical[index] || 0,
    semantic: Math.max(0, cosine(queryVector, tokenVector(item.content))),
    graph: graphAffinity(queryFiles, item.files || []),
    recency: recencyScore(item.lastSeenAt || item.verifiedAt || item.createdAt),
    confidence: clamp(item.confidence),
  }))
  const ranks = {
    lexical: rankMap(rows, "lexical"),
    semantic: rankMap(rows, "semantic"),
    graph: rankMap(rows, "graph"),
    recency: rankMap(rows, "recency"),
  }
  for (const row of rows) {
    let rrf = 0
    for (const key of ["lexical", "semantic", "graph", "recency"]) {
      const rank = ranks[key].get(row.item.id)
      if (rank) rrf += 1 / (60 + rank)
    }
    row.score = rrf + row.confidence * 0.01 + row.graph * 0.01
  }
  const limit = Math.max(1, Math.min(Number(options.limit || 6), 30))
  const results = rows
    .filter((row) => row.lexical > 0 || row.semantic > 0.05 || row.graph > 0)
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.item.id.localeCompare(b.item.id))
    .slice(0, limit)
    .map((row) => ({
      ...row.item,
      retrieval: {
        score: Number(row.score.toFixed(8)),
        lexical: Number(row.lexical.toFixed(6)),
        semantic: Number(row.semantic.toFixed(6)),
        graph: Number(row.graph.toFixed(6)),
        recency: Number(row.recency.toFixed(6)),
      },
    }))
  return {
    schemaVersion: SCHEMA_VERSION,
    query: String(query || ""),
    eligible: memories.length,
    results,
  }
}

export async function memoryStatus(root = process.cwd()) {
  const state = await readMemoryState(root)
  const byStatus = {}
  const byType = {}
  for (const memory of state.memories) {
    byStatus[memory.status] = (byStatus[memory.status] || 0) + 1
    byType[memory.type] = (byType[memory.type] || 0) + 1
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    root: path.dirname(memoryPath(root)),
    updatedAt: state.updatedAt,
    entries: state.memories.length,
    byStatus,
    byType,
  }
}

function changedFiles(root) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: path.resolve(root),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) return []
  return uniq(
    String(result.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1) : value)
      .map(normalizeFile),
  ).slice(0, 80)
}

function compactVerification(value, limit = 1200) {
  const text = String(value || "").replace(/\s+/g, " ").trim()
  return text.length <= limit ? text : text.slice(0, limit) + "...[truncated]"
}

export async function recordVerifiedTaskMemory(root, input = {}) {
  const task = normalizedContent(input.task)
  if (!task) throw new Error("verified task memory requires task text")
  const files = uniq([...(input.files || []).map(normalizeFile), ...changedFiles(root)])
  const verifier = input.verifier || "ues-verifier"
  const verificationSummary = compactVerification(input.verifierOutput)
  const integrationSummary = compactVerification(input.integrationOutput)
  const evidence = await putEvidence(root, {
    schemaVersion: 1,
    kind: "verified-task-memory-receipt",
    task,
    verifier,
    files,
    verification: verificationSummary,
    integration: integrationSummary || null,
    recordedAt: now(),
  }, {
    kind: "verified-task-memory",
    source: input.sourceTask || task.slice(0, 200),
    summary: "Verified task outcome eligible for persistent memory",
  })
  const content = [
    `Verified engineering task: ${task}`,
    files.length ? `Files: ${files.join(", ")}` : "",
    verificationSummary ? `Verification: ${verificationSummary}` : "",
  ].filter(Boolean).join("\n")
  const candidate = await proposeMemory(root, {
    key: input.key || `verified-task:${task}:${files.slice().sort().join(",")}`,
    type: input.type || "episodic",
    scope: input.scope || "project",
    content,
    confidence: input.confidence ?? (integrationSummary ? 0.92 : 0.84),
    evidenceRefs: [evidence.ref],
    files,
    tags: uniq(["verified-task", ...(input.tags || [])]),
    sourceTask: input.sourceTask || task,
    sourceCommit: input.sourceCommit || null,
  })
  return verifyMemory(root, candidate.id, {
    verdict: "PASS",
    verifier,
    evidenceRefs: [evidence.ref],
    confidence: candidate.confidence,
  })
}
