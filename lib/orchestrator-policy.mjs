const HIGH_RISK = /(auth|security|permission|payment|migration|schema|database|production|deploy|public api|breaking|secret|credential)/i
const LONG = /(whole repo|whole repository|entire repo|entire project|long[- ]running|multi[- ]file|cross[- ]module|resume|migration|refactor all)/i

export function classifyEngineeringTask(text, facts = {}) {
  const value = String(text || "")
  let score = 0
  if (value.length > 250) score += 1
  if (value.length > 700) score += 1
  if (HIGH_RISK.test(value)) score += 2
  if (LONG.test(value)) score += 2
  if (Number(facts.changedFiles || 0) > 5) score += 1
  if (Number(facts.changedFiles || 0) > 12) score += 1
  if (facts.hasMigration || facts.hasPublicContract) score += 2

  const risk = HIGH_RISK.test(value) || facts.hasMigration || facts.hasPublicContract
    ? "high"
    : score >= 3 ? "medium" : "low"

  const mode = score >= 5 ? "long-horizon" : score >= 2 ? "standard" : "inline"
  const modelTier = risk === "high" || score >= 5 ? "heavy" : score >= 2 ? "standard" : "light"
  const maxAttempts = risk === "high" ? 2 : 3
  const contextBudget = mode === "long-horizon" ? 48_000 : mode === "standard" ? 32_000 : 16_000

  return {
    schemaVersion: 1,
    score,
    risk,
    mode,
    modelTier,
    maxAttempts,
    contextBudget,
    requirePlanCheck: mode === "long-horizon" || risk === "high",
    requireIntegrationVerification: mode !== "inline" || risk === "high",
  }
}
