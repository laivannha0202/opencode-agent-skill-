function bounded(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function planningRuntimeBudget(role, attempt = 1, options = {}) {
  const normalizedRole = String(role || "").replace(/^ues-/, "")
  const normalizedAttempt = Math.max(1, Math.trunc(Number(attempt) || 1))

  if (normalizedRole === "architect") {
    const recovery = normalizedAttempt > 1
    return {
      hardTimeoutMs: bounded(
        recovery ? options.architectRecoveryHardTimeoutMs : options.architectHardTimeoutMs,
        recovery ? 45_000 : 60_000,
        30_000,
        5 * 60_000,
      ),
      idleTimeoutMs: bounded(
        recovery ? options.architectRecoveryIdleTimeoutMs : options.architectIdleTimeoutMs,
        recovery ? 18_000 : 25_000,
        10_000,
        2 * 60_000,
      ),
      softSteerMs: bounded(
        options.architectSoftSteerMs,
        30_000,
        15_000,
        2 * 60_000,
      ),
      maxExplorationTools: bounded(options.architectMaxExplorationTools, 16, 8, 80),
    }
  }

  if (normalizedRole === "plan-checker") {
    const recovery = normalizedAttempt > 1
    return {
      hardTimeoutMs: bounded(
        recovery ? options.planCheckerRecoveryHardTimeoutMs : options.planCheckerHardTimeoutMs,
        recovery ? 40_000 : 75_000,
        30_000,
        5 * 60_000,
      ),
      idleTimeoutMs: bounded(
        recovery ? options.planCheckerRecoveryIdleTimeoutMs : options.planCheckerIdleTimeoutMs,
        recovery ? 15_000 : 30_000,
        10_000,
        2 * 60_000,
      ),
      softSteerMs: bounded(
        recovery ? options.planCheckerRecoverySoftSteerMs : options.planCheckerSoftSteerMs,
        recovery ? 18_000 : 35_000,
        10_000,
        2 * 60_000,
      ),
      maxExplorationTools: bounded(
        recovery ? options.planCheckerRecoveryMaxExplorationTools : options.planCheckerMaxExplorationTools,
        recovery ? 6 : 10,
        4,
        40,
      ),
    }
  }

  return null
}

export function shouldSoftSteerArchitect(progress = {}, budget = null) {
  if (!budget) return false
  const elapsedMs = Number(progress.elapsedMs || 0)
  const toolCalls = Number(progress.toolCalls || 0)
  const idleMs = Number(progress.idleMs || 0)

  if (budget.softSteerMs && elapsedMs >= budget.softSteerMs) return true
  if (budget.maxExplorationTools && toolCalls >= budget.maxExplorationTools) return true

  // If the model has gone quiet after doing real exploration, ask it to emit
  // the plan before the hard idle watchdog has to kill the worker.
  return toolCalls > 0 && idleMs >= Math.max(10_000, Math.floor((budget.idleTimeoutMs || 30_000) * 0.65))
}


export function shouldSoftSteerPlanningRole(progress = {}, budget = null) {
  return shouldSoftSteerArchitect(progress, budget)
}
