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

test("V10 confidence rejects excessive initial-context overhead when telemetry exists", () => {
  const results = []
  for (let index = 0; index < 24; index += 1) {
    results.push(
      {
        suite: "live", task: "ctx-" + index, trial: 1, mode: "baseline",
        passed: index < 8, durationMs: 100,
        telemetry: { firstUsage: { input: 1000 }, tokens: { total: 2000 } },
      },
      {
        suite: "live", task: "ctx-" + index, trial: 1, mode: "ues",
        passed: index < 18, durationMs: 110,
        telemetry: { firstUsage: { input: 1700 }, tokens: { total: 2500 } },
      },
    )
  }
  const report = pairedBenchmarkConfidence(results)
  assert.equal(report.checks.initialInputAcceptable, false)
  assert.equal(report.checks.tokensAcceptable, true)
  assert.equal(report.promotionEligible, false)
})

test("V10 confidence accepts bounded token overhead with stronger correctness", () => {
  const results = []
  for (let index = 0; index < 24; index += 1) {
    results.push(
      {
        suite: "live", task: "efficient-" + index, trial: 1, mode: "baseline",
        passed: index < 8, durationMs: 100,
        telemetry: { firstUsage: { input: 1000 }, tokens: { total: 2000 } },
      },
      {
        suite: "live", task: "efficient-" + index, trial: 1, mode: "ues",
        passed: index < 18, durationMs: 110,
        telemetry: { firstUsage: { input: 1200 }, tokens: { total: 2400 } },
      },
    )
  }
  const report = pairedBenchmarkConfidence(results)
  assert.equal(report.checks.initialInputAcceptable, true)
  assert.equal(report.checks.tokensAcceptable, true)
  assert.equal(report.promotionEligible, true)
})

test("V14.2 turbo gate accepts quality parity only when efficiency improves and no false PASS occurs", () => {
  const results = []
  for (let index = 0; index < 24; index += 1) {
    results.push(
      {
        suite: "live", task: "turbo-" + index, trial: 1, mode: "baseline",
        passed: index < 20, baselineIsolated: true, durationMs: 200,
        graderExit: index < 20 ? 0 : 1,
        telemetry: { firstUsage: { input: 1500 }, tokens: { total: 3000 } },
      },
      {
        suite: "live", task: "turbo-" + index, trial: 1, mode: "ues",
        passed: index < 20, durationMs: 120,
        graderExit: index < 20 ? 0 : 1,
        telemetry: {
          controllerPass: index < 20,
          firstUsage: { input: 900 },
          tokens: { total: 1900 },
        },
      },
    )
  }
  const report = pairedBenchmarkConfidence(results)
  assert.equal(report.delta, 0)
  assert.equal(report.turbo.checks.qualityNonRegression, true)
  assert.equal(report.turbo.checks.efficiencyImproved, true)
  assert.equal(report.turbo.checks.noControllerFalsePass, true)
  assert.equal(report.turbo.promotionEligible, true)
})

test("V14.2 turbo gate rejects controller false PASS even when faster", () => {
  const results = []
  for (let index = 0; index < 24; index += 1) {
    results.push(
      {
        suite: "live", task: "false-pass-" + index, trial: 1, mode: "baseline",
        passed: true, baselineIsolated: true, durationMs: 200, graderExit: 0,
        telemetry: { firstUsage: { input: 1200 }, tokens: { total: 2500 } },
      },
      {
        suite: "live", task: "false-pass-" + index, trial: 1, mode: "ues",
        passed: index !== 0, durationMs: 100, graderExit: index === 0 ? 1 : 0,
        telemetry: {
          controllerPass: true,
          firstUsage: { input: 800 },
          tokens: { total: 1500 },
        },
      },
    )
  }
  const report = pairedBenchmarkConfidence(results, { qualityRegressionTolerance: 0.1 })
  assert.equal(report.turbo.uesFalsePasses, 1)
  assert.equal(report.turbo.checks.noControllerFalsePass, false)
  assert.equal(report.turbo.promotionEligible, false)
})
