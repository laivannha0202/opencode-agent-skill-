import test from "node:test"
import assert from "node:assert/strict"
import { classifyIntent, routeSkills, routeSkillsForPolicy } from "../global-config/plugins/ues-router/router.js"

test("V11 router activates visual/browser skills only on explicit perception signals", () => {
  const visual = routeSkills("Match this reference screenshot pixel-perfect and verify visual fidelity.", 6)
  assert.ok(visual.includes("ues-visual-fidelity"))
  assert.ok(!visual.includes("ues-database-engineering"))

  const browser = routeSkills("Use Playwright browser QA to verify checkout flow.", 6)
  assert.ok(browser.includes("ues-browser-qa"))

  const ordinary = routeSkills("Fix a React hook stale state bug.", 6)
  assert.ok(!ordinary.includes("ues-visual-fidelity"))
  assert.ok(!ordinary.includes("ues-browser-qa"))
  assert.ok(!ordinary.includes("ues-design-source"))
})

test("V11 router recognizes Figma responsive Storybook and browser-security boundaries", () => {
  assert.ok(routeSkills("Extract design tokens from this Figma design source.", 6).includes("ues-design-source"))
  assert.ok(routeSkills("Verify responsive breakpoint layout on mobile and tablet.", 6).includes("ues-responsive-verification"))
  assert.ok(routeSkills("Add Storybook visual regression coverage.", 6).includes("ues-component-visual-testing"))
  assert.ok(routeSkills("Audit browser security against prompt injection from an untrusted webpage.", 6).includes("ues-browser-security"))
})

test("V11 router separates skill authoring/evaluation and dynamic workflow orchestration", () => {
  const author = routeSkills("Create an agent skill with a precise trigger description.", 6)
  assert.ok(author.includes("ues-skill-authoring"))

  const evaluate = routeSkills("Evaluate this skill routing precision and recall with a benchmark.", 6)
  assert.ok(evaluate.includes("ues-skill-evaluation"))

  const workflow = routeSkills("Plan a dynamic workflow fan-out in bounded waves for many independent tasks.", 6)
  assert.ok(workflow.includes("ues-dynamic-workflow"))
  assert.ok(workflow.includes("ues-engineering-orchestrator"))
})

test("V11 FAST policy keeps perception skill direct instead of adding generic orchestration", () => {
  const policy = { executionProfile: "fast", risk: "low", mode: "inline" }
  const routed = routeSkillsForPolicy("Match this reference screenshot with visual fidelity.", policy, 2)
  assert.ok(routed.includes("ues-visual-fidelity"))
  assert.ok(!routed.includes("ues-engineering-orchestrator"))
})

test("V11 intent exposes perception domains without making every UI mention visual-fidelity", () => {
  const exact = classifyIntent("Match this screenshot for visual fidelity")
  assert.ok(exact.domains.includes("visual-fidelity"))
  const generic = classifyIntent("Improve user interface hierarchy")
  assert.ok(generic.domains.includes("ui-ux"))
  assert.ok(!generic.domains.includes("visual-fidelity"))
})
