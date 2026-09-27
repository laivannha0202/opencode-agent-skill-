import test from "node:test"
import assert from "node:assert/strict"

import { adaptiveContextBudget } from "../lib/adaptive-context-budget.mjs"

const HIGH_RISK_DEEP = {
  risk: "high",
  executionProfile: "deep",
  contextBudget: 48_000,
  profile: { name: "deep", contextBudget: 48_000 },
}

test("V15.10 high-risk planner context is role-bounded while execution keeps full evidence", () => {
  const architect = adaptiveContextBudget(HIGH_RISK_DEEP, "architect", 1)
  const checker = adaptiveContextBudget(HIGH_RISK_DEEP, "plan-checker", 1)
  const executor = adaptiveContextBudget(HIGH_RISK_DEEP, "executor", 1)
  const verifier = adaptiveContextBudget(HIGH_RISK_DEEP, "verifier", 1)

  assert.equal(architect.budget, 30_000)
  assert.equal(checker.budget, 24_000)
  assert.equal(architect.reason, "high-risk-planner-role-bounded")
  assert.equal(checker.reason, "high-risk-planner-role-bounded")

  assert.equal(executor.budget, 48_000)
  assert.equal(verifier.budget, 48_000)
  assert.equal(executor.reason, "high-risk-execution-preserves-base-budget")
  assert.equal(verifier.reason, "high-risk-execution-preserves-base-budget")
})

test("V15.10 planner recovery may expand toward the ceiling without changing the executor ceiling", () => {
  const architectRecovery = adaptiveContextBudget(HIGH_RISK_DEEP, "architect", 2)
  const checkerRecovery = adaptiveContextBudget(HIGH_RISK_DEEP, "plan-checker", 2)
  const executorRecovery = adaptiveContextBudget(HIGH_RISK_DEEP, "executor", 2)

  assert.equal(architectRecovery.budget, 45_000)
  assert.equal(checkerRecovery.budget, 36_000)
  assert.equal(executorRecovery.budget, 48_000)
})
