const FAST_ROLES = new Set(["executor", "verifier"])

export function turboFastPathDecision(taskPolicy = {}, options = {}) {
  const role = String(options.role || "")
  const attempt = Math.max(1, Number(options.attempt || 1))
  const browserRequested = options.browserRequested === true
  const visualRequired = options.visualRequired === true
  const reasons = []

  if (attempt !== 1) reasons.push("recovery-attempt")
  if (taskPolicy.executionProfile !== "fast") reasons.push("not-fast-profile")
  if (taskPolicy.singleFileBounded !== true) reasons.push("not-single-file-bounded")
  if (String(taskPolicy.risk || "").toLowerCase() !== "low") reasons.push("risk-not-low")
  if (taskPolicy.requireIntegrationVerification === true) reasons.push("integration-required")
  if (!FAST_ROLES.has(role)) reasons.push("role-not-fast-lane")
  if (browserRequested) reasons.push("browser-required")
  if (visualRequired) reasons.push("visual-required")

  const eligible = reasons.length === 0
  return {
    schemaVersion: 1,
    eligible,
    strategy: eligible ? "single-model-deterministic-first" : "standard",
    deterministicFirst: eligible,
    verifierOnDemand: eligible,
    failClosed: true,
    maxModelLanes: eligible ? 1 : null,
    reasons,
  }
}

export function turboFastTimeoutBudget(options = {}) {
  const number = (value, fallback, min, max) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback
    return Math.max(min, Math.min(max, Math.trunc(parsed)))
  }
  return {
    hardTimeoutMs: number(options.hardTimeoutMs, 180_000, 30_000, 10 * 60_000),
    idleTimeoutMs: number(options.idleTimeoutMs, 60_000, 20_000, 5 * 60_000),
    postToolErrorIdleTimeoutMs: number(options.postToolErrorIdleTimeoutMs, 30_000, 5_000, 2 * 60_000),
    verificationTimeoutSec: number(options.verificationTimeoutSec, 90, 30, 300),
  }
}
