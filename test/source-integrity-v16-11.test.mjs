// V16.11 source-integrity regression.
//
// Adding V16.11 must NEVER weaken a prior release. This test proves the whole
// chain of contracts still holds: V16.8, V16.9, V16.10 AND the new V16.11 all
// validate with ZERO issues against the shipped tree. If any V16.11 marker is
// dropped, or a prior release's contract is broken, this fails.

import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  validateV16_8SourceIntegrity,
  validateV16_9SourceIntegrity,
  validateV16_10SourceIntegrity,
  validateV16_11SourceIntegrity,
} from "../scripts/check-source-integrity.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.11 source integrity: every V16.11 contract marker is present", () => {
  assert.deepEqual(validateV16_11SourceIntegrity(ROOT), [])
})

test("V16.11 source integrity: V16.10 is still fully enforced", () => {
  assert.deepEqual(validateV16_10SourceIntegrity(ROOT), [])
})

test("V16.11 source integrity: V16.9 is still fully enforced (no weakening)", () => {
  assert.deepEqual(validateV16_9SourceIntegrity(ROOT), [])
})

test("V16.11 source integrity: V16.8 is still fully enforced", () => {
  assert.deepEqual(validateV16_8SourceIntegrity(ROOT), [])
})

test("V16.11 source integrity: the V16.9 session-manager policy id stays byte-stable", async () => {
  const { ADVISOR_SESSION_MANAGER_POLICY, ADVISOR_SESSION_MANAGER_IMPLEMENTATION } = await import("../lib/advisor-session-manager.mjs")
  assert.equal(ADVISOR_SESSION_MANAGER_POLICY, "advisor-session-manager-v16-9")
  assert.equal(ADVISOR_SESSION_MANAGER_IMPLEMENTATION, "advisor-session-manager-v16-11")
})
