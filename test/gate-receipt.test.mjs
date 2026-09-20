import test from "node:test"
import assert from "node:assert/strict"
import { createGateReceipt, validateGateReceipt } from "../lib/gate-receipt.mjs"

test("gate receipt binds plan approval evidence", () => {
  const receipt = createGateReceipt({
    kind: "plan-verification",
    slug: "demo",
    verdict: "PASS",
    verifier: "ues-plan-checker",
    planHash: "abc123",
    evidence: "plan checker PASS",
    report: "review report",
  })
  assert.equal(validateGateReceipt(receipt).valid, true)
  assert.equal(receipt.kind, "plan-verification")
  assert.equal(receipt.planHash, "abc123")
  assert.match(receipt.reportHash, /^[a-f0-9]{64}$/)
})

test("integration gate receipt requires workspace fingerprint", () => {
  const receipt = createGateReceipt({
    kind: "integration-verification",
    slug: "demo",
    verdict: "PASS",
    verifier: "ues-integration-verifier",
    evidence: "integration PASS",
  })
  const result = validateGateReceipt(receipt)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((item) => item.includes("workspaceFingerprint")))
})
