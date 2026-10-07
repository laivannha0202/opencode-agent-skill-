// V16.6 runtime surface.
//
// This is the single production entry point for V16.6 behaviour. Everything
// ues.ts needs from the release lives behind this module so the extension has
// one import, one version, and one place where lazy loading is decided.
//
// Lazy-loading rules:
//   * SAFETY and VERIFICATION guards are never lazy (they are already eager in
//     lib/tool-surface-v3.mjs, lib/policy-engine.mjs, the verifier and the
//     permission layer - this module does not touch them).
//   * Heavy V16.6 session modules (pool, capsule, cache, evidence requests) are
//     loaded on first use, off the critical path of a run that never consults.
//   * The unified budget itself is synchronous and cheap: one task should not
//     pay a dynamic-import round trip to be scored.

import {
  computeOrchestrationBudget,
  applyOrchestrationBudgetToTaskPolicy,
  refineOrchestrationBudget,
  classifyExecutionComplexity,
  describeOrchestrationBudget,
  EXECUTION_PROFILE,
  PROFILE_SPEND,
} from "./orchestration-budget-v16-6.mjs"
import {
  resolveReasoningMode,
  resolveDeepSeekTurnBudget,
  REASONING_MODE,
} from "./deepseek-turn-policy-v16-6.mjs"
import { createProgressObserverV2, observerHeaderV2, resolveProgressMode } from "./progress-observer-v2.mjs"
import { resolveToolDescriptionProfile, toolDescriptionProfileEnv } from "./tool-description-profiles-v16-6.mjs"
import { resolveEconomyMode } from "./tool-output-economy-v16-6.mjs"
import { metric, NOT_MEASURED, PROVENANCE } from "./measurement-provenance.mjs"

export const V16_6_RUNTIME_SCHEMA_VERSION = 1
export const V16_6_RELEASE = "v16.6"
export const V16_6_POLICY = "v16-6-runtime"

let sessionModules = null
let economyModules = null

/**
 * Load the heavy V16.6 session modules once, on demand.
 * Result is cached; concurrent callers share the same promise.
 */
let sessionLoad = null
export function loadSessionRuntime() {
  if (sessionModules) return Promise.resolve(sessionModules)
  if (!sessionLoad) {
    sessionLoad = Promise.all([
      import("./deepseek-session-budget.mjs"),
      import("./deepseek-consult-cache.mjs"),
      import("./deepseek-resume-capsule.mjs"),
      import("./deepseek-evidence-requests.mjs"),
      import("./parallel-reasoning-v16-6.mjs"),
      // V16.9: the evidence broker is the single owner of the "advisor ASKS for
      // local evidence" loop. It wraps the evidence-request primitives loaded
      // just above, so it belongs in the same lazily-hydrated session stack:
      // a run that never consults never pays for it.
      import("./evidence-broker.mjs"),
      // V16.9: the shared-context ledger is the broker's internal dedup
      // primitive. It is hydrated with the same stack (the broker receives it
      // by injection) so a non-consulting run never loads it either.
      import("./shared-context-ledger.mjs"),
    ]).then(([budget, cache, capsule, evidence, parallel, broker, sharedContext]) => {
      sessionModules = {
        sessionBudget: budget,
        consultCache: cache,
        resumeCapsule: capsule,
        evidenceRequests: evidence,
        parallel,
        evidenceBroker: broker,
        sharedContextLedger: sharedContext,
      }
      return sessionModules
    })
  }
  return sessionLoad
}

/** Load the V16.6 economy modules once, on demand. */
let economyLoad = null
export function loadEconomyRuntime() {
  if (economyModules) return Promise.resolve(economyModules)
  if (!economyLoad) {
    economyLoad = Promise.all([
      import("./tool-output-economy-v16-6.mjs"),
      import("./prefix-drift-guard-v16-6.mjs"),
      import("./parallel-reasoning-v16-6.mjs"),
      import("./tool-description-profiles-v16-6.mjs"),
    ]).then(([output, drift, parallel, descriptions]) => {
      economyModules = {
        toolOutput: output,
        prefixDrift: drift,
        parallel: parallel,
        descriptions,
      }
      return economyModules
    })
  }
  return economyLoad
}

/** True when the release's new behaviour is reachable at all. */
export function v16_6Enabled(env = process.env) {
  const mode = resolveReasoningMode(env)
  const disabled = String(env?.UES_V16_6 || "").toLowerCase() === "off"
  return {
    enabled: !disabled,
    reasoningMode: mode.mode,
    reasoningModeNormalized: mode.normalized,
    reasoningModeSource: mode.source,
    disabledByEnv: disabled,
  }
}

/**
 * Compute the unified budget for a run.
 *
 * `input.taskPolicy` is the existing classifyEngineeringTask() result (V16.5
 * shape); everything else is optional evidence. Pure, synchronous, deterministic.
 */
export function computeRunBudget(input = {}) {
  const budget = computeOrchestrationBudget(input)
  return budget
}

/** Budget + task policy applied in one call (the shape ues.ts wants). */
export function budgetedTaskPolicy(taskPolicy, input = {}) {
  const budget = computeOrchestrationBudget({ ...input, taskPolicy })
  return { policy: applyOrchestrationBudgetToTaskPolicy(taskPolicy, budget), budget }
}

/** Escalate a budget on retry. Never downgrades. */
export function escalateRunBudget(budget, input = {}) {
  return refineOrchestrationBudget(budget, input)
}

/**
 * Runtime knobs derived from the budget, to be injected into child processes
 * so a child inherits the parent's decision instead of re-guessing it.
 */
export function budgetChildEnv(budget, env = process.env) {
  const row = budget || {}
  const base = {}
  const profile = row.toolDescriptionProfile || resolveToolDescriptionProfile({ env, risk: "low" }).profile
  Object.assign(base, toolDescriptionProfileEnv(profile))
  base.UES_REASONING_MODE = String(row.reasoningMode || row.deepSeekMode || resolveReasoningMode(env).mode)
  // V16.6.1: `auto` is the default. It is the reversible, lossless-audited mode;
  // `off`/`on` remain explicit operator overrides and are passed through
  // untouched when the operator set them.
  base.UES_TOOL_OUTPUT_ECONOMY = env?.UES_TOOL_OUTPUT_ECONOMY || resolveEconomyMode(env).mode
  base.UES_PROGRESS_OBSERVER_V2 = env?.UES_PROGRESS_OBSERVER_V2 || resolveProgressMode(env).mode
  base.UES_V16_6_BUDGET_FINGERPRINT = String(row.fingerprint || "")
  return base
}

/** Observer factory pre-bound to the run's header. */
export function createRunObserver(budget, input = {}) {
  return createProgressObserverV2({
    ...input,
    reasoningMode: budget?.reasoningMode || budget?.deepSeekMode || resolveReasoningMode(input.env).mode,
    profile: budget?.executionProfile || EXECUTION_PROFILE.BALANCED,
    mode: input.mode || resolveProgressMode(input.env).mode,
  })
}

export function headerFor(budget, extra = {}) {
  return observerHeaderV2({
    reasoningMode: budget?.reasoningMode || budget?.deepSeekMode || "balanced",
    profile: budget?.executionProfile || "BALANCED",
    ...extra,
  })
}

/**
 * Consolidated V16.6 telemetry. Every value carries a provenance label; a
 * missing measurement is reported as NOT_MEASURED rather than guessed.
 */
export function v16_6Telemetry(input = {}) {
  const budget = input.budget || null
  return {
    schemaVersion: V16_6_RUNTIME_SCHEMA_VERSION,
    release: V16_6_RELEASE,
    policy: V16_6_POLICY,
    enabled: input.enabled !== false,
    budget: budget
      ? {
          fingerprint: budget.fingerprint,
          executionProfile: budget.executionProfile,
          taskComplexity: budget.taskComplexity,
          contextBudget: metric(budget.contextBudget, PROVENANCE.DERIVED),
          maxAdvertisedTools: metric(budget.maxAdvertisedTools, PROVENANCE.DERIVED),
          toolDescriptionProfile: budget.toolDescriptionProfile,
          deepSeekMode: budget.deepSeekMode,
          maxTurns: metric(budget.deepSeekTurnBudget?.maxTurns ?? 0, PROVENANCE.DERIVED),
          effectiveMaxTurns: metric(budget.deepSeekTurnBudget?.effectiveMaxTurns ?? 0, PROVENANCE.DERIVED),
          maxChildren: metric(budget.maxChildren ?? 0, PROVENANCE.DERIVED),
          maxParallel: metric(budget.maxParallel ?? 0, PROVENANCE.DERIVED),
          verificationStrategy: budget.verificationStrategy,
        }
      : null,
    session: input.session || null,
    consultCache: input.consultCache || null,
    evidenceRequests: input.evidenceRequests || null,
    parallel: input.parallel || null,
    progress: input.progress || null,
    toolOutput: input.toolOutput || null,
    toolSurface: input.toolSurface || null,
    prefixDrift: input.prefixDrift || null,
    benefitLearner: input.benefitLearner || null,
    latencyMs: input.latencyMs === undefined ? NOT_MEASURED : metric(input.latencyMs, PROVENANCE.MEASURED),
    provenance: {
      policy: V16_6_POLICY,
      budget: PROVENANCE.DERIVED,
      counters: PROVENANCE.MEASURED,
      tokenSavings: NOT_MEASURED,
      latencySavings: NOT_MEASURED,
    },
  }
}

/** Short human line for the run journal / observer header. */
export function describeRun(budget) {
  return describeOrchestrationBudget(budget)
}

export const V16_6_RUNTIME_EXPORTS = Object.freeze([
  "v16_6Enabled",
  "computeRunBudget",
  "budgetedTaskPolicy",
  "escalateRunBudget",
  "budgetChildEnv",
  "createRunObserver",
  "headerFor",
  "v16_6Telemetry",
  "loadSessionRuntime",
  "loadEconomyRuntime",
  "describeRun",
  "REASONING_MODE",
  "PROFILE_SPEND",
])

// Re-exported for the single-extension import site.
export {
  computeOrchestrationBudget,
  applyOrchestrationBudgetToTaskPolicy,
  refineOrchestrationBudget,
  classifyExecutionComplexity,
  describeOrchestrationBudget,
  EXECUTION_PROFILE,
  PROFILE_SPEND,
  resolveDeepSeekTurnBudget,
}
