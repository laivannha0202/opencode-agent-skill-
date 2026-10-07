// V16.10 Semantic Tool Router: behavior tests.
//
// The router must pick the right tool for a stated intent, never widen the
// surface, never advertise a denied tool, and never rank a writer tool for a
// read-only run.

import test from "node:test"
import assert from "node:assert/strict"
import {
  TOOL_ROUTER_POLICY,
  ROUTE_INTENT,
  classifyRouteIntents,
  routeToolIntent,
  rankCandidateTools,
  assertRouteRespectsDenied,
  mergeRouteIntoPriorities,
} from "../lib/semantic-tool-router-v16-10.mjs"

const UNIVERSE = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "ues_code", "ues_code_edit", "ues_service", "ues_evidence_get", "ues_tool_search"]

test("V16.10 tool router: routes core intents to the correct tool", () => {
  const cases = [
    ["read the file lib/foo.mjs and show its content", "read"],
    ["search the codebase for buildRepoMap", "grep"],
    ["run the test suite to verify", "bash"],
    ["create a new file for the budgeter", "write"],
    ["start the dev server", "ues_service"],
    ["fetch the full evidence for the truncated ref", "ues_evidence_get"],
    ["list the project structure", "ls"],
  ]
  for (const [task, expected] of cases) {
    const plan = routeToolIntent({ task, universe: UNIVERSE, writer: true })
    assert.equal(plan.primary, expected, `task "${task}" should route to ${expected}, got ${plan.primary}`)
    assert.equal(plan.policy, TOOL_ROUTER_POLICY)
  }
})

test("V16.10 tool router: a short token never substring-matches inside an identifier", () => {
  // Regression: "ui" must not match inside "buildRepoMap" and pull the browser
  // lane into a symbol lookup.
  const classification = classifyRouteIntents({ task: "find where buildRepoMap is defined", universe: UNIVERSE })
  assert.ok(classification.intents.includes(ROUTE_INTENT.LOCATE_CODE))
  assert.ok(!classification.intents.includes(ROUTE_INTENT.BROWSE_WEB))
})

test("V16.10 tool router: writer-only tools are withheld from a read-only run", () => {
  const plan = routeToolIntent({ task: "edit the configuration and change the port", universe: UNIVERSE, writer: false })
  assert.ok(!plan.ordered.includes("edit"))
  assert.ok(!plan.ordered.includes("write"))
  assert.ok(!plan.ordered.includes("ues_code_edit"))
})

test("V16.10 tool router: the router can never widen the caller's universe", () => {
  const small = ["read", "grep"]
  const plan = routeToolIntent({ task: "run the tests and edit the file", universe: small, writer: true })
  for (const tool of plan.ordered) assert.ok(small.includes(tool))
  const check = assertRouteRespectsDenied(plan, small, [])
  assert.equal(check.ok, true)
  assert.equal(plan.widened, false)
})

test("V16.10 tool router: denied tools never appear in a plan", () => {
  const plan = routeToolIntent({ task: "edit the file", universe: UNIVERSE, denied: ["edit", "write"], writer: true })
  assert.ok(!plan.ordered.includes("edit"))
  assert.ok(!plan.ordered.includes("write"))
  const check = assertRouteRespectsDenied(plan, UNIVERSE, ["edit", "write"])
  assert.equal(check.ok, true)
})

test("V16.10 tool router: assertRouteRespectsDenied catches a hand-built violation", () => {
  const check = assertRouteRespectsDenied({ ordered: ["read", "edit", "not-in-universe"] }, ["read", "edit"], ["edit"])
  assert.equal(check.ok, false)
  assert.deepEqual(check.deniedPresent, ["edit"])
  assert.deepEqual(check.outsideUniverse, ["not-in-universe"])
})

test("V16.10 tool router: confidence is derived from the margin, never fabricated", () => {
  const strong = routeToolIntent({ task: "start the dev server", universe: UNIVERSE })
  assert.equal(strong.confidence, "high")
  assert.equal(strong.provenance.confidence.provenance, "DERIVED")
  // A task matching nothing routable yields no primary and "none" confidence.
  const empty = routeToolIntent({ task: "zzzz", universe: ["read"] })
  assert.equal(empty.primary, null)
  assert.equal(empty.confidence, "none")
})

test("V16.10 tool router: merge reorders priorities without widening them", () => {
  const plan = routeToolIntent({ task: "run the tests", universe: UNIVERSE, writer: false })
  const merged = mergeRouteIntoPriorities(["read", "grep", "edit"], plan, UNIVERSE, ["edit"])
  // bash (routed) leads, edit is denied and gone, and nothing new appeared.
  assert.equal(merged[0], "bash")
  assert.ok(!merged.includes("edit"))
  for (const tool of merged) assert.ok(["read", "grep", "edit", ...plan.ordered].includes(tool))
})

test("V16.10 tool router: ranking is deterministic across runs", () => {
  const a = routeToolIntent({ task: "search for the symbol and read the file", universe: UNIVERSE, writer: true })
  const b = routeToolIntent({ task: "search for the symbol and read the file", universe: UNIVERSE, writer: true })
  assert.deepEqual(a.ordered, b.ordered)
  assert.equal(a.deterministic, true)
})

test("V16.10 tool router: the discovery dispatcher never outranks a concrete match", () => {
  const rows = rankCandidateTools({ task: "read the file", universe: UNIVERSE, writer: false })
  const dispatcher = rows.find((row) => row.tool === "ues_tool_search")
  const read = rows.find((row) => row.tool === "read")
  assert.ok(read)
  if (dispatcher) assert.ok(read.score > dispatcher.score)
})
