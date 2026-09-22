import test from "node:test"
import assert from "node:assert/strict"
import { buildPromptEnvelope, comparePromptEnvelopes } from "../lib/prompt-cache.mjs"

test("V11 prompt envelope keeps a stable cacheable prefix while task evidence changes", () => {
  const a = buildPromptEnvelope({ role: "executor", invariants: "verify", skills: ["react"], projectFacts: { stack: "react" }, task: { id: "a" } })
  const b = buildPromptEnvelope({ role: "executor", invariants: "verify", skills: ["react"], projectFacts: { stack: "react" }, task: { id: "b" }, evidence: ["new"] })
  assert.equal(a.stablePrefixHash, b.stablePrefixHash)
  assert.notEqual(a.dynamicHash, b.dynamicHash)
  const telemetry = comparePromptEnvelopes(a, b)
  assert.equal(telemetry.stableReused, true)
  assert.ok(telemetry.repeatedStableChars > 0)
})
