// V16.12 source-integrity regression.
//
// Adding V16.12 must NEVER weaken a prior release. This test proves the whole
// chain of contracts still holds: V16.8, V16.9, V16.10, V16.11 AND the new
// V16.12 all validate with ZERO issues against the shipped tree. If any V16.12
// marker is dropped, or a prior release's contract is broken, this fails.

import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  validateV16_8SourceIntegrity,
  validateV16_9SourceIntegrity,
  validateV16_10SourceIntegrity,
  validateV16_11SourceIntegrity,
  validateV16_12SourceIntegrity,
} from "../scripts/check-source-integrity.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.12 source integrity: every V16.12 contract marker is present", () => {
  assert.deepEqual(validateV16_12SourceIntegrity(ROOT), [])
})

test("V16.12 source integrity: V16.11 is still fully enforced", () => {
  assert.deepEqual(validateV16_11SourceIntegrity(ROOT), [])
})

test("V16.12 source integrity: V16.10 is still fully enforced", () => {
  assert.deepEqual(validateV16_10SourceIntegrity(ROOT), [])
})

test("V16.12 source integrity: V16.9 is still fully enforced (no weakening)", () => {
  assert.deepEqual(validateV16_9SourceIntegrity(ROOT), [])
})

test("V16.12 source integrity: V16.8 is still fully enforced", () => {
  assert.deepEqual(validateV16_8SourceIntegrity(ROOT), [])
})

test("V16.12 source integrity: the V16.12 policy ids stay byte-stable", async () => {
  const receipt = await import("../lib/verification-receipt-cache-v16-12.mjs")
  const dag = await import("../lib/task-dag-scheduler-v16-12.mjs")
  const reuse = await import("../lib/tool-result-reuse-v16-12.mjs")
  const incr = await import("../lib/incremental-verification-v16-12.mjs")
  const warm = await import("../lib/warm-service-reuse-v16-12.mjs")
  const accel = await import("../lib/execution-acceleration-v16-12.mjs")
  const waste = await import("../lib/waste-detector-v16-12.mjs")
  assert.equal(receipt.RECEIPT_CACHE_POLICY, "verification-receipt-cache-v16-12")
  assert.equal(dag.TASK_DAG_POLICY, "task-dag-scheduler-v16-12")
  assert.equal(reuse.TOOL_RESULT_REUSE_POLICY, "tool-result-reuse-v16-12")
  assert.equal(incr.INCREMENTAL_VERIFICATION_POLICY, "incremental-verification-v16-12")
  assert.equal(warm.WARM_SERVICE_POLICY, "warm-service-reuse-v16-12")
  assert.equal(accel.EXECUTION_ACCELERATION_POLICY, "execution-acceleration-v16-12")
  assert.equal(waste.WASTE_DETECTOR_POLICY, "waste-detector-v16-12")
})
