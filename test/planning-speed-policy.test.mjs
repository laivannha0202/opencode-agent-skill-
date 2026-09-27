import test from "node:test"
import assert from "node:assert/strict"

import {
  planningRuntimeBudget,
  shouldSoftSteerArchitect,
  shouldSoftSteerPlanningRole,
} from "../lib/planning-speed-policy.mjs"

test("V15.10 architect planning has an activity-aware ceiling and tighter recovery", () => {
  const first = planningRuntimeBudget("architect", 1, {
    executionProfile: "deep",
    taskChars: 5000,
  })
  const recovery = planningRuntimeBudget("ues-architect", 2, {
    executionProfile: "deep",
    taskChars: 5000,
  })

  assert.equal(first.hardTimeoutMs, 60_000)
  assert.equal(first.absoluteHardTimeoutMs, 150_000)
  assert.equal(first.activityExtensionMs, 35_000)
  assert.equal(first.activityWindowMs, 20_000)
  assert.equal(first.idleTimeoutMs, 40_000)
  assert.equal(first.softSteerMs, 30_000)
  assert.equal(first.maxExplorationTools, 16)

  assert.equal(recovery.hardTimeoutMs, 50_000)
  assert.equal(recovery.absoluteHardTimeoutMs, 95_000)
  assert.equal(recovery.activityExtensionMs, 25_000)
  assert.equal(recovery.idleTimeoutMs, 28_000)
  assert.ok(recovery.absoluteHardTimeoutMs < first.absoluteHardTimeoutMs)
})

test("V15.10 architect soft-steers before idle watchdog or runaway exploration", () => {
  const budget = planningRuntimeBudget("architect", 1, { executionProfile: "deep" })
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 31_000, idleMs: 1_000, toolCalls: 5 }, budget),
    true,
  )
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 10_000, idleMs: 1_000, toolCalls: 16 }, budget),
    true,
  )
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 10_000, idleMs: 27_000, toolCalls: 4 }, budget),
    true,
  )
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 10_000, idleMs: 2_000, toolCalls: 4 }, budget),
    false,
  )
})

test("V15.10 plan-checker uses bounded activity extension and shorter recovery", () => {
  const checker = planningRuntimeBudget("plan-checker", 1, { executionProfile: "deep" })
  const recovery = planningRuntimeBudget("ues-plan-checker", 2, { executionProfile: "deep" })

  assert.equal(checker.hardTimeoutMs, 70_000)
  assert.equal(checker.absoluteHardTimeoutMs, 130_000)
  assert.equal(checker.activityExtensionMs, 30_000)
  assert.equal(checker.idleTimeoutMs, 38_000)
  assert.equal(checker.softSteerMs, 35_000)
  assert.equal(checker.maxExplorationTools, 10)

  assert.equal(recovery.hardTimeoutMs, 45_000)
  assert.equal(recovery.absoluteHardTimeoutMs, 80_000)
  assert.equal(recovery.activityExtensionMs, 20_000)
  assert.equal(recovery.idleTimeoutMs, 24_000)
  assert.equal(recovery.softSteerMs, 18_000)
  assert.equal(recovery.maxExplorationTools, 6)

  assert.equal(
    shouldSoftSteerPlanningRole({ elapsedMs: 36_000, idleMs: 1_000, toolCalls: 5 }, checker),
    true,
  )
  assert.equal(planningRuntimeBudget("executor", 1), null)
  assert.equal(planningRuntimeBudget("verifier", 1), null)
})
