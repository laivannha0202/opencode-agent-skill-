// V16.11 advisor latency metrics tests.
//
// These prove the honesty laws: cold and warm are never averaged together, an
// event win is only counted when an event actually produced the answer, a
// SIMULATED-only run never claims a live measurement, and an unmeasured cell is
// reported as unmeasured rather than zero.

import test from "node:test"
import assert from "node:assert/strict"

import {
  ADVISOR_LATENCY_METRICS_POLICY,
  LATENCY_CHANNEL,
  LATENCY_PROVENANCE,
  aggregateLatencyMetrics,
  buildLatencySample,
  renderAdvisorLatencyMetrics,
} from "../lib/advisor-latency-metrics-v16-11.mjs"
import { PROVENANCE } from "../lib/measurement-provenance.mjs"

test("latency: a cold->warm speedup is only computed from measured samples on both sides", () => {
  const samples = [
    buildLatencySample({ workerState: "cold", channel: LATENCY_CHANNEL.EVENT, totalMs: 10000, provenance: LATENCY_PROVENANCE.MEASURED }),
    buildLatencySample({ workerState: "warm", channel: LATENCY_CHANNEL.EVENT, totalMs: 5000, provenance: LATENCY_PROVENANCE.MEASURED }),
  ]
  const metrics = aggregateLatencyMetrics(samples)
  assert.equal(metrics.warmSpeedup.provenance, PROVENANCE.DERIVED)
  assert.equal(metrics.warmSpeedup.value, 2)
  assert.equal(metrics.claimStatus, "MEASURED")
})

test("latency: cold and warm are reported in SEPARATE cells, never averaged", () => {
  const samples = [
    buildLatencySample({ workerState: "cold", channel: LATENCY_CHANNEL.EVENT, totalMs: 10000 }),
    buildLatencySample({ workerState: "cold", channel: LATENCY_CHANNEL.EVENT, totalMs: 12000 }),
    buildLatencySample({ workerState: "warm", channel: LATENCY_CHANNEL.EVENT, totalMs: 4000 }),
  ]
  const metrics = aggregateLatencyMetrics(samples)
  assert.equal(metrics.byWorkerState.cold.samples, 2)
  assert.equal(metrics.byWorkerState.warm.samples, 1)
  assert.equal(metrics.byWorkerState.cold.totalMs.mean, 11000)
  assert.equal(metrics.byWorkerState.warm.totalMs.mean, 4000)
})

test("latency: the warm speedup is NOT_MEASURED when only cold samples exist", () => {
  const metrics = aggregateLatencyMetrics([
    buildLatencySample({ workerState: "cold", channel: LATENCY_CHANNEL.EVENT, totalMs: 9000 }),
  ])
  assert.equal(metrics.warmSpeedup.provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(metrics.warmSpeedup.value, null)
  assert.match(metrics.warmSpeedupReason, /both/)
})

test("latency: the event speedup is computed from measured event vs poll", () => {
  const samples = [
    buildLatencySample({ workerState: "warm", channel: LATENCY_CHANNEL.EVENT, totalMs: 4000 }),
    buildLatencySample({ workerState: "warm", channel: LATENCY_CHANNEL.POLL, totalMs: 8000 }),
  ]
  const metrics = aggregateLatencyMetrics(samples)
  assert.equal(metrics.eventSpeedup.provenance, PROVENANCE.DERIVED)
  assert.equal(metrics.eventSpeedup.value, 2)
})

test("latency: a SIMULATED-only run never claims a live measurement", () => {
  const samples = [
    buildLatencySample({ workerState: "cold", channel: LATENCY_CHANNEL.POLL, totalMs: 5000, provenance: LATENCY_PROVENANCE.SIMULATED }),
    buildLatencySample({ workerState: "warm", channel: LATENCY_CHANNEL.EVENT, totalMs: 2500, provenance: LATENCY_PROVENANCE.SIMULATED }),
  ]
  const metrics = aggregateLatencyMetrics(samples)
  assert.equal(metrics.claimStatus, "SIMULATED_ONLY")
  assert.equal(metrics.liveMeasured, false)
  // A simulated sample must NOT leak into the MEASURED cell.
  assert.equal(metrics.byWorkerState.warm.totalMs.provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(metrics.simulatedSamples, 2)
})

test("latency: an empty report is NOT_MEASURED, not zero", () => {
  const metrics = aggregateLatencyMetrics([])
  assert.equal(metrics.claimStatus, "NOT_MEASURED")
  assert.equal(metrics.byWorkerState.cold.totalMs.provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(metrics.warmSpeedup.value, null)
})

test("latency: percentiles are honest for a known distribution", () => {
  const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ms) =>
    buildLatencySample({ workerState: "warm", channel: LATENCY_CHANNEL.EVENT, totalMs: ms }))
  const cell = aggregateLatencyMetrics(samples).byWorkerState.warm.totalMs
  assert.equal(cell.min, 1)
  assert.equal(cell.max, 10)
  assert.equal(cell.p50, 5.5)
  assert.equal(cell.count, 10)
})

test("latency: recovery time is summarized only over samples that recovered", () => {
  const samples = [
    buildLatencySample({ workerState: "cold", channel: LATENCY_CHANNEL.EVENT, totalMs: 12000, recoveryMs: 3000 }),
    buildLatencySample({ workerState: "warm", channel: LATENCY_CHANNEL.EVENT, totalMs: 4000, recoveryMs: 0 }),
  ]
  const metrics = aggregateLatencyMetrics(samples)
  assert.equal(metrics.recovery.samplesWithRecovery, 1)
  assert.equal(metrics.recovery.recoveryMs.mean, 3000)
})

test("latency: the render never prints an unmeasured cell as a number", () => {
  const text = renderAdvisorLatencyMetrics(aggregateLatencyMetrics([]))
  assert.match(text, /unmeasured/)
  assert.ok(!/ 0ms/.test(text))
})

test("latency: the policy id is stable", () => {
  assert.equal(ADVISOR_LATENCY_METRICS_POLICY, "advisor-latency-metrics-v16-11")
})
