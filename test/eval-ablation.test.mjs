import test from "node:test"
import assert from "node:assert/strict"
import { compareEvalSummaries } from "../lib/eval-ablation.mjs"

function summary({ passRate, initial, tokens, duration }) {
  return {
    modes: {
      ues: {
        passRate,
        avgInitialInputTokens: initial,
        avgTokens: tokens,
        avgDurationMs: duration,
      },
    },
  }
}

test("V10 ablation accepts lower initial context without correctness regression", () => {
  const report = compareEvalSummaries(
    summary({ passRate: 0.80, initial: 10000, tokens: 30000, duration: 1000 }),
    summary({ passRate: 0.82, initial: 7500, tokens: 29000, duration: 950 }),
  )
  assert.equal(report.checks.passRatePreserved, true)
  assert.equal(report.checks.initialInputReduced, true)
  assert.equal(report.gateEligible, true)
})

test("V10 ablation rejects token savings that reduce pass rate", () => {
  const report = compareEvalSummaries(
    summary({ passRate: 0.80, initial: 10000, tokens: 30000, duration: 1000 }),
    summary({ passRate: 0.72, initial: 7000, tokens: 25000, duration: 800 }),
  )
  assert.equal(report.checks.initialInputReduced, true)
  assert.equal(report.checks.passRatePreserved, false)
  assert.equal(report.gateEligible, false)
})

test("V10 ablation fails closed when initial-input telemetry is unavailable", () => {
  const report = compareEvalSummaries(
    summary({ passRate: 0.80, initial: null, tokens: 30000, duration: 1000 }),
    summary({ passRate: 0.82, initial: null, tokens: 28000, duration: 900 }),
  )
  assert.equal(report.telemetrySufficient, false)
  assert.equal(report.gateEligible, false)
})

test("V10 ablation does not treat missing candidate telemetry as zero tokens", () => {
  const report = compareEvalSummaries(
    summary({ passRate: 0.80, initial: 10000, tokens: 30000, duration: 1000 }),
    summary({ passRate: 0.82, initial: null, tokens: 28000, duration: 900 }),
  )
  assert.equal(report.checks.initialInputReduced, null)
  assert.equal(report.telemetrySufficient, false)
  assert.equal(report.gateEligible, false)
})
