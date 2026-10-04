// Section A + B: V16.6 unified orchestration budget and the canonical
// DeepSeek turn policy.
//
// The invariants asserted here are the ones that must NEVER regress:
//   - evidence priority is runtime > repo structure > verifier > task text
//   - task text alone can never reach DEEP
//   - the budget can only ESCALATE on a retry
//   - lane safety bounds still clamp the turn budget
//   - fingerprints are deterministic (no timestamps)

import assert from "node:assert/strict"
import test from "node:test"

import {
  EXECUTION_PROFILE,
  PROFILE_SPEND,
  TASK_POLICY_PROFILE,
  applyOrchestrationBudgetToTaskPolicy,
  budgetFingerprint,
  classifyExecutionComplexity,
  computeOrchestrationBudget,
  describeOrchestrationBudget,
  refineOrchestrationBudget,
} from "../lib/orchestration-budget-v16-6.mjs"
import {
  LANE_SAFETY_BOUNDS,
  REASONING_MODE,
  TURN_POLICY_CEILING,
  laneLimitsForTurns,
  resolveDeepSeekTurnBudget,
  resolveReasoningMode,
  turnBudgetFingerprint,
} from "../lib/deepseek-turn-policy-v16-6.mjs"
import { EVIDENCE_PRIORITY, PROVENANCE, PROVENANCE_RANK, metric } from "../lib/measurement-provenance.mjs"

test("A1: profile spend table is the single source of orchestration numbers", () => {
  assert.deepEqual(EXECUTION_PROFILES(), [EXECUTION_PROFILE.FAST, EXECUTION_PROFILE.BALANCED, EXECUTION_PROFILE.DEEP])
  assert.equal(TASK_POLICY_PROFILE[EXECUTION_PROFILE.FAST], "fast")
  assert.equal(TASK_POLICY_PROFILE[EXECUTION_PROFILE.BALANCED], "standard")
  assert.equal(TASK_POLICY_PROFILE[EXECUTION_PROFILE.DEEP], "deep")
  // Spend is monotonic: a bigger profile never gets a smaller budget.
  assert.ok(PROFILE_SPEND.FAST.contextBudget < PROFILE_SPEND.BALANCED.contextBudget)
  assert.ok(PROFILE_SPEND.DEEP.maxAdvertisedTools >= PROFILE_SPEND.BALANCED.maxAdvertisedTools)
})

function EXECUTION_PROFILES() {
  return Object.keys(PROFILE_SPEND)
}

test("A2: a bounded single low-risk change earns FAST", () => {
  const budget = computeOrchestrationBudget({
    taskPolicy: { risk: "low", executionProfile: "standard" },
    affectedFiles: 1,
    affectedSubsystems: 1,
  })
  assert.equal(budget.executionProfile, EXECUTION_PROFILE.FAST)
  assert.equal(budget.maxAdvertisedTools, PROFILE_SPEND.FAST.maxAdvertisedTools)
  assert.ok(budget.reasons.some((row) => row.signal === "floor:bounded-single-file-low-risk"))
})

test("A3: absence of a measured diff is NOT evidence of a tiny task", () => {
  const budget = computeOrchestrationBudget({
    taskPolicy: { risk: "low", executionProfile: "standard" },
    affectedFiles: undefined,
  })
  assert.equal(budget.executionProfile, EXECUTION_PROFILE.BALANCED)
})

test("A4: task text alone can never reach DEEP", () => {
  const loudTaskText = [
    "Refactor the entire authentication subsystem, migrate the payment state machine,",
    "redesign the database schema, rewrite the API contract and restructure every module.",
  ].join(" ")
  const budget = computeOrchestrationBudget({ taskPolicy: { risk: "low" }, taskText: loudTaskText })
  assert.equal(budget.executionProfile, EXECUTION_PROFILE.BALANCED)
  const complexity = classifyExecutionComplexity({ taskText: loudTaskText, risk: "low" })
  assert.ok(complexity.evidenceScore <= 1)
})

test("A5: runtime evidence outranks repository structure outranks task text", () => {
  assert.deepEqual(EVIDENCE_PRIORITY, [
    "runtime-evidence",
    "repository-structure",
    "verifier-evidence",
    "task-text",
  ])
  const runtime = classifyExecutionComplexity({ runtimeFailures: 3, risk: "low" })
  const structure = classifyExecutionComplexity({ affectedSubsystems: 6, risk: "low" })
  assert.equal(runtime.basis, "runtime-evidence")
  assert.equal(structure.basis, "repository-structure")
  assert.ok(PROVENANCE_RANK[PROVENANCE.MEASURED] > PROVENANCE_RANK[PROVENANCE.ESTIMATED])
})

test("A6: high risk and long-horizon are floors, never downgrades", () => {
  const highRisk = computeOrchestrationBudget({ taskPolicy: { risk: "high" }, affectedFiles: 1 })
  assert.equal(highRisk.executionProfile, EXECUTION_PROFILE.DEEP)
  const longHorizon = computeOrchestrationBudget({
    taskPolicy: { risk: "low", mode: "long-horizon" },
    affectedFiles: 1,
  })
  assert.equal(longHorizon.executionProfile, EXECUTION_PROFILE.DEEP)
})

test("A7: repeated runtime failure escalates to DEEP with a stated reason", () => {
  const budget = computeOrchestrationBudget({
    taskPolicy: { risk: "low", executionProfile: "standard" },
    affectedFiles: 3,
    runtimeFailures: 3,
  })
  assert.equal(budget.executionProfile, EXECUTION_PROFILE.DEEP)
  assert.ok(budget.reasons.some((row) => String(row.signal).includes("runtime-failures")))
})

test("A8: fingerprints are deterministic and change with the decision", () => {
  const input = { taskPolicy: { risk: "low" }, affectedFiles: 4, affectedSubsystems: 3 }
  const first = computeOrchestrationBudget(input)
  const second = computeOrchestrationBudget(input)
  assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(budgetFingerprint(first), budgetFingerprint(second))
  const harder = computeOrchestrationBudget({ ...input, runtimeFailures: 2 })
  assert.notEqual(first.fingerprint, harder.fingerprint)
})

test("A9: refinement escalates only", () => {
  const base = computeOrchestrationBudget({ taskPolicy: { risk: "low" }, affectedFiles: 1 })
  assert.equal(base.executionProfile, EXECUTION_PROFILE.FAST)
  const oneRetry = refineOrchestrationBudget(base, { verifierFailures: 1, risk: "low" })
  assert.equal(oneRetry.executionProfile, EXECUTION_PROFILE.BALANCED)
  const secondRetry = refineOrchestrationBudget(oneRetry, { verifierFailures: 2, risk: "low" })
  assert.equal(secondRetry.executionProfile, EXECUTION_PROFILE.DEEP)
  // Escalation is one-way: it can never hand back a SMALLER budget.
  assert.ok(PROFILE_SPEND[secondRetry.executionProfile].contextBudget >= PROFILE_SPEND[base.executionProfile].contextBudget)
  const noEvidence = refineOrchestrationBudget(base, { risk: "low" })
  assert.equal(noEvidence.executionProfile, EXECUTION_PROFILE.FAST)
  assert.equal(noEvidence.fingerprint, base.fingerprint)
  const alreadyDeep = refineOrchestrationBudget(secondRetry, { verifierFailures: 1, risk: "low" })
  assert.equal(alreadyDeep.executionProfile, EXECUTION_PROFILE.DEEP)
  assert.equal(alreadyDeep.refinements.at(-1), "no-escalation")
})

test("A10: spending more needs an evidence floor, less is always allowed", () => {
  const budget = computeOrchestrationBudget({ taskPolicy: { risk: "low" }, affectedFiles: 2 })
  assert.deepEqual(budget.profileFloors, [], "no floor: BALANCED is a preference, not an escalation")

  // No floor -> the run keeps the profile the task policy already chose.
  const unproven = applyOrchestrationBudgetToTaskPolicy({ executionProfile: "fast", risk: "low" }, budget)
  assert.equal(unproven.executionProfile, "fast", "V16.6 never inflates a run without a floor")
  // Even a proven single-file fast lane stays fast (less spend is allowed).
  const fast = applyOrchestrationBudgetToTaskPolicy({
    executionProfile: "fast",
    risk: "low",
    singleFileBounded: true,
  }, budget)
  assert.equal(fast.executionProfile, "fast")
  assert.equal(fast.v16_6.maxAdvertisedTools, PROFILE_SPEND.FAST.maxAdvertisedTools)
  assert.equal(fast.maxSkills, PROFILE_SPEND.FAST.skillMax)
  assert.equal(fast.contextBudget, PROFILE_SPEND.FAST.contextBudget)
  // An existing DEEP floor is always kept.
  const deep = applyOrchestrationBudgetToTaskPolicy({ executionProfile: "deep", risk: "low" }, budget)
  assert.equal(deep.executionProfile, "deep")
  // A real floor escalates: high risk is evidence, not preference.
  const riskyBudget = computeOrchestrationBudget({ taskPolicy: { risk: "high" }, affectedFiles: 2 })
  assert.ok(riskyBudget.profileFloors.includes("risk=high"))
  const escalated = applyOrchestrationBudgetToTaskPolicy({ executionProfile: "fast", risk: "high" }, riskyBudget)
  assert.equal(escalated.executionProfile, "deep")
  assert.equal(escalated.maxSkills, PROFILE_SPEND.DEEP.skillMax)
})

test("A11: the budget never touches permission or verification authority", () => {
  const original = {
    executionProfile: "standard",
    risk: "high",
    requireIntegrationVerification: true,
    requirePlanCheck: true,
    singleFileBounded: false,
  }
  const applied = applyOrchestrationBudgetToTaskPolicy(original, computeOrchestrationBudget({ taskPolicy: original }))
  assert.equal(applied.requireIntegrationVerification, true)
  assert.equal(applied.requirePlanCheck, true)
  assert.equal(applied.singleFileBounded, false)
  assert.equal(original.executionProfile, "standard", "the input policy object is never mutated")
})

test("A12: the budget description is a single readable line", () => {
  const text = describeOrchestrationBudget(computeOrchestrationBudget({ taskPolicy: { risk: "low" } }))
  assert.match(text, /V16\.6/)
  assert.ok(text.length < 400)
})

test("B1: UES_REASONING_MODE resolves and never silently becomes off", () => {
  assert.equal(resolveReasoningMode({}).mode, REASONING_MODE.BALANCED)
  assert.equal(resolveReasoningMode({ UES_REASONING_MODE: "economy" }).mode, REASONING_MODE.ECONOMY)
  assert.equal(resolveReasoningMode({ UES_REASONING_MODE: "deepseek-first" }).mode, REASONING_MODE.DEEPSEEK_FIRST)
  const invalid = resolveReasoningMode({ UES_REASONING_MODE: "ludicrous" })
  assert.equal(invalid.mode, REASONING_MODE.BALANCED)
  assert.equal(invalid.normalized, false)
  assert.equal(invalid.invalidValue, "ludicrous")
})

test("B2: the turn table matches the released policy", () => {
  const easy = resolveDeepSeekTurnBudget({ complexity: "easy", reasoningMode: "balanced" })
  const normal = resolveDeepSeekTurnBudget({ complexity: "normal", reasoningMode: "balanced" })
  const hard = resolveDeepSeekTurnBudget({ complexity: "hard", reasoningMode: "balanced" })
  const veryHard = resolveDeepSeekTurnBudget({ complexity: "very-hard", reasoningMode: "balanced" })
  assert.equal(easy.maxTurns, 0)
  assert.equal(normal.maxTurns, 2)
  assert.equal(hard.maxTurns, 4)
  assert.equal(veryHard.maxTurns, 6)
  assert.equal(veryHard.policyCeiling, TURN_POLICY_CEILING)
})

test("B3: economy spends no more turns than balanced, never more", () => {
  for (const complexity of ["easy", "normal", "hard", "very-hard"]) {
    const economy = resolveDeepSeekTurnBudget({ complexity, reasoningMode: "economy" })
    const balanced = resolveDeepSeekTurnBudget({ complexity, reasoningMode: "balanced" })
    assert.ok(
      economy.maxTurns <= balanced.maxTurns,
      `${complexity}: economy ${economy.maxTurns} <= balanced ${balanced.maxTurns}`,
    )
  }
})

test("B4: the V16.5 lane safety bounds still clamp the turn budget", () => {
  const row = resolveDeepSeekTurnBudget({ complexity: "very-hard", reasoningMode: "balanced" })
  assert.equal(row.maxFollowUps, LANE_SAFETY_BOUNDS.maxFollowUps)
  assert.ok(row.maxConsultations <= 3)
  assert.ok(row.effectiveMaxTurns <= 5)
  assert.equal(row.clampedByLaneSafety, true)
  assert.ok(row.reasons.some((row2) => String(row2).includes("lane")))
})

test("B5: the web lane being OFF removes every DeepSeek turn", () => {
  const row = resolveDeepSeekTurnBudget({ complexity: "hard", reasoningMode: "balanced", webReasoningMode: "off" })
  assert.equal(row.maxTurns, 0)
  assert.equal(row.maxConsultations, 0)
  assert.equal(row.maxFollowUps, 0)
  assert.ok(row.reasons.includes("web-reasoning-mode=off"))
})

test("B6: FORCE never buys a turn the policy did not grant, but always gets one", () => {
  const easyForce = resolveDeepSeekTurnBudget({ complexity: "easy", reasoningMode: "balanced", webReasoningMode: "force" })
  assert.equal(easyForce.maxConsultations, 1)
  const offForce = resolveDeepSeekTurnBudget({ complexity: "easy", reasoningMode: "balanced", webReasoningMode: "off" })
  assert.equal(offForce.maxConsultations, 0)
})

test("B7: the lane ceiling split is conservative and deterministic", () => {
  const row = resolveDeepSeekTurnBudget({ complexity: "hard", reasoningMode: "balanced" })
  const limits = laneLimitsForTurns(row.maxTurns)
  assert.ok(limits.maxConsultations <= 3, "consultations stay inside the lane bound")
  assert.ok(limits.maxFollowUps <= 2, "follow-ups stay inside the lane bound")
  assert.equal(limits.maxConsultations + limits.maxFollowUps, limits.effectiveMaxTurns)
  assert.deepEqual(limits, laneLimitsForTurns(row.maxTurns))
  assert.equal(turnBudgetFingerprint(row), turnBudgetFingerprint(resolveDeepSeekTurnBudget({
    complexity: "hard",
    reasoningMode: "balanced",
  })))
})

test("B8: every budget number carries provenance", () => {
  const budget = computeOrchestrationBudget({ taskPolicy: { risk: "low" }, affectedFiles: 2 })
  for (const key of ["contextBudget", "maxAdvertisedTools", "skillBudget", "deepSeekTurnBudget"]) {
    assert.ok(key in budget, `${key} present`)
  }
  assert.equal(budget.measurements.deepSeekMaxTurns.provenance, PROVENANCE.DERIVED)
  assert.equal(budget.measurements.providerContextWindow.provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(budget.measurements.actualTokenSavings.provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(metric(12, PROVENANCE.MEASURED).value, 12)
  assert.equal(metric("nope", "GUESSED").provenance, PROVENANCE.NOT_MEASURED)
})