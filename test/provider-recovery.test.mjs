import assert from "node:assert/strict"
import test from "node:test"
import { classifyProviderFailure, providerRecoveryBackoffMs } from "../lib/provider-recovery.mjs"

test("empty provider response is retryable only before tool side effects", () => {
  const clean = classifyProviderFailure({
    output: "Error: Provider returned an empty response (no content emitted)",
    stderr: "Provider returned an empty response (no content emitted)",
    stopReason: "error",
    toolCalls: 0,
  })
  assert.equal(clean.transient, true)
  assert.equal(clean.reason, "empty-provider-response")
  assert.equal(clean.safeReplay, true)

  const afterTools = classifyProviderFailure({
    output: "(no assistant output)",
    stopReason: "error",
    toolCalls: 4,
  })
  assert.equal(afterTools.transient, true)
  assert.equal(afterTools.safeReplay, false)
})

test("normal model errors are not misclassified as empty-provider failures", () => {
  const result = classifyProviderFailure({
    output: "The requested verification failed.",
    stderr: "rate limit exceeded",
    stopReason: "error",
    toolCalls: 0,
  })
  assert.equal(result.transient, false)
  assert.equal(result.safeReplay, false)
})

test("provider recovery backoff is deterministic and bounded", () => {
  assert.equal(providerRecoveryBackoffMs(1, { baseMs: 200, maxMs: 1000 }), 200)
  assert.equal(providerRecoveryBackoffMs(2, { baseMs: 200, maxMs: 1000 }), 400)
  assert.equal(providerRecoveryBackoffMs(5, { baseMs: 200, maxMs: 1000 }), 1000)
})
