import test from "node:test"
import assert from "node:assert/strict"

import {
  planningRuntimeBudget,
  shouldSoftSteerArchitect,
  shouldSoftSteerPlanningRole,
} from "../lib/planning-speed-policy.mjs"

test("V15.6 architect planning is hard-bounded and recovery is tighter", () => {
  const first = planningRuntimeBudget("architect", 1)
  const recovery = planningRuntimeBudget("ues-architect", 2)

  assert.equal(first.hardTimeoutMs, 60_000)
  assert.equal(first.idleTimeoutMs, 25_000)
  assert.equal(first.softSteerMs, 30_000)
  assert.equal(first.maxExplorationTools, 16)

  assert.equal(recovery.hardTimeoutMs, 45_000)
  assert.equal(recovery.idleTimeoutMs, 18_000)
  assert.ok(recovery.hardTimeoutMs < first.hardTimeoutMs)
})

test("V15.6 architect soft-steers before idle watchdog or runaway exploration", () => {
  const budget = planningRuntimeBudget("architect", 1)
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 31_000, idleMs: 1_000, toolCalls: 5 }, budget),
    true,
  )
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 10_000, idleMs: 1_000, toolCalls: 16 }, budget),
    true,
  )
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 10_000, idleMs: 18_000, toolCalls: 4 }, budget),
    true,
  )
  assert.equal(
    shouldSoftSteerArchitect({ elapsedMs: 10_000, idleMs: 2_000, toolCalls: 4 }, budget),
    false,
  )
})

test("V15.8 plan-checker is adaptive, soft-steered, and recovers tighter", () => {
  const checker = planningRuntimeBudget("plan-checker", 1)
  const recovery = planningRuntimeBudget("ues-plan-checker", 2)

  assert.equal(checker.hardTimeoutMs, 75_000)
  assert.equal(checker.idleTimeoutMs, 30_000)
  assert.equal(checker.softSteerMs, 35_000)
  assert.equal(checker.maxExplorationTools, 10)

  assert.equal(recovery.hardTimeoutMs, 40_000)
  assert.equal(recovery.idleTimeoutMs, 15_000)
  assert.equal(recovery.softSteerMs, 18_000)
  assert.equal(recovery.maxExplorationTools, 6)

  assert.equal(
    shouldSoftSteerPlanningRole({ elapsedMs: 36_000, idleMs: 1_000, toolCalls: 5 }, checker),
    true,
  )
  assert.equal(planningRuntimeBudget("executor", 1), null)
  assert.equal(planningRuntimeBudget("verifier", 1), null)
})
