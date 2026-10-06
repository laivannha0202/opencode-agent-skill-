import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { validateV16_8SourceIntegrity } from "../scripts/check-source-integrity.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("V16.8 source integrity: new production barrier sources are protected locally", () => {
  assert.deepEqual(validateV16_8SourceIntegrity(ROOT), [])
})
