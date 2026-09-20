import test from "node:test"
import assert from "node:assert/strict"
import { classifyEngineeringTask } from "../lib/orchestrator-policy.mjs"

test("adaptive task policy escalates risky long-horizon work", () => {
  const policy = classifyEngineeringTask(
    "Refactor the entire repository authentication schema migration and public API contracts across many modules.",
  )
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.risk, "high")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
})

test("small local work stays inline", () => {
  const policy = classifyEngineeringTask("Rename a local helper.")
  assert.equal(policy.mode, "inline")
  assert.equal(policy.modelTier, "light")
})


test("declared high risk metadata forces heavy policy", () => {
  const policy = classifyEngineeringTask("Change a local helper", { risk: "high" })
  assert.equal(policy.risk, "high")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
  assert.equal(policy.contextBudget, 48_000)
  assert.ok(policy.signals.some((item) => item.name === "declared-high-risk"))
})

test("risk text annotation is recognized by runtime policy", () => {
  const policy = classifyEngineeringTask("Update helper risk: high")
  assert.equal(policy.risk, "high")
  assert.equal(policy.modelTier, "heavy")
})
