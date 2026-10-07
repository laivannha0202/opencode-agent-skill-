import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  validateV16_8SourceIntegrity,
  validateV16_9SourceIntegrity,
} from "../scripts/check-source-integrity.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.9 source integrity: new lifecycle/evidence modules are protected locally", () => {
  assert.deepEqual(validateV16_9SourceIntegrity(ROOT), [])
})

test("V16.9 source integrity: the V16.8 contracts are still enforced", () => {
  // Adding V16.9 must never weaken the previous release's contracts.
  assert.deepEqual(validateV16_8SourceIntegrity(ROOT), [])
})
