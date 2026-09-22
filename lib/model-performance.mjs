const KNOWN_TASK_CLASSES = new Set([
  "general", "repo-scale", "debugging", "architecture", "security",
  "migration", "frontend", "backend", "visual", "browser",
])

function boundedNumber(value, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

export function inferTaskClass(text = "", facts = {}) {
  const explicit = String(facts.taskClass || "").trim().toLowerCase()
  if (KNOWN_TASK_CLASSES.has(explicit)) return explicit
  const value = String(text || "").toLowerCase()
  if (/(whole repo|entire project|large monorepo|repo[- ]scale|cross[- ]module|toàn bộ dự án|nhiều module)/.test(value)) return "repo-scale"
  if (/(prompt injection|security|auth|authorization|permission|secret|credential|bảo mật|phân quyền)/.test(value)) return "security"
  if (/(migration|schema|database|sql|backfill|migrate)/.test(value)) return "migration"
  if (/(screenshot|visual|figma|pixel|responsive|storybook)/.test(value)) return "visual"
  if (/(browser|playwright|e2e|web page|click flow)/.test(value)) return "browser"
  if (/(root cause|debug|regression|crash|failing|bug|lỗi)/.test(value)) return "debugging"
  if (/(architecture|architect|design decision|system design|kiến trúc)/.test(value)) return "architecture"
  if (/(react|next\.js|vue|svelte|css|frontend|ui\b)/.test(value)) return "frontend"
  if (/(api|service|node|python|java|dotnet|backend|server)/.test(value)) return "backend"
  return "general"
}

export function normalizePerformanceRecord(record = {}) {
  const samples = Math.floor(boundedNumber(record.samples, 0, 0))
  const successes = Math.floor(boundedNumber(record.successes, Math.round(samples * boundedNumber(record.passRate, 0, 0, 1)), 0, samples))
  return {
    samples,
    successes,
    passRate: samples ? successes / samples : 0,
    avgRetries: boundedNumber(record.avgRetries, 0, 0, 100),
    avgTokens: boundedNumber(record.avgTokens, 0, 0),
    avgLatencyMs: boundedNumber(record.avgLatencyMs, 0, 0),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  }
}

export function normalizePerformanceHistory(history = {}) {
  const output = {}
  for (const [model, classes] of Object.entries(history || {})) {
    if (!model || !classes || typeof classes !== "object") continue
    const normalizedClasses = {}
    for (const [taskClass, record] of Object.entries(classes)) {
      if (!KNOWN_TASK_CLASSES.has(taskClass) && taskClass !== "overall") continue
      normalizedClasses[taskClass] = normalizePerformanceRecord(record)
    }
    if (Object.keys(normalizedClasses).length) output[model] = normalizedClasses
  }
  return output
}

function mergeAverage(previousAverage, previousSamples, value) {
  return previousSamples <= 0 ? value : ((previousAverage * previousSamples) + value) / (previousSamples + 1)
}

export function recordPerformanceOutcome(history = {}, outcome = {}) {
  const model = String(outcome.model || "").trim()
  if (!model) throw new Error("model performance outcome requires model")
  const taskClass = inferTaskClass(outcome.text || "", { taskClass: outcome.taskClass })
  const normalized = normalizePerformanceHistory(history)
  const current = normalizePerformanceRecord(normalized[model]?.[taskClass] || {})
  const samples = current.samples
  const passed = outcome.passed === true
  const next = {
    samples: samples + 1,
    successes: current.successes + (passed ? 1 : 0),
    passRate: 0,
    avgRetries: mergeAverage(current.avgRetries, samples, boundedNumber(outcome.retries, 0, 0, 100)),
    avgTokens: mergeAverage(current.avgTokens, samples, boundedNumber(outcome.tokens, 0, 0)),
    avgLatencyMs: mergeAverage(current.avgLatencyMs, samples, boundedNumber(outcome.latencyMs, 0, 0)),
    updatedAt: new Date().toISOString(),
  }
  next.passRate = next.successes / next.samples
  return { ...normalized, [model]: { ...(normalized[model] || {}), [taskClass]: next } }
}

function performanceAdjustment(record, minSamples) {
  const normalized = normalizePerformanceRecord(record)
  if (normalized.samples <= 0) return { adjustment: 0, confidence: 0, record: normalized }
  const confidence = Math.min(1, normalized.samples / Math.max(1, minSamples))
  const correctness = (normalized.passRate - 0.5) * 80
  const retryPenalty = Math.min(20, normalized.avgRetries * 5)
  const latencyPenalty = normalized.avgLatencyMs > 0 ? Math.min(10, Math.max(0, Math.log10(Math.max(1, normalized.avgLatencyMs / 1000)) * 3)) : 0
  return { adjustment: (correctness - retryPenalty - latencyPenalty) * confidence, confidence, record: normalized }
}

export function rerankCapabilitySelection(selection = {}, history = {}, options = {}) {
  const taskClass = inferTaskClass(options.text || "", { taskClass: options.taskClass })
  const minSamples = Math.max(1, Number(options.minSamples || 3))
  const normalized = normalizePerformanceHistory(history)
  const candidates = (selection.candidates || []).map((candidate) => {
    const record = normalized[candidate.id]?.[taskClass] || normalized[candidate.id]?.overall || null
    const evidence = performanceAdjustment(record, minSamples)
    return {
      ...candidate,
      baseScore: Number(candidate.score || 0),
      empiricalTaskClass: taskClass,
      empiricalEvidence: evidence.record,
      empiricalConfidence: Number(evidence.confidence.toFixed(4)),
      adjustedScore: Number((Number(candidate.score || 0) + evidence.adjustment).toFixed(6)),
    }
  })
  const eligible = candidates.filter((candidate) => candidate.eligible)
    .sort((a, b) => b.adjustedScore - a.adjustedScore || b.baseScore - a.baseScore)
  return { ...selection, selected: eligible[0] || null, candidates, taskClass, empirical: true }
}
