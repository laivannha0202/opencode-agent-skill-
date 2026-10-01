import test from "node:test"
import assert from "node:assert/strict"
import { safeRemovePath } from "../lib/fs-cleanup.mjs"

test("V16 safeRemovePath retries transient Windows-style lock failures", async () => {
  let calls = 0
  const result = await safeRemovePath("ignored", {
    retries: 4,
    retryDelayMs: 10,
    rmImpl: async () => {
      calls += 1
      if (calls < 3) {
        const error = new Error("resource busy")
        error.code = calls === 1 ? "EBUSY" : "EPERM"
        throw error
      }
    },
  })
  assert.equal(result.removed, true)
  assert.equal(result.attempts, 3)
  assert.equal(calls, 3)
})

test("V16 safeRemovePath does not retry non-transient failures", async () => {
  let calls = 0
  await assert.rejects(
    safeRemovePath("ignored", {
      retries: 4,
      retryDelayMs: 10,
      rmImpl: async () => {
        calls += 1
        const error = new Error("invalid path")
        error.code = "EINVAL"
        throw error
      },
    }),
    /invalid path/,
  )
  assert.equal(calls, 1)
})
