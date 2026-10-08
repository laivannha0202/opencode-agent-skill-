// V16.10 Metrics V2: behavior tests.
//
// The metrics owner must never promote an ESTIMATED token count to MEASURED and
// must never compute a ratio from an incompletely measured population.

import test from "node:test"
import assert from "node:assert/strict"
import {
  EFFICIENCY_METRICS_POLICY,
  aggregateEfficiencyMetrics,
  renderEfficiencyMetricsV2,
} from "../lib/efficiency-metrics-v16-10.mjs"
import { PROVENANCE } from "../lib/measurement-provenance.mjs"

function efficiencyRow(kind, { beforeChars, afterChars, savedChars, provenance = "MEASURED" } = {}) {
  return {
    type: "efficiency.observation",
    kind,
    metrics: { beforeChars, afterChars, savedChars },
    provenance: { chars: provenance },
  }
}

test("V16.10 metrics: sums only measured rows and counts the rest", () => {
  const events = [
    efficiencyRow("tool-output-budgeter", { beforeChars: 1000, afterChars: 200, savedChars: 800, provenance: "MEASURED" }),
    efficiencyRow("tool-output-budgeter", { beforeChars: 500, afterChars: 100, savedChars: 400, provenance: "NOT_MEASURED" }),
  ]
  const metrics = aggregateEfficiencyMetrics(events, [])
  const row = metrics.capabilities.toolOutputBudgeter
  assert.equal(row.observations, 2)
  assert.equal(row.measuredRows, 1)
  assert.equal(row.unmeasuredRows, 1)
  assert.equal(row.savedChars.value, 800)
  assert.equal(row.savedChars.provenance, PROVENANCE.MEASURED)
})

test("V16.10 metrics: a ratio is refused when the population is not fully measured", () => {
  const events = [
    efficiencyRow("context-kernel", { beforeChars: 1000, afterChars: 200, savedChars: 800, provenance: "MEASURED" }),
    efficiencyRow("context-kernel", { beforeChars: 1000, afterChars: 900, savedChars: 100, provenance: "NOT_MEASURED" }),
  ]
  const metrics = aggregateEfficiencyMetrics(events, [])
  const row = metrics.capabilities.contextKernel
  assert.equal(row.savedCharRatio.provenance, PROVENANCE.NOT_MEASURED)
  assert.match(row.savedCharRatio.reason, /not-all-rows-measured|no-measured-rows/)
})

test("V16.10 metrics: a fully measured population yields a DERIVED ratio", () => {
  const events = [
    efficiencyRow("context-kernel", { beforeChars: 1000, afterChars: 200, savedChars: 800, provenance: "MEASURED" }),
    efficiencyRow("context-kernel", { beforeChars: 1000, afterChars: 200, savedChars: 800, provenance: "MEASURED" }),
  ]
  const metrics = aggregateEfficiencyMetrics(events, [])
  const row = metrics.capabilities.contextKernel
  assert.equal(row.savedCharRatio.provenance, PROVENANCE.DERIVED)
  assert.equal(row.savedCharRatio.value, 0.8)
})

test("V16.10 metrics: char savings are ESTIMATED as tokens, never MEASURED", () => {
  const events = [efficiencyRow("repo-intelligence", { beforeChars: 4000, afterChars: 400, savedChars: 3600, provenance: "MEASURED" })]
  const metrics = aggregateEfficiencyMetrics(events, [])
  const row = metrics.capabilities.repoIntelligence
  assert.equal(row.savedTokensEstimate.provenance, PROVENANCE.ESTIMATED)
  assert.equal(row.savedTokensEstimate.value, 900)
  // The headline token savings must remain explicitly NOT_MEASURED.
  assert.equal(metrics.tokens.tokenSavings.provenance, PROVENANCE.NOT_MEASURED)
})

test("V16.10 metrics: no data at all yields NOT_MEASURED, never zero", () => {
  const metrics = aggregateEfficiencyMetrics([], [])
  assert.equal(metrics.observations, 0)
  for (const row of Object.values(metrics.capabilities)) {
    assert.equal(row.savedChars.provenance, PROVENANCE.NOT_MEASURED)
    assert.equal(row.savedCharRatio.provenance, PROVENANCE.NOT_MEASURED)
  }
  assert.equal(metrics.verifiedSuccessPer100kTokens.provenance, PROVENANCE.NOT_MEASURED)
})

test("V16.10 metrics: verification ladder verdicts are counted, not inferred", () => {
  const events = [
    { type: "efficiency.observation", kind: "verification-ladder", verdict: "PASS", metrics: {}, provenance: {} },
    { type: "efficiency.observation", kind: "verification-ladder", verdict: "FAIL", metrics: {}, provenance: {} },
    { type: "efficiency.observation", kind: "verification-ladder", verdict: "UNVERIFIED", metrics: {}, provenance: {} },
    { type: "efficiency.observation", kind: "verification-ladder", verdict: "PASS", metrics: {}, provenance: {} },
  ]
  const metrics = aggregateEfficiencyMetrics(events, [])
  assert.equal(metrics.verificationLadder.runs, 4)
  assert.equal(metrics.verificationLadder.verdicts.PASS, 2)
  assert.equal(metrics.verificationLadder.verdicts.FAIL, 1)
  assert.equal(metrics.verificationLadder.passRate.value, 0.5)
})

test("V16.10 metrics: verified success per 100k tokens only counts measured runs", () => {
  const telemetry = [
    { type: "task.telemetry", outcome: { passed: true }, metrics: { totalTokens: 50000 } },
    { type: "task.telemetry", outcome: { passed: true }, metrics: { totalTokens: null } },
    { type: "task.telemetry", outcome: { passed: false }, metrics: { totalTokens: 50000 } },
  ]
  const metrics = aggregateEfficiencyMetrics([], telemetry)
  // Only ONE run has both a PASS and a measured token count.
  assert.equal(metrics.verifiedSuccessPer100kTokens.provenance, PROVENANCE.DERIVED)
  assert.equal(metrics.verifiedSuccessPer100kTokens.value, 2)
})

test("V16.10 metrics: render is bounded and honest about unmeasured values", () => {
  const metrics = aggregateEfficiencyMetrics([], [])
  const text = renderEfficiencyMetricsV2(metrics)
  assert.match(text, /V16\.10 efficiency metrics/)
  assert.match(text, /unmeasured/)
  assert.ok(text.length < 2000)
  assert.equal(metrics.policy, EFFICIENCY_METRICS_POLICY)
})

// ---------------------------------------------------------------------------
// V16.15 parallel coding observations
//
// The wave runtime PRODUCES `parallel-coding` observations. Metrics V2 stays the
// single aggregator, and it must never turn wave activity into a speedup claim.
// ---------------------------------------------------------------------------

const parallelRow = (operation, count) => ({
  type: "efficiency.observation",
  kind: "parallel-coding",
  operation,
  metrics: { count },
  provenance: { count: "MEASURED" },
})

test("V16.15 metrics: wave activity is aggregated as measured counts", () => {
  const metrics = aggregateEfficiencyMetrics([
    parallelRow("waves-planned", 3),
    parallelRow("posture:PARALLEL_WRITERS", 2),
    parallelRow("posture:PARENT_DIRECT", 1),
    parallelRow("integration-transactions", 2),
  ], [])
  assert.equal(metrics.parallelCoding.observations, 4)
  assert.equal(metrics.parallelCoding.operations["waves-planned"], 3)
  assert.equal(metrics.parallelCoding.operations["posture:PARALLEL_WRITERS"], 2)
})

test("V16.15 metrics: an unmeasured count is skipped, never counted as zero", () => {
  const metrics = aggregateEfficiencyMetrics([
    parallelRow("waves-planned", 2),
    {
      type: "efficiency.observation",
      kind: "parallel-coding",
      operation: "integration-transactions",
      metrics: { count: 5 },
      provenance: { count: "NOT_MEASURED" },
    },
  ], [])
  assert.equal(metrics.parallelCoding.operations["waves-planned"], 2)
  // The unmeasured row is NOT silently added as a zero-value contribution.
  assert.equal(metrics.parallelCoding.operations["integration-transactions"], undefined)
})

test("V16.15 metrics: parallel coding NEVER reports a speedup claim", () => {
  const metrics = aggregateEfficiencyMetrics([parallelRow("waves-planned", 9)], [])
  assert.equal(metrics.parallelCoding.speedupClaim, null)
  assert.equal(metrics.parallelCoding.measuredOverlapSavedMs.provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(metrics.parallelCoding.measuredOverlapSavedMs.value, null)
})

test("V16.15 metrics: no parallel observations reads as zero events, not a fabricated saving", () => {
  const metrics = aggregateEfficiencyMetrics([], [])
  assert.equal(metrics.parallelCoding.observations, 0)
  assert.deepEqual(metrics.parallelCoding.operations, {})
  assert.equal(metrics.parallelCoding.speedupClaim, null)
  const text = renderEfficiencyMetricsV2(metrics)
  assert.match(text, /no speedup claim/)
})
