import test from "node:test"
import assert from "node:assert/strict"

import {
  planningRuntimeBudget,
  shouldSoftSteerArchitect,
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

test("V15.6 plan-checker is bounded without changing executor budgets", () => {
  const checker = planningRuntimeBudget("plan-checker", 1)
  assert.equal(checker.hardTimeoutMs, 45_000)
  assert.equal(checker.idleTimeoutMs, 20_000)
  assert.equal(planningRuntimeBudget("executor", 1), null)
  assert.equal(planningRuntimeBudget("verifier", 1), null)
})
