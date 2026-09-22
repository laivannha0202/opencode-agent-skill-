const DEFAULT_WEIGHTS = {
  instructions: 0.10,
  task: 0.08,
  declared: 0.34,
  tests: 0.15,
  references: 0.20,
  history: 0.05,
  tools: 0.08,
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0) || 1
  return Object.fromEntries(Object.entries(weights).map(([key, value]) => [key, Math.max(0, Number(value) || 0) / total]))
}

export function planEvidenceBudget(taskPolicy = {}, task = {}, signals = {}) {
  const base = clamp(
    Number(taskPolicy.contextBudget ?? taskPolicy.profile?.contextBudget ?? signals.contextBudget ?? 20_000),
    4_000,
    48_000,
  )
  const text = [task?.title, task?.summary, ...(task?.acceptance || [])].filter(Boolean).join(" ").toLowerCase()
  const visual = signals.visual === true || /(screenshot|figma|visual|pixel|layout|giao diện|hình ảnh|ảnh mẫu)/i.test(text)
  const browser = signals.browser === true || /(browser|playwright|e2e|click|navigation|trình duyệt)/i.test(text)
  const debugging = signals.debugging === true || /(fix|bug|error|regression|debug|lỗi)/i.test(text)
  const highRisk = taskPolicy.risk === "high"

  const weights = { ...DEFAULT_WEIGHTS }
  if (debugging) {
    weights.tests += 0.07
    weights.references -= 0.04
    weights.history += 0.02
    weights.declared -= 0.05
  }
  if (highRisk) {
    weights.tests += 0.06
    weights.references += 0.04
    weights.tools -= 0.03
    weights.declared -= 0.05
    weights.task -= 0.02
  }
  if (visual || browser) {
    weights.tools += 0.08
    weights.references -= 0.04
    weights.declared -= 0.04
  }

  const normalized = normalizeWeights(weights)
  const buckets = Object.fromEntries(
    Object.entries(normalized).map(([key, weight]) => [key, Math.max(256, Math.round(base * weight))]),
  )
  const allocated = Object.values(buckets).reduce((sum, value) => sum + value, 0)
  const drift = base - allocated
  buckets.declared = Math.max(256, buckets.declared + drift)

  return {
    schemaVersion: 1,
    total: base,
    unit: "characters",
    buckets,
    signals: { visual, browser, debugging, highRisk },
    expansion: {
      initial: base,
      diagnose: Math.min(48_000, Math.max(base, Math.round(base * 1.35))),
      deepRecovery: Math.min(48_000, Math.max(20_000, Math.round(base * 1.75))),
    },
  }
}

export function bucketLimit(plan, role, remaining = Infinity) {
  const limit = Number(plan?.buckets?.[role] || 0)
  return Math.max(0, Math.min(limit, Number.isFinite(remaining) ? remaining : limit))
}

export function evidenceValueScore({ relevance = 0, freshness = 0, confidence = 0, chars = 1 } = {}) {
  const signal = Math.max(0, Number(relevance)) * 0.55 +
    Math.max(0, Number(freshness)) * 0.20 +
    Math.max(0, Number(confidence)) * 0.25
  return signal / Math.max(1, Number(chars))
}
