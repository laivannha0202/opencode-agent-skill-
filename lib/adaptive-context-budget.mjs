const ROLE_TARGETS = Object.freeze({
  fast: {
    architect: 8_000,
    "plan-checker": 6_000,
    executor: 6_000,
    debugger: 8_000,
    verifier: 4_500,
    "integration-verifier": 8_000,
    "visual-verifier": 5_000,
    reviewer: 5_000,
    critic: 6_000,
    "codebase-mapper": 6_000,
    researcher: 6_000,
    "merge-arbiter": 8_000,
  },
  standard: {
    architect: 12_000,
    "plan-checker": 10_000,
    executor: 11_000,
    debugger: 14_000,
    verifier: 8_000,
    "integration-verifier": 12_000,
    "visual-verifier": 8_000,
    reviewer: 8_000,
    critic: 10_000,
    "codebase-mapper": 10_000,
    researcher: 10_000,
    "merge-arbiter": 12_000,
  },
})

function clamp(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function adaptiveContextBudget(taskPolicy = {}, role = "executor", attempt = 1, options = {}) {
  const base = clamp(
    taskPolicy.contextBudget ?? taskPolicy.profile?.contextBudget,
    20_000,
    4_000,
    48_000,
  )
  const profile = String(taskPolicy.executionProfile || taskPolicy.profile?.name || "standard")
  const highRisk = taskPolicy.risk === "high" || taskPolicy.risk === "critical"

  // High-risk work keeps the original evidence budget. Turbo mode must not trade
  // away security/payment/schema evidence for latency.
  if (highRisk || options.disabled === true) {
    return {
      schemaVersion: 1,
      budget: base,
      baseBudget: base,
      adaptive: false,
      reason: highRisk ? "high-risk-preserves-base-budget" : "disabled",
    }
  }

  const table = ROLE_TARGETS[profile] || ROLE_TARGETS.standard
  const target = clamp(table?.[role], base, 4_000, base)
  const normalizedAttempt = Math.max(1, Math.trunc(Number(attempt || 1)))

  // Failed attempts expand deterministically back toward the policy ceiling.
  let budget = target
  if (normalizedAttempt === 2) budget = Math.min(base, Math.max(target, Math.round(target * 1.5)))
  else if (normalizedAttempt >= 3) budget = base

  if (options.contextInsufficient === true) {
    budget = Math.min(base, Math.max(budget, Math.round(target * 1.75)))
  }

  return {
    schemaVersion: 1,
    budget,
    baseBudget: base,
    adaptive: budget < base,
    profile,
    role,
    attempt: normalizedAttempt,
    reason: budget < base ? "role-bounded-expand-on-failure" : "policy-ceiling",
  }
}
