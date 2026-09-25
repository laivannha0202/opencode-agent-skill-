import test from "node:test"
import assert from "node:assert/strict"
import { evaluateFastVerificationGate, isBehavioralVerificationReceipt } from "../lib/fast-verification-gate.mjs"

function receipt(command, args, finishedAt, overrides = {}) {
  return { finishedAt, receipt: { id: "receipt-1", command, args, exitCode: 0, passed: true, finishedAt, ...overrides } }
}
const policy = { executionProfile: "fast", singleFileBounded: true, risk: "low" }
const implementation = { exitCode: 0, stopReason: null, report: { sections: { verification: "node --test passed and covered the explicit acceptance cases" } } }

test("FAST verification gate accepts a fresh behavioral test receipt", () => {
  const started = Date.now() - 1000
  const row = receipt("node", ["--test", ".ues-cache/fast-acceptance.test.mjs"], new Date().toISOString())
  assert.equal(isBehavioralVerificationReceipt(row), true)
  const gate = evaluateFastVerificationGate({ policy, implementation, receipts: [row], attemptStartedAtMs: started })
  assert.equal(gate.passed, true)
  assert.equal(gate.behavioralReceiptCount, 1)
})

test("FAST verification gate rejects build-only evidence", () => {
  const row = receipt("npm", ["run", "build"], new Date().toISOString())
  assert.equal(isBehavioralVerificationReceipt(row), false)
  const gate = evaluateFastVerificationGate({ policy, implementation, receipts: [row], attemptStartedAtMs: Date.now() - 1000 })
  assert.equal(gate.passed, false)
  assert.equal(gate.reason, "no-fresh-behavioral-receipt")
})

test("FAST verification gate rejects receipts from before the implementation attempt", () => {
  const started = Date.now()
  const row = receipt("node", ["--test", ".ues-cache/old.test.mjs"], new Date(started - 5000).toISOString())
  const gate = evaluateFastVerificationGate({ policy, implementation, receipts: [row], attemptStartedAtMs: started })
  assert.equal(gate.passed, false)
  assert.equal(gate.reason, "no-fresh-behavioral-receipt")
})

test("FAST verification gate rejects missing verification report or non-FAST policy", () => {
  const row = receipt("pnpm", ["test", "--", "thing.spec.ts"], new Date().toISOString())
  const missingReport = evaluateFastVerificationGate({ policy, implementation: { exitCode: 0, report: { sections: {} } }, receipts: [row], attemptStartedAtMs: Date.now() - 1000 })
  assert.equal(missingReport.passed, false)
  assert.equal(missingReport.reason, "implementation-did-not-report-verification")
  const highRisk = evaluateFastVerificationGate({ policy: { ...policy, risk: "high" }, implementation, receipts: [row], attemptStartedAtMs: Date.now() - 1000 })
  assert.equal(highRisk.passed, false)
  assert.equal(highRisk.reason, "not-fast-bounded")
})
