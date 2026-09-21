import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { pairedBenchmarkConfidence } from "./benchmark-confidence.mjs"

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

function failureReasons(item) {
  const reasons = []
  if (item.timedOut) reasons.push("hard-timeout")
  if (item.idleTimedOut) reasons.push("idle-timeout")
  if (Number(item.agentExit) !== 0) reasons.push("agent-exit")
  if (Number(item.graderExit) !== 0) reasons.push("grader-failure")
  if (item.orchestration?.required && !item.orchestration?.valid) reasons.push("orchestration-failure")
  if ((item.telemetry?.parseErrors || 0) > 0) reasons.push("telemetry-parse-errors")
  return reasons
}

function recommendationFor(key) {
  const recommendations = {
    "hard-timeout": "Split oversized execution units or justify a larger bounded timeout; preserve cancellation and stale-run recovery.",
    "idle-timeout": "Inspect tool/session deadlocks and add observable progress boundaries or recovery paths.",
    "agent-exit": "Classify provider/process failures before retrying; avoid blind model escalation.",
    "grader-failure": "Mine the failed contract for missing context, routing or verification guidance and add a regression before promotion.",
    "orchestration-failure": "Strengthen durable workflow gates/runtime support; direct patches must not count as long-horizon success.",
    "telemetry-parse-errors": "Update telemetry parsing against the observed event shape with fixture-backed tests.",
  }
  return recommendations[key] || "Add a regression, test the candidate rule in shadow evaluation, and promote only on measured improvement."
}

function proposal(type, key, title, evidence, recommendation) {
  return {
    id: idFor(type, key),
    type,
    key,
    title,
    evidence,
    recommendation,
    candidateRule: recommendation,
    shadowRequired: true,
    status: "proposed",
  }
}

function clampRate(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null
}

export async function analyzeEvalTraces(evalDir) {
  const files = await walkJson(path.resolve(evalDir))
  const results = []
  for (const file of files) {
    try {
      const payload = JSON.parse(await readFile(file, "utf8"))
      for (const item of payload.results || []) {
        results.push({ ...item, source: file })
      }
    } catch {}
  }

  const reasonCounters = new Map()
  const clusters = new Map()

  const bump = (map, key, item) => {
    const value = map.get(key) || {
      count: 0,
      tasks: new Set(),
      modes: new Set(),
      suites: new Set(),
      sources: new Set(),
    }
    value.count += 1
    if (item.task) value.tasks.add(item.task)
    if (item.mode) value.modes.add(item.mode)
    if (item.suite) value.suites.add(item.suite)
    if (item.source) value.sources.add(item.source)
    map.set(key, value)
  }

  for (const item of results) {
    const reasons = failureReasons(item)
    for (const reason of reasons) bump(reasonCounters, reason, item)
    if (reasons.length) {
      const clusterKey = reasons.sort().join("+")
      bump(clusters, clusterKey, item)
    }
  }

  const proposals = []
  for (const [key, value] of reasonCounters) {
    const evidence = {
      count: value.count,
      tasks: [...value.tasks].sort(),
      modes: [...value.modes].sort(),
      sources: [...value.sources].sort().slice(0, 20),
      samples: results.length,
      confidence: results.length ? value.count / results.length : 0,
    }
    proposals.push(proposal(
      "eval-pattern",
      key,
      "Recurring evaluation pattern: " + key,
      evidence,
      recommendationFor(key),
    ))
  }

  for (const [key, value] of clusters) {
    if (value.count < 2) continue
    const primary = key.split("+")[0]
    const evidence = {
      count: value.count,
      tasks: [...value.tasks].sort(),
      modes: [...value.modes].sort(),
      sources: [...value.sources].sort().slice(0, 20),
      samples: results.length,
      confidence: results.length ? value.count / results.length : 0,
      signature: key,
    }
    proposals.push(proposal(
      "root-cause-cluster",
      key,
      "Repeated failure cluster: " + key,
      evidence,
      recommendationFor(primary),
    ))
  }

  return {
    schemaVersion: 2,
    analyzedAt: new Date().toISOString(),
    files: files.length,
    results: results.length,
    clusters: [...clusters.entries()]
      .map(([key, value]) => ({ key, count: value.count, tasks: [...value.tasks].sort() }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    proposals: proposals.sort((a, b) =>
      b.evidence.count - a.evidence.count || a.key.localeCompare(b.key),
    ),
  }
}

export function learningFile(root) {
  return path.join(path.resolve(root), LEARNING_DIR, STATE_FILE)
}

export async function readLearningState(root) {
  const file = learningFile(root)
  if (!existsSync(file)) {
    return { schemaVersion: 2, updatedAt: null, proposals: [], accepted: [] }
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return {
      schemaVersion: 2,
      updatedAt: parsed.updatedAt || null,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      accepted: Array.isArray(parsed.accepted) ? parsed.accepted : [],
    }
  } catch {
    return { schemaVersion: 2, updatedAt: null, proposals: [], accepted: [], invalid: true }
  }
}

export async function saveLearningAnalysis(root, analysis) {
  const dir = path.dirname(learningFile(root))
  await mkdir(dir, { recursive: true })
  const current = await readLearningState(root)
  const acceptedIDs = new Set(current.accepted.map((item) => item.id))
  const existing = new Map(current.proposals.map((item) => [item.id, item]))
  const proposals = analysis.proposals
    .filter((item) => !acceptedIDs.has(item.id))
    .map((item) => ({
      ...item,
      firstProposedAt: existing.get(item.id)?.firstProposedAt || new Date().toISOString(),
      lastAnalyzedAt: analysis.analyzedAt,
    }))
  const next = {
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    proposals,
    accepted: current.accepted,
  }
  await writeFile(learningFile(root), JSON.stringify(next, null, 2) + "\n", "utf8")
  return next
}

// Backward-compatible manual acceptance. Shadow-required proposals remain excluded
// from retrieval until they are promoted with measured benchmark improvement.
export async function acceptLearning(root, id) {
  const current = await readLearningState(root)
  const item = current.proposals.find((entry) => entry.id === id)
  if (!item) throw new Error("unknown learning proposal: " + id)
  const accepted = {
    ...item,
    status: item.shadowRequired ? "accepted-awaiting-shadow" : "accepted",
    acceptedAt: new Date().toISOString(),
  }
  const next = {
    schemaVersion: 2,
    updatedAt: accepted.acceptedAt,
    proposals: current.proposals.filter((entry) => entry.id !== id),
    accepted: [...current.accepted.filter((entry) => entry.id !== id), accepted],
  }
  await mkdir(path.dirname(learningFile(root)), { recursive: true })
  await writeFile(learningFile(root), JSON.stringify(next, null, 2) + "\n", "utf8")
  return accepted
}

async function benchmarkValidationFromArtifact(root, reportPath) {
  const value = String(reportPath || "").trim()
  if (!value) {
    throw new Error("learning promotion requires --report pointing to a benchmark matrix artifact")
  }

  root = path.resolve(root)
  const file = path.isAbsolute(value) ? value : path.resolve(root, value)
  const raw = await readFile(file, "utf8").catch(() => null)
  if (!raw) throw new Error("learning promotion benchmark report could not be read: " + value)

  let report
  try {
    report = JSON.parse(raw)
  } catch {
    throw new Error("learning promotion benchmark report is not valid JSON: " + value)
  }

  if (report.kind !== "ues-benchmark-matrix" || report.schemaVersion !== 1) {
    throw new Error("learning promotion requires a ues-benchmark-matrix schemaVersion 1 artifact")
  }
  if (report.coverageComplete !== true) {
    throw new Error("learning promotion requires a benchmark artifact with complete baseline/UES coverage")
  }

  const baseline = report.summary?.modes?.baseline
  const candidate = report.summary?.modes?.ues
  const baselinePassRate = clampRate(baseline?.passRate)
  const candidatePassRate = clampRate(candidate?.passRate)
  const baselineTotal = Number.parseInt(String(baseline?.total ?? "0"), 10)
  const candidateTotal = Number.parseInt(String(candidate?.total ?? "0"), 10)
  const samples = Math.min(baselineTotal, candidateTotal)

  if (baselinePassRate === null || candidatePassRate === null || samples < 1) {
    throw new Error("learning promotion benchmark artifact is missing valid pass-rate/sample evidence")
  }
  if (baselineTotal !== candidateTotal) {
    throw new Error("learning promotion requires equal baseline and UES sample counts")
  }
  if (candidatePassRate <= baselinePassRate) {
    throw new Error("learning promotion requires measured shadow benchmark improvement")
  }
  if (!Array.isArray(report.pairedResults) || report.pairedResults.length < 2) {
    throw new Error("learning promotion requires embedded paired baseline/UES benchmark evidence")
  }
  const confidence = pairedBenchmarkConfidence(report.pairedResults)
  if (confidence.promotionEligible !== true) {
    throw new Error("learning promotion requires statistically supported improvement without suite regression")
  }

  return {
    baselinePassRate,
    candidatePassRate,
    delta: candidatePassRate - baselinePassRate,
    samples,
    report: path.relative(root, file).replaceAll("\\", "/"),
    reportHash: createHash("sha256").update(raw).digest("hex"),
    model: report.model || null,
    suites: Array.isArray(report.suites) ? report.suites : [],
    finishedAt: report.finishedAt || null,
    confidence,
  }
}

export async function promoteLearning(root, id, validation = {}) {
  const current = await readLearningState(root)
  const item = current.accepted.find((entry) => entry.id === id)
  if (!item) {
    if (current.proposals.some((entry) => entry.id === id)) {
      throw new Error("learning proposal must be explicitly accepted before shadow promotion: " + id)
    }
    throw new Error("unknown learning proposal: " + id)
  }

  const shadowValidation = await benchmarkValidationFromArtifact(root, validation.report)
  const promotedAt = new Date().toISOString()
  const promoted = {
    ...item,
    status: "promoted",
    promotedAt,
    shadowValidation,
  }
  const next = {
    schemaVersion: 2,
    updatedAt: promotedAt,
    proposals: current.proposals.filter((entry) => entry.id !== id),
    accepted: [...current.accepted.filter((entry) => entry.id !== id), promoted],
  }
  await mkdir(path.dirname(learningFile(root)), { recursive: true })
  await writeFile(learningFile(root), JSON.stringify(next, null, 2) + "\n", "utf8")
  return promoted
}

function retrievalTerms(text) {
  return [...new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((term) => term.length >= 4),
  )]
}

export async function relevantAcceptedLearnings(root, text, limit = 5) {
  const state = await readLearningState(root)
  const terms = retrievalTerms(text)
  return state.accepted
    .filter((item) => !item.shadowRequired || item.status === "promoted" || item.shadowValidation?.delta > 0)
    .map((item) => {
      const title = String(item.title || "").toLowerCase()
      const rule = String(item.candidateRule || item.recommendation || "").toLowerCase()
      const tasks = JSON.stringify(item.evidence?.tasks || []).toLowerCase()
      const score = terms.reduce((sum, term) => {
        if (title.includes(term)) sum += 4
        if (rule.includes(term)) sum += 3
        if (tasks.includes(term)) sum += 2
        return sum
      }, 0)
      const validationBoost = item.shadowValidation?.delta > 0
        ? Math.min(5, item.shadowValidation.delta * 20)
        : 0
      return { item, score: score + validationBoost }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item)
}
