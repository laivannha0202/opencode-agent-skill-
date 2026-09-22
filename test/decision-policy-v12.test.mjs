import test from "node:test"
import assert from "node:assert/strict"
import { canAutoResolveDecision, classifyDecisionPolicy } from "../lib/decision-policy.mjs"
test("V12 decision policy allows reversible local choices", () => {
  assert.equal(canAutoResolveDecision("Use a temporary local fixture and rename the internal helper"),true)
})
test("V12 decision policy requires a human for publish/deploy choices", () => {
  const result = classifyDecisionPolicy("npm publish then deploy to production")
  assert.equal(result.requiresUser,true); assert.equal(result.autoResolvable,false); assert.equal(result.risk,"high")
})
