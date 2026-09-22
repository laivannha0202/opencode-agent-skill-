import test from "node:test"
import assert from "node:assert/strict"
import { summarizeEvalResults } from "../lib/eval-report.mjs"

test("eval report summarizes pass-rate delta and efficiency telemetry", () => {
  const result = summarizeEvalResults([
    { task: "a", mode: "baseline", passed: true, durationMs: 100, telemetry: { jsonLines: 1, toolCalls: 2, usageSamples: 1, tokens: { total: 100 }, firstUsage: { input: 40 }, costSamples: 1, cost: 1 } },
    { task: "b", mode: "baseline", passed: false, durationMs: 300, telemetry: { jsonLines: 1, toolCalls: 4, usageSamples: 1, tokens: { total: 300 }, firstUsage: { input: 60 }, costSamples: 1, cost: 3 } },
    { task: "a", mode: "ues", passed: true, durationMs: 150, telemetry: { jsonLines: 1, toolCalls: 3, usageSamples: 1, tokens: { total: 120 }, firstUsage: { input: 70 }, costSamples: 1, cost: 1.2 } },
    { task: "b", mode: "ues", passed: true, durationMs: 250, telemetry: { jsonLines: 1, toolCalls: 5, usageSamples: 1, tokens: { total: 280 }, firstUsage: { input: 90 }, costSamples: 1, cost: 2.8 } },
  ])

  assert.equal(result.modes.baseline.passRate, 0.5)
  assert.equal(result.modes.ues.passRate, 1)
  assert.equal(result.passRateDelta, 0.5)
  assert.equal(result.modes.baseline.avgDurationMs, 200)
  assert.equal(result.modes.ues.avgToolCalls, 4)
  assert.equal(result.modes.baseline.avgInitialInputTokens, 50)
  assert.equal(result.modes.ues.avgInitialInputTokens, 80)
  assert.equal(result.byTask.b.baseline.passRate, 0)
  assert.equal(result.byTask.b.ues.passRate, 1)
})

test("eval report marks unavailable telemetry as null instead of inventing zero usage", () => {
  const result = summarizeEvalResults([
    { task: "a", mode: "baseline", passed: true, durationMs: 50, telemetry: { jsonLines: 0, toolCalls: 0, usageSamples: 0, tokens: { total: 0 }, costSamples: 0, cost: 0 } },
  ])

  assert.equal(result.modes.baseline.avgToolCalls, null)
  assert.equal(result.modes.baseline.avgTokens, null)
  assert.equal(result.modes.baseline.avgInitialInputTokens, null)
  assert.equal(result.modes.baseline.avgCost, null)
  assert.deepEqual(result.modes.baseline.telemetryCoverage, { tools: 0, tokens: 0, initialInputTokens: 0, cost: 0 })
})


test("V11 eval report averages adaptive efficiency telemetry only when available", () => {
  const result = summarizeEvalResults([
    { task: "a", mode: "ues", passed: true, durationMs: 100, telemetry: { jsonLines: 1, toolCalls: 1, usageSamples: 0, costSamples: 0, v11: { avgCacheableRatio: 0.8, repeatedStableChars: 1200, evidenceReuseRatio: 0.5, visualRepairAttempts: 1, contextExpansions: 1, modelEscalations: 0 } } },
    { task: "b", mode: "ues", passed: true, durationMs: 100, telemetry: { jsonLines: 1, toolCalls: 1, usageSamples: 0, costSamples: 0, v11: { avgCacheableRatio: 0.6, repeatedStableChars: 800, evidenceReuseRatio: 0.25, visualRepairAttempts: 2, contextExpansions: 0, modelEscalations: 1 } } },
  ])
  assert.equal(result.modes.ues.avgCacheableRatio, 0.7)
  assert.equal(result.modes.ues.avgRepeatedStableChars, 1000)
  assert.equal(result.modes.ues.avgEvidenceReuseRatio, 0.375)
  assert.equal(result.modes.ues.avgVisualRepairAttempts, 1.5)
  assert.equal(result.modes.ues.avgContextExpansions, 0.5)
  assert.equal(result.modes.ues.avgModelEscalations, 0.5)
  assert.equal(result.modes.ues.telemetryCoverage.cacheableRatio, 1)
})

test("V11 eval report leaves adaptive metrics null when unavailable", () => {
  const result = summarizeEvalResults([{ task: "x", mode: "ues", passed: true, durationMs: 1, telemetry: { jsonLines: 0, usageSamples: 0, costSamples: 0 } }])
  assert.equal(result.modes.ues.avgCacheableRatio, null)
  assert.equal(result.modes.ues.avgEvidenceReuseRatio, null)
})
