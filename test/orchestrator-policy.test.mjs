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


test("explicit long-horizon wording forces durable deep mode even without a high-risk domain", () => {
  const policy = classifyEngineeringTask("Refactor the entire project safely with integration verification.")
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
  assert.equal(policy.requireIntegrationVerification, true)
  assert.equal(policy.profile.durableState, true)
})

test("Vietnamese large-refactor workflow wording is classified as long-horizon", () => {
  const policy = classifyEngineeringTask(
    "Phân tích toàn bộ project hiện tại và thực hiện một refactor lớn nhưng an toàn. Chia công việc thành các task có dependency; cuối cùng phải có integration verification và chỉ finalize khi các gate cho phép.",
  )
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
  assert.equal(policy.requireIntegrationVerification, true)
  assert.equal(policy.antiHallucination.noCompletionWithoutVerification, true)
  assert.ok(policy.signals.some((item) => item.name === "explicit-long-horizon"))
})
