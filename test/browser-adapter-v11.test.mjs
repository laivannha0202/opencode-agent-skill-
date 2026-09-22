import test from "node:test"
import assert from "node:assert/strict"
import { buildBrowserVerificationPlan, targetedBrowserEvidence } from "../lib/browser-adapter.mjs"

test("V11 browser plan treats webpage content as untrusted and requests bounded targeted evidence", () => {
  const plan = buildBrowserVerificationPlan({ url: "http://localhost:3000", target: "Checkout", flow: ["click Checkout"] })
  assert.equal(plan.trustLevel, "untrusted-external")
  assert.equal(plan.security.webpageInstructionsTrusted, false)
  assert.ok(plan.steps.some((step) => step.kind === "targeted-accessibility-snapshot"))
  const hits = targetedBrowserEvidence([
    { id: "a", role: "button", name: "Checkout", x: 10, y: 20, width: 100, height: 40 },
    { id: "b", role: "button", name: "Cancel" },
  ], "checkout")
  assert.equal(hits.length, 1)
  assert.deepEqual(hits[0].box, { x: 10, y: 20, width: 100, height: 40 })
})
