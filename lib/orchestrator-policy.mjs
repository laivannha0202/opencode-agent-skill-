const TIERS = ["light", "standard", "heavy"]

function clampTier(index) {
  return TIERS[Math.max(0, Math.min(TIERS.length - 1, index))]
}

export function assessExecutionSignals(input = {}) {
  const risk = String(input.risk || "medium").toLowerCase()
  const files = Math.max(0, Number(input.files) || 0)
  const contextBytes = Math.max(0, Number(input.contextBytes) || 0)
  const attempt = Math.max(1, Number(input.attempt) || 1)
  const failure = String(input.failure || "").toLowerCase()

  let score = 0
  if (risk === "high") score += 2
  else if (risk === "critical") score += 3
  else if (risk === "medium") score += 1
  if (files >= 4) score += 1
  if (files >= 8) score += 1
  if (contextBytes >= 24_000) score += 1
  if (contextBytes >= 60_000) score += 1
  if (attempt >= 2) score += 1
  if (attempt >= 3) score += 1
  if (/(timeout|hang|stuck|context|integration|security|migration|race|corrupt)/.test(failure)) score += 1

  return { risk, files, contextBytes, attempt, failure, score }
}

export function recommendExecutionPolicy(input = {}) {
  const signals = assessExecutionSignals(input)
  const tier = signals.score >= 5 ? "heavy" : signals.score >= 2 ? "standard" : "light"
  const timeoutMs = signals.score >= 5 ? 30 * 60_000 : signals.score >= 2 ? 20 * 60_000 : 10 * 60_000
  const idleTimeoutMs = signals.score >= 5 ? 8 * 60_000 : 5 * 60_000
  const maxAttempts = signals.score >= 5 ? 3 : 2
  return {
    schemaVersion: 1,
    signals,
    recommendedTier: tier,
    timeoutMs,
    idleTimeoutMs,
    heartbeatMs: 30_000,
    maxAttempts,
    isolationRecommended: signals.files >= 4 || signals.risk === "high" || signals.risk === "critical",
  }
}

export function raiseTier(baseTier, minimumTier) {
  const base = Math.max(0, TIERS.indexOf(baseTier))
  const minimum = Math.max(0, TIERS.indexOf(minimumTier))
  return clampTier(Math.max(base, minimum))
}
