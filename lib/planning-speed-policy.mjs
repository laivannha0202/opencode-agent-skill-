function bounded(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * V16.18 PLANNER VALUE GATE.
 *
 * The planner stays powerful; the question this answers is whether running it
 * ADDS information or coordination, or merely spends an architect + plan-checker
 * turn on a change that is already proven to be a bounded direct edit.
 *
 * It is a SPENDING decision with the same asymmetry the rest of the runtime
 * uses:
 *   * it can only turn the planner OFF when the task policy already declared
 *     the bounded shape AND the runtime evidence agrees;
 *   * it can never turn the planner ON against the task policy, and it can
 *     never touch the DEEP/high-risk/long-horizon floors -- those are asserted
 *     by `requirePlanCheck` itself and by the profile floors.
 *
 * Planner-required (value): multi-module, architecture, migration, explicit
 * phases, broad refactor, cross-package dependency, ambiguous ownership after
 * bounded discovery, complex recovery, repeated implementation failure.
 * Planner-not-needed: known bounded fix, one local owner, 1-3 tightly related
 * files, deterministic config/docs/version work, a simple regression with an
 * exact failing test and owner.
 *
 * @param {object} input { taskPolicy, role, attempt, candidateFiles,
 *   subsystems, phases, ownershipAmbiguous, repeatedImplementationFailure,
 *   dependencyOwnershipUnclear, crossPackage }
 */
export function plannerValueGate(input = {}) {
  const taskPolicy = input.taskPolicy && typeof input.taskPolicy === "object" ? input.taskPolicy : {}
  const risk = String(taskPolicy.risk || "").toLowerCase()
  const mode = String(taskPolicy.mode || "")
  const attempt = Math.max(1, Math.trunc(Number(input.attempt || 1)))
  const phases = Array.isArray(input.phases)
    ? input.phases.length
    : Array.isArray(taskPolicy.executionContract?.phases)
      ? taskPolicy.executionContract.phases.length
      : 0
  // A structural claim may arrive either as a direct gate input (the runtime
  // observed it) or on the task policy (the classifier already knew it). Either
  // source is evidence, so either source can keep the planner.
  const flag = (name) => input[name] === true || taskPolicy[name] === true
  const count = (name) => {
    const direct = Number(input[name])
    if (Number.isFinite(direct) && direct >= 0) return Math.trunc(direct)
    const declared = Number(taskPolicy[name])
    if (Number.isFinite(declared) && declared >= 0) return Math.trunc(declared)
    return null
  }
  const candidateFiles = count("candidateFiles")
  const subsystems = count("subsystems")

  const requiredReasons = []
  const skipReasons = []

  // --- Safety / shape floors (planner stays required) --------------------
  if (["high", "critical"].includes(risk)) requiredReasons.push(`risk=${risk}`)
  if (mode === "long-horizon" || taskPolicy.longHorizon === true) requiredReasons.push("long-horizon")
  if (phases > 0) requiredReasons.push(`explicit-phases=${phases}`)
  if (flag("architecture")) requiredReasons.push("architecture-evidence")
  if (flag("repeatedImplementationFailure")) requiredReasons.push("repeated-implementation-failure")
  if (flag("ownershipAmbiguous")) requiredReasons.push("ambiguous-ownership")
  if (flag("dependencyOwnershipUnclear")) requiredReasons.push("dependency-ownership-unclear")
  if (flag("crossPackage")) requiredReasons.push("cross-package-dependency")
  if (candidateFiles !== null && candidateFiles > 3) requiredReasons.push(`candidate-files=${candidateFiles}`)
  if (subsystems !== null && subsystems > 1) requiredReasons.push(`subsystems=${subsystems}`)
  if (taskPolicy.requirePlanCheck !== true) skipReasons.push("task-policy-does-not-require-plan-check")

  // --- Bounded no-value shape (planner can be skipped) -------------------
  const boundedShape =
    ["low", "medium", "unknown"].includes(risk) &&
    mode !== "long-horizon" &&
    phases === 0 &&
    attempt === 1 &&
    !flag("architecture") &&
    !flag("repeatedImplementationFailure") &&
    !flag("ownershipAmbiguous") &&
    !flag("dependencyOwnershipUnclear") &&
    !flag("crossPackage") &&
    (candidateFiles === null || candidateFiles <= 3) &&
    (subsystems === null || subsystems <= 1)
  if (boundedShape) skipReasons.push(`bounded-scope:files=${candidateFiles ?? "unknown"}/subsystems=${subsystems ?? "unknown"}`)
  if (taskPolicy.deterministic === true) skipReasons.push("deterministic-work")

  const required = requiredReasons.length > 0 || (taskPolicy.requirePlanCheck === true && skipReasons.length === 0)

  return {
    schemaVersion: 1,
    policy: "planner-value-gate-v16-18",
    required,
    // The planner is only ever skipped when the task policy did not require it
    // AND the observed shape is bounded. A safety floor in `requiredReasons`
    // always wins.
    reasons: requiredReasons.length ? requiredReasons : (required ? [] : skipReasons),
    floors: requiredReasons,
    skips: skipReasons,
    basis: requiredReasons.length ? "evidence-floor" : boundedShape ? "bounded-scope" : "task-policy",
    deterministic: true,
  }
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
