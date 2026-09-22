import test from "node:test"
import assert from "node:assert/strict"
import { routeSkills, routeSkillsForPolicy } from "../global-config/plugins/ues-router/router.js"
import { classifyEngineeringTask } from "../lib/orchestrator-policy.mjs"

test("V11 screenshot fidelity routes visual skill without generic orchestration on FAST tasks", () => {
  const text = "Match this reference screenshot with exact visual fidelity."
  const policy = classifyEngineeringTask(text)
  const routed = routeSkillsForPolicy(text, policy, 4)
  assert.ok(routed.includes("ues-visual-fidelity"))
})

test("V11 Playwright flow routes browser QA", () => {
  const text = "Use Playwright to verify this browser checkout flow and element positions."
  const routed = routeSkills(text, 6)
  assert.ok(routed.includes("ues-browser-qa"))
})

test("V11 Figma design source routes structured design extraction", () => {
  const routed = routeSkills("Translate this Figma design source into reusable design tokens.", 6)
  assert.ok(routed.includes("ues-design-source"))
})

test("V11 skill authoring and evaluation can co-route", () => {
  const routed = routeSkills("Create a new agent skill and benchmark its routing precision and recall.", 6)
  assert.ok(routed.includes("ues-skill-authoring"))
  assert.ok(routed.includes("ues-skill-evaluation"))
})

test("V11 dynamic workflow routes only when fan-out intent is explicit", () => {
  const routed = routeSkills("Plan a dynamic workflow fan-out for many independent migration tasks.", 6)
  assert.ok(routed.includes("ues-dynamic-workflow"))
  const small = routeSkills("Fix one helper function.", 6)
  assert.equal(small.includes("ues-dynamic-workflow"), false)
})


test("V11 router rejects perception terminology polysemy", () => {
  const design = classifyIntent("Extract design tokens from this Figma design source.")
  assert.ok(!design.domains.includes("auth-security"))
  assert.deepEqual(routeSkills("Extract design tokens from this Figma design source.", 6), ["ues-design-source"])

  const visualRegression = routeSkills("Add Storybook visual regression coverage.", 6)
  assert.ok(visualRegression.includes("ues-component-visual-testing"))
  assert.ok(!visualRegression.includes("ues-bug-diagnosis"))

  const skillEval = classifyIntent("Evaluate this skill routing precision and recall with a benchmark.")
  assert.notEqual(skillEval.risk, "high")
  assert.deepEqual(routeSkills("Evaluate this skill routing precision and recall with a benchmark.", 6), ["ues-skill-evaluation"])
})
