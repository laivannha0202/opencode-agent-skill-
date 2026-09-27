import test from "node:test"
import assert from "node:assert/strict"

import { createAdaptiveDeadline } from "../lib/activity-deadline.mjs"

test("V15.10 active work extends the initial deadline but never beyond the absolute cap", () => {
  const startedAt = 1_000
  const deadline = createAdaptiveDeadline({
    hardTimeoutMs: 60_000,
    absoluteHardTimeoutMs: 150_000,
    activityExtensionMs: 35_000,
    activityWindowMs: 20_000,
  }, startedAt)

  const first = deadline.shouldAbort(61_000, 59_000)
  assert.equal(first.abort, false)
  assert.equal(first.extended, true)
  assert.equal(deadline.extensions, 1)

  const second = deadline.shouldAbort(deadline.deadlineAt, deadline.deadlineAt - 1_000)
  assert.equal(second.abort, false)
  assert.equal(second.extended, true)

  while (deadline.deadlineAt < deadline.absoluteAt) {
    const now = deadline.deadlineAt
    const next = deadline.shouldAbort(now, now - 1_000)
    assert.equal(next.abort, false)
  }

  const final = deadline.shouldAbort(deadline.absoluteAt, deadline.absoluteAt - 1_000)
  assert.equal(final.abort, true)
  assert.equal(final.reason, "absolute-hard-timeout")
})

test("V15.10 stale activity does not extend a hard deadline", () => {
  const deadline = createAdaptiveDeadline({
    hardTimeoutMs: 60_000,
    absoluteHardTimeoutMs: 150_000,
    activityExtensionMs: 35_000,
    activityWindowMs: 20_000,
  }, 0)

  const result = deadline.shouldAbort(60_000, 30_000)
  assert.equal(result.abort, true)
  assert.equal(result.reason, "hard-timeout")
  assert.equal(deadline.extensions, 0)
})
