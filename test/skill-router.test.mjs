import test from "node:test"
import assert from "node:assert/strict"
import { routeSkills } from "../global-config/plugins/ues-router/router.js"

test("v2 router selects focused process and domain skills", () => {
  assert.deepEqual(
    routeSkills("Fix an auth permission regression where a tenant can edit another tenant resource.", 4),
    [
      "ues-engineering-orchestrator",
      "ues-bug-diagnosis",
      "ues-auth-security",
      "ues-change-impact-analysis",
    ],
  )

  assert.deepEqual(
    routeSkills("React Native Android screen regression after a Gradle change", 4),
    [
      "ues-engineering-orchestrator",
      "ues-bug-diagnosis",
      "ues-react-native-engineering",
    ],
  )

  assert.deepEqual(
    routeSkills("Please review this code", 2),
    ["ues-engineering-orchestrator"],
  )
})

test("v2 router caps automatic skills and falls back to repo exploration", () => {
  const routed = routeSkills(
    "Fix a payment webhook auth regression involving database migration and API contract compatibility.",
    3,
  )
  assert.equal(routed.length, 3)
  assert.deepEqual(routeSkills("Find the repository function that formats labels.", 4), ["ues-repo-explorer"])
})

test("v2 router adds persistent planning skills for explicit long-horizon work", () => {
  assert.deepEqual(
    routeSkills("Implement a large task across the whole repository with many files and keep it resumable.", 4),
    [
      "ues-engineering-orchestrator",
      "ues-long-task-state",
      "ues-task-planner",
    ],
  )
})



test("resume-style long-horizon prompts always include the orchestrator", () => {
  const routed = routeSkills(
    "Resume this work across many files and keep a durable execution plan.",
    6,
  )
  assert.ok(routed.includes("ues-engineering-orchestrator"))
  assert.ok(routed.includes("ues-long-task-state"))
  assert.ok(routed.includes("ues-task-planner"))
})
