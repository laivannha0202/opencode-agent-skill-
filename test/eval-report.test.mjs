import test from "node:test"
import assert from "node:assert/strict"
import { summarizeEvalResults } from "../lib/eval-report.mjs"

test("eval report summarizes pass-rate delta and efficiency telemetry", () => {
  const result = summarizeEvalResults([
    { task: "a", mode: "baseline", passed: true, durationMs: 100, telemetry: { toolCalls: 2, tokens: { total: 100 }, cost: 1 } },
    { task: "b", mode: "baseline", passed: false, durationMs: 300, telemetry: { toolCalls: 4, tokens: { total: 300 }, cost: 3 } },
    { task: "a", mode: "ues", passed: true, durationMs: 150, telemetry: { toolCalls: 3, tokens: { total: 120 }, cost: 1.2 } },
    { task: "b", mode: "ues", passed: true, durationMs: 250, telemetry: { toolCalls: 5, tokens: { total: 280 }, cost: 2.8 } },
  ])

  assert.equal(result.modes.baseline.passRate, 0.5)
  assert.equal(result.modes.ues.passRate, 1)
  assert.equal(result.passRateDelta, 0.5)
  assert.equal(result.modes.baseline.avgDurationMs, 200)
  assert.equal(result.modes.ues.avgToolCalls, 4)
  assert.equal(result.byTask.b.baseline.passRate, 0)
  assert.equal(result.byTask.b.ues.passRate, 1)
})
