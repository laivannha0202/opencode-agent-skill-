import test from "node:test"
import assert from "node:assert/strict"
import { classifyEngineeringTask } from "../lib/orchestrator-policy.mjs"
import { routeSkills, routeSkillsForPolicy } from "../global-config/plugins/ues-router/router.js"

test("FAST runtime routing drops generic orchestration and keeps direct skills", () => {
  const prompt = "Fix this React useEffect stale closure bug."
  const policy = classifyEngineeringTask(prompt)
  assert.equal(policy.executionProfile, "fast")

  const legacy = routeSkills(prompt, 6)
  assert.ok(legacy.includes("ues-engineering-orchestrator"))

  const routed = routeSkillsForPolicy(prompt, policy, policy.maxSkills)
  assert.deepEqual(routed, [
    "ues-react-engineering",
    "ues-bug-diagnosis",
  ])
})

test("FAST review loads review skill without generic orchestrator", () => {
  const prompt = "Review this local helper."
  const policy = classifyEngineeringTask(prompt)
  const routed = routeSkillsForPolicy(prompt, policy, 2)
  assert.ok(routed.includes("ues-code-review"))
  assert.equal(routed.includes("ues-engineering-orchestrator"), false)
})

test("DEEP runtime routing preserves orchestrated high-risk skills", () => {
  const prompt = "Fix an auth permission regression where another tenant can edit this resource."
  const policy = classifyEngineeringTask(prompt)
  assert.equal(policy.executionProfile, "deep")
  const routed = routeSkillsForPolicy(prompt, policy, 6)
  assert.ok(routed.includes("ues-engineering-orchestrator"))
  assert.ok(routed.includes("ues-auth-security"))
  assert.ok(routed.includes("ues-change-impact-analysis"))
})


test("explicit long/high-risk annotations hard-override FAST routing", () => {
  const policy = classifyEngineeringTask("Treat this as long/high-risk and finish the approved refactor safely.")
  assert.equal(policy.risk, "high")
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.contextBudget, 48_000)
  assert.equal(policy.profile.durableState, true)
})

test("structured facts can force long/high-risk without depending on score", () => {
  const policy = classifyEngineeringTask("Small textual description.", {
    risk: "high",
    longHorizon: true,
  })
  assert.equal(policy.risk, "high")
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.executionProfile, "deep")
})
