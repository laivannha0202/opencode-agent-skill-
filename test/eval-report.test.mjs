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

