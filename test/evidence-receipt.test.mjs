import test from "node:test"
import assert from "node:assert/strict"
import { createVerificationReceipt, validateVerificationReceipt } from "../lib/evidence-receipt.mjs"

test("verification receipts bind command result and output digests", () => {
  const receipt = createVerificationReceipt({
    task: "T1",
    runId: "run-1",
    command: "node",
    args: ["--test"],
    exitCode: 0,
    stdout: "PASS",
    stderr: "",
    workspaceBefore: "a",
    workspaceAfter: "b",
  })
  assert.equal(receipt.passed, true)
  assert.equal(receipt.stdoutSha256.length, 64)
  assert.equal(validateVerificationReceipt(receipt).valid, true)
})
