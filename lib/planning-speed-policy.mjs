function bounded(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function separatedBudget(values) {
  return {
    ...values,
    // V16.2 explicit timeout semantics. Keep legacy keys for callers/tests while
    // making it impossible to confuse model silence, tool runtime and the
    // absolute child-run ceiling in telemetry or controller wiring.
    planningTimeoutMs: values.hardTimeoutMs,
    modelTimeoutMs: values.idleTimeoutMs,
    toolTimeoutMs: values.toolTimeoutMs,
    absoluteRunTimeoutMs: values.absoluteHardTimeoutMs,
  }
}

export function planningRuntimeBudget(role, attempt = 1, options = {}) {
  const normalizedRole = String(role || "").replace(/^ues-/, "")
  const normalizedAttempt = Math.max(1, Math.trunc(Number(attempt) || 1))

  if (normalizedRole === "architect") {
    const recovery = normalizedAttempt > 1
    const deep = String(options.executionProfile || "") === "deep"
    const largePrompt = Number(options.taskChars || 0) >= 2500
    const initialHard = recovery ? 50_000 : 60_000
    const absoluteHard = recovery
      ? 95_000
      : deep || largePrompt
        ? 150_000
        : 120_000
    const hardTimeoutMs = bounded(
      recovery ? options.architectRecoveryHardTimeoutMs : options.architectHardTimeoutMs,
      initialHard,
      30_000,
      5 * 60_000,
    )
    const absoluteHardTimeoutMs = bounded(
      recovery ? options.architectRecoveryAbsoluteHardTimeoutMs : options.architectAbsoluteHardTimeoutMs,
      absoluteHard,
      hardTimeoutMs,
      6 * 60_000,
    )
    const idleTimeoutMs = bounded(
      recovery ? options.architectRecoveryIdleTimeoutMs : options.architectIdleTimeoutMs,
      recovery ? 28_000 : 40_000,
      10_000,
      2 * 60_000,
    )
    return separatedBudget({
      hardTimeoutMs,
      absoluteHardTimeoutMs,
      activityExtensionMs: bounded(
        recovery ? options.architectRecoveryActivityExtensionMs : options.architectActivityExtensionMs,
        recovery ? 25_000 : 35_000,
        10_000,
        90_000,
      ),
      activityWindowMs: bounded(options.architectActivityWindowMs, 20_000, 5_000, 60_000),
      idleTimeoutMs,
      toolTimeoutMs: bounded(
        recovery ? options.architectRecoveryToolTimeoutMs : options.architectToolTimeoutMs,
        recovery ? 30_000 : 45_000,
        10_000,
        5 * 60_000,
      ),
      softSteerMs: bounded(options.architectSoftSteerMs, 30_000, 15_000, 2 * 60_000),
      maxExplorationTools: bounded(options.architectMaxExplorationTools, 16, 8, 80),
    })
  }

  if (normalizedRole === "plan-checker") {
    const recovery = normalizedAttempt > 1
    const initialHard = recovery ? 45_000 : 70_000
    const hardTimeoutMs = bounded(
      recovery ? options.planCheckerRecoveryHardTimeoutMs : options.planCheckerHardTimeoutMs,
      initialHard,
      30_000,
      5 * 60_000,
    )
    const absoluteHardTimeoutMs = bounded(
      recovery ? options.planCheckerRecoveryAbsoluteHardTimeoutMs : options.planCheckerAbsoluteHardTimeoutMs,
      recovery ? 80_000 : 130_000,
      hardTimeoutMs,
      5 * 60_000,
    )
    const idleTimeoutMs = bounded(
      recovery ? options.planCheckerRecoveryIdleTimeoutMs : options.planCheckerIdleTimeoutMs,
      recovery ? 24_000 : 38_000,
      10_000,
      2 * 60_000,
    )
    return separatedBudget({
      hardTimeoutMs,
      absoluteHardTimeoutMs,
      activityExtensionMs: bounded(
        recovery ? options.planCheckerRecoveryActivityExtensionMs : options.planCheckerActivityExtensionMs,
        recovery ? 20_000 : 30_000,
        10_000,
        60_000,
      ),
      activityWindowMs: bounded(options.planCheckerActivityWindowMs, 20_000, 5_000, 60_000),
      idleTimeoutMs,
      toolTimeoutMs: bounded(
        recovery ? options.planCheckerRecoveryToolTimeoutMs : options.planCheckerToolTimeoutMs,
        recovery ? 25_000 : 40_000,
        10_000,
        5 * 60_000,
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
    })
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
  return toolCalls > 0 && idleMs >= Math.max(10_000, Math.floor((budget.modelTimeoutMs || budget.idleTimeoutMs || 30_000) * 0.65))
}

export function shouldSoftSteerPlanningRole(progress = {}, budget = null) {
  return shouldSoftSteerArchitect(progress, budget)
}
