import test from "node:test"
import assert from "node:assert/strict"
import { pairedBenchmarkConfidence } from "../lib/benchmark-confidence.mjs"

function pair(task, baselinePassed, uesPassed, suite = "live", baselineMs = 100, uesMs = 110) {
  return [
    { suite, task, trial: 1, mode: "baseline", passed: baselinePassed, durationMs: baselineMs },
    { suite, task, trial: 1, mode: "ues", passed: uesPassed, durationMs: uesMs },
  ]
}

test("paired confidence requires statistically supported paired wins", () => {
  const results = []
  for (let index = 0; index < 30; index += 1) {
    results.push(...pair("task-" + index, index < 12, index < 22))
  }
  const report = pairedBenchmarkConfidence(results)
  assert.equal(report.pairs, 30)
  assert.equal(report.uesOnly, 10)
  assert.equal(report.baselineOnly, 0)
  assert.equal(report.checks.statisticallySupported, true)
  assert.equal(report.checks.noSuiteRegression, true)
  assert.equal(report.checks.speedAcceptable, true)
  assert.equal(report.promotionEligible, true)
})

test("paired confidence rejects suite regression even with overall uplift", () => {
  const results = []
  for (let index = 0; index < 12; index += 1) {
    results.push(...pair("a-" + index, index < 8, index < 11, "suite-a"))
  }
  for (let index = 0; index < 12; index += 1) {
    results.push(...pair("b-" + index, index < 10, index < 8, "suite-b"))
  }
  const report = pairedBenchmarkConfidence(results)
  assert.equal(report.checks.noSuiteRegression, false)
  assert.equal(report.promotionEligible, false)
})

test("paired confidence rejects excessive slowdown", () => {
  const results = []
  for (let index = 0; index < 24; index += 1) {
    results.push(...pair("task-" + index, index < 8, index < 18, "live", 100, 220))
  }
  const report = pairedBenchmarkConfidence(results)
  assert.equal(report.checks.speedAcceptable, false)
  assert.equal(report.promotionEligible, false)
})
