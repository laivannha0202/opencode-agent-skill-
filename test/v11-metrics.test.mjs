import test from "node:test"
import assert from "node:assert/strict"
import { summarizeV11Efficiency, verifiedSuccessPer100kTokens } from "../lib/v11-metrics.mjs"

test("V11 efficiency summary tracks cache/evidence/repair escalation instead of tokens alone", () => {
  const summary = summarizeV11Efficiency([
    {
      promptCache: { stableChars: 800, dynamicChars: 200 },
      repeatedStableChars: 600,
      evidenceStore: { externalizedBytes: 12000, refs: 2 },
      visualRepairAttempts: 1,
      contextExpansions: 1,
      modelEscalations: 0,
    },
    {
      promptCache: { stableChars: 800, dynamicChars: 400 },
      repeatedStableChars: 800,
      evidenceStore: { externalizedBytes: 8000, refs: 1 },
      modelEscalations: 1,
    },
  ])
  assert.equal(summary.totals.samples, 2)
  assert.ok(summary.cacheablePrefixRatio > 0.7)
  assert.equal(summary.totals.externalizedEvidenceBytes, 20000)
  assert.equal(summary.totals.modelEscalations, 1)
})

test("V11 verified success per 100k tokens counts only verified successful runs", () => {
  const value = verifiedSuccessPer100kTokens([
    { passed: true, verified: true, tokens: 50000 },
    { passed: true, verified: false, tokens: 25000 },
    { passed: false, tokens: 25000 },
  ])
  assert.equal(value, 1)
})
