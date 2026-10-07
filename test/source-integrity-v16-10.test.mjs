import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  validateV16_8SourceIntegrity,
  validateV16_9SourceIntegrity,
  validateV16_10SourceIntegrity,
} from "../scripts/check-source-integrity.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.10 source integrity: the six capability owners are protected locally", () => {
  assert.deepEqual(validateV16_10SourceIntegrity(ROOT), [])
})

test("V16.10 source integrity: the V16.9 contracts are still enforced", () => {
  // Adding V16.10 must never weaken the previous release's contracts.
  assert.deepEqual(validateV16_9SourceIntegrity(ROOT), [])
})

test("V16.10 source integrity: the V16.8 contracts are still enforced", () => {
  assert.deepEqual(validateV16_8SourceIntegrity(ROOT), [])
})
