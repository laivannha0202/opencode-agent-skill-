import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"

const LEARNING_DIR = ".ues-learning"
const STATE_FILE = "LEARNINGS.json"

function idFor(type, key) {
  return createHash("sha256").update(type + ":" + key).digest("hex").slice(0, 16)
}

async function walkJson(dir, limit = 500) {
  const files = []
  async function visit(current) {
    if (files.length >= limit) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= limit) break
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full)
    }
  }
  await visit(dir)
  return files
}

function proposal(type, key, title, evidence, recommendation) {
  return { id: idFor(type, key), type, key, title, evidence, recommendation, status: "proposed" }
}

export async function analyzeEvalTraces(evalDir) {
  const files = await walkJson(path.resolve(evalDir))
  const results = []
  for (const file of files) {
    try {
      const payload = JSON.parse(await readFile(file, "utf8"))
      for (const item of payload.results || []) results.push({ ...item, source: file })
    } catch {}
  }

  const counters = new Map()
  const bump = (key, item) => {
    const value = counters.get(key) || { count: 0, tasks: new Set(), modes: new Set() }
    value.count += 1
    if (item.task) value.tasks.add(item.task)
    if (item.mode) value.modes.add(item.mode)
    counters.set(key, value)
  }

  for (const item of results) {
    if (item.timedOut) bump("hard-timeout", item)
    if (item.idleTimedOut) bump("idle-timeout", item)
    if (Number(item.agentExit) !== 0) bump("agent-exit", item)
    if (Number(item.graderExit) !== 0) bump("grader-failure", item)
    if (item.orchestration?.required && !item.orchestration?.valid) bump("orchestration-failure", item)
    if ((item.telemetry?.parseErrors || 0) > 0) bump("telemetry-parse-errors", item)
  }

  const proposals = []
  for (const [key, value] of counters) {
    if (value.count < 1) continue
    const details = {
      count: value.count,
      tasks: [...value.tasks].sort(),
      modes: [...value.modes].sort(),
      samples: results.length,
    }
    const recommendations = {
      "hard-timeout": "Inspect task decomposition and model/runtime latency; shorten tasks or raise a justified hard timeout.",
      "idle-timeout": "Inspect tool/session deadlocks and add progress-producing boundaries or recovery.",
      "agent-exit": "Classify process/provider failures before retrying; avoid blind model escalation.",
      "grader-failure": "Mine failing task contracts for missing domain guidance or context selection, then add a regression before changing skills.",
      "orchestration-failure": "Strengthen durable workflow instructions/gates or runtime support; do not count direct patches as UES success.",
      "telemetry-parse-errors": "Update telemetry parsing against the observed OpenCode event shape with a fixture-backed test.",
    }
    proposals.push(proposal(
      "eval-pattern",
      key,
      "Recurring evaluation pattern: " + key,
      details,
      recommendations[key] || "Review the repeated pattern and add a regression before promoting a reusable lesson.",
    ))
  }

  return {
    schemaVersion: 1,
    analyzedAt: new Date().toISOString(),
    files: files.length,
    results: results.length,
    proposals: proposals.sort((a, b) => b.evidence.count - a.evidence.count || a.key.localeCompare(b.key)),
  }
}

export function learningFile(root) {
  return path.join(path.resolve(root), LEARNING_DIR, STATE_FILE)
}

export async function readLearningState(root) {
  const file = learningFile(root)
  if (!existsSync(file)) return { schemaVersion: 1, updatedAt: null, proposals: [], accepted: [] }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return {
      schemaVersion: 1,
      updatedAt: parsed.updatedAt || null,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      accepted: Array.isArray(parsed.accepted) ? parsed.accepted : [],
    }
  } catch {
    return { schemaVersion: 1, updatedAt: null, proposals: [], accepted: [], invalid: true }
  }
}

export async function saveLearningAnalysis(root, analysis) {
  const dir = path.dirname(learningFile(root))
  await mkdir(dir, { recursive: true })
  const current = await readLearningState(root)
  const acceptedIDs = new Set(current.accepted.map((item) => item.id))
  const proposals = analysis.proposals.filter((item) => !acceptedIDs.has(item.id))
  const next = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    proposals,
    accepted: current.accepted,
  }
  await writeFile(learningFile(root), JSON.stringify(next, null, 2) + "\n", "utf8")
  return next
}

export async function acceptLearning(root, id) {
  const current = await readLearningState(root)
  const item = current.proposals.find((entry) => entry.id === id)
  if (!item) throw new Error("unknown learning proposal: " + id)
  const accepted = { ...item, status: "accepted", acceptedAt: new Date().toISOString() }
  const next = {
    schemaVersion: 1,
    updatedAt: accepted.acceptedAt,
    proposals: current.proposals.filter((entry) => entry.id !== id),
    accepted: [...current.accepted.filter((entry) => entry.id !== id), accepted],
  }
  await mkdir(path.dirname(learningFile(root)), { recursive: true })
  await writeFile(learningFile(root), JSON.stringify(next, null, 2) + "\n", "utf8")
  return accepted
}

export async function relevantAcceptedLearnings(root, text, limit = 5) {
  const state = await readLearningState(root)
  const terms = new Set(String(text || "").toLowerCase().split(/[^a-z0-9_-]+/).filter((term) => term.length >= 4))
  return state.accepted
    .map((item) => {
      const haystack = JSON.stringify(item).toLowerCase()
      const score = [...terms].reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0)
      return { item, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item)
}
