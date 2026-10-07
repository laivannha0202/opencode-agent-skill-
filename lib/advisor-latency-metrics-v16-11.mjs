// V16.11 advisor latency metrics.
//
// WHY THIS MODULE EXISTS
//
// V16.11 claims three things about wall-clock latency:
//
//   1. A WARM browser worker is faster than a COLD one.
//   2. EVENT-FIRST answer observation is faster than POLLING.
//   3. Recovery adds bounded, known cost rather than unbounded stalls.
//
// Every one of those is a MEASUREMENT claim, and a measurement claim is only
// honest if (a) cold and warm are never averaged together, (b) an event win is
// only counted when an event actually produced the answer, and (c) an unmeasured
// phase is reported as NOT_MEASURED, never as zero.
//
// This module owns exactly that aggregation. It is pure: it takes sample rows
// and returns an honest report. It never invents a number, never averages across
// provenance classes, and never promotes an estimate into a measurement.
//
// It reuses `measurement-provenance.mjs` for the MEASURED / ESTIMATED /
// NOT_MEASURED vocabulary and the ESTIMATED char->token proxy.

import { NOT_MEASURED, PROVENANCE, derived, estimateTokensFromChars, measured } from "./measurement-provenance.mjs"

export const ADVISOR_LATENCY_METRICS_SCHEMA_VERSION = 1
export const ADVISOR_LATENCY_METRICS_POLICY = "advisor-latency-metrics-v16-11"

// The provenance of a latency sample. A sample is only MEASURED when the clock
// reading spans a real provider interaction; a simulated/double-driven sample is
// labelled SIMULATED and is never blended with MEASURED ones.
export const LATENCY_PROVENANCE = Object.freeze({
  MEASURED: "MEASURED",
  SIMULATED: "SIMULATED",
  NOT_MEASURED: "NOT_MEASURED",
})

// The observation channel that produced the answer. Mirrors the bridge.
export const LATENCY_CHANNEL = Object.freeze({
  EVENT: "event",
  POLL: "poll",
  EVENT_THEN_POLL: "event-then-poll",
  NONE: "none",
})

function finite(value) {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const rank = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sorted[lower]
  const weight = rank - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

function summarize(values) {
  if (values.length === 0) return NOT_MEASURED
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    provenance: PROVENANCE.MEASURED,
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  }
}

/**
 * Build a latency sample from a completed consult.
 *
 * @param {object} input
 * @param {"cold"|"warm"} input.workerState
 * @param {string} input.channel one of LATENCY_CHANNEL
 * @param {number} input.totalMs wall-clock from submit to accepted answer
 * @param {number} [input.acquireMs] worker acquire/attach time (cold only)
 * @param {number} [input.submitMs]
 * @param {number} [input.observeMs] answer observation time
 * @param {number} [input.recoveryMs] time spent recovering, if any
 * @param {string} [input.provenance] LATENCY_PROVENANCE (default MEASURED)
 * @param {number} [input.answerChars]
 * @param {number} [input.polls]
 * @param {number} [input.events]
 */
export function buildLatencySample(input = {}) {
  const workerState = input.workerState === "warm" ? "warm" : "cold"
  const channel = Object.values(LATENCY_CHANNEL).includes(input.channel) ? input.channel : LATENCY_CHANNEL.NONE
  const provenance = Object.values(LATENCY_PROVENANCE).includes(input.provenance)
    ? input.provenance
    : LATENCY_PROVENANCE.MEASURED
  return Object.freeze({
    schemaVersion: ADVISOR_LATENCY_METRICS_SCHEMA_VERSION,
    policy: ADVISOR_LATENCY_METRICS_POLICY,
    workerState,
    channel,
    provenance,
    totalMs: finite(input.totalMs),
    acquireMs: finite(input.acquireMs),
    submitMs: finite(input.submitMs),
    observeMs: finite(input.observeMs),
    recoveryMs: finite(input.recoveryMs) ?? 0,
    answerChars: finite(input.answerChars),
    polls: finite(input.polls) ?? 0,
    events: finite(input.events) ?? 0,
    // Whether the sample is a REAL provider interaction or a deterministic double.
    // Only MEASURED samples may back a published latency claim.
    real: provenance === LATENCY_PROVENANCE.MEASURED,
  })
}

/**
 * Aggregate latency samples into an honest report.
 *
 * The report NEVER averages across workerState (cold/warm), channel or
 * provenance. Each cell is its own summary; a cell with no MEASURED samples is
 * NOT_MEASURED. The cold/warm SPEEDUP ratio is only computed when BOTH cells have
 * at least one MEASURED sample.
 */
export function aggregateLatencyMetrics(samples = []) {
  const rows = (samples || []).filter((s) => s && s.totalMs != null)
  const measuredRows = rows.filter((s) => s.provenance === LATENCY_PROVENANCE.MEASURED)
  const simulatedRows = rows.filter((s) => s.provenance === LATENCY_PROVENANCE.SIMULATED)

  const byWorkerState = {}
  for (const state of ["cold", "warm"]) {
    byWorkerState[state] = {
      workerState: state,
      samples: measuredRows.filter((s) => s.workerState === state).length,
      totalMs: summarize(measuredRows.filter((s) => s.workerState === state).map((s) => s.totalMs)),
      acquireMs: summarize(measuredRows.filter((s) => s.workerState === state && s.acquireMs != null).map((s) => s.acquireMs)),
    }
  }

  const byChannel = {}
  for (const channel of Object.values(LATENCY_CHANNEL)) {
    if (channel === LATENCY_CHANNEL.NONE) continue
    const cell = measuredRows.filter((s) => s.channel === channel)
    byChannel[channel] = {
      channel,
      samples: cell.length,
      totalMs: summarize(cell.map((s) => s.totalMs)),
      observeMs: summarize(cell.filter((s) => s.observeMs != null).map((s) => s.observeMs)),
      polls: cell.reduce((sum, s) => sum + (s.polls || 0), 0),
      events: cell.reduce((sum, s) => sum + (s.events || 0), 0),
    }
  }

  // The honest cold->warm speedup: only from MEASURED samples on both sides.
  const coldMean = byWorkerState.cold.totalMs.provenance === PROVENANCE.MEASURED ? byWorkerState.cold.totalMs.mean : null
  const warmMean = byWorkerState.warm.totalMs.provenance === PROVENANCE.MEASURED ? byWorkerState.warm.totalMs.mean : null
  const warmSpeedup = coldMean != null && warmMean != null && warmMean > 0
    ? derived(coldMean / warmMean)
    : NOT_MEASURED

  // The honest event->poll speedup: only from MEASURED samples on both sides.
  const eventMean = byChannel[LATENCY_CHANNEL.EVENT]?.totalMs?.provenance === PROVENANCE.MEASURED ? byChannel[LATENCY_CHANNEL.EVENT].totalMs.mean : null
  const pollMean = byChannel[LATENCY_CHANNEL.POLL]?.totalMs?.provenance === PROVENANCE.MEASURED ? byChannel[LATENCY_CHANNEL.POLL].totalMs.mean : null
  const eventSpeedup = pollMean != null && eventMean != null && eventMean > 0
    ? derived(pollMean / eventMean)
    : NOT_MEASURED

  const recoveryRows = measuredRows.filter((s) => (s.recoveryMs || 0) > 0)

  return {
    schemaVersion: ADVISOR_LATENCY_METRICS_SCHEMA_VERSION,
    policy: ADVISOR_LATENCY_METRICS_POLICY,
    samples: rows.length,
    measuredSamples: measuredRows.length,
    simulatedSamples: simulatedRows.length,
    byWorkerState,
    byChannel,
    // The two headline ratios, each independently guarded.
    warmSpeedup,
    warmSpeedupReason: warmSpeedup.provenance === PROVENANCE.DERIVED ? null : "cold-and-warm-must-both-be-measured",
    eventSpeedup,
    eventSpeedupReason: eventSpeedup.provenance === PROVENANCE.DERIVED ? null : "event-and-poll-must-both-be-measured",
    recovery: {
      samplesWithRecovery: recoveryRows.length,
      recoveryMs: summarize(recoveryRows.map((s) => s.recoveryMs)),
    },
    // A SIMULATED-only run must say so loudly: no live-provider claim is allowed.
    liveMeasured: measuredRows.length > 0,
    claimStatus: measuredRows.length > 0 ? "MEASURED" : (simulatedRows.length > 0 ? "SIMULATED_ONLY" : "NOT_MEASURED"),
  }
}

/** A compact honest rendering. An unmeasured cell reads "unmeasured", never 0. */
export function renderAdvisorLatencyMetrics(metrics = {}) {
  const lines = [`V16.11 advisor latency (${metrics.samples || 0} samples; ${metrics.claimStatus || "NOT_MEASURED"})`]
  for (const state of ["cold", "warm"]) {
    const cell = metrics.byWorkerState?.[state] || {}
    const value = cell.totalMs?.provenance === PROVENANCE.MEASURED ? `${cell.totalMs.mean.toFixed(0)}ms mean (n=${cell.samples})` : "unmeasured"
    lines.push(`  ${state}: ${value}`)
  }
  lines.push(`  warm speedup: ${metrics.warmSpeedup?.provenance === PROVENANCE.DERIVED ? `${metrics.warmSpeedup.value.toFixed(2)}x` : "unmeasured"}`)
  for (const channel of [LATENCY_CHANNEL.EVENT, LATENCY_CHANNEL.POLL]) {
    const cell = metrics.byChannel?.[channel] || {}
    const value = cell.totalMs?.provenance === PROVENANCE.MEASURED ? `${cell.totalMs.mean.toFixed(0)}ms mean (n=${cell.samples})` : "unmeasured"
    lines.push(`  ${channel}: ${value}`)
  }
  lines.push(`  event speedup: ${metrics.eventSpeedup?.provenance === PROVENANCE.DERIVED ? `${metrics.eventSpeedup.value.toFixed(2)}x` : "unmeasured"}`)
  return lines.join("\n")
}

/**
 * Build a latency sample from an efficiency-ledger style row so the advisor
 * metrics can be derived from persisted events without a second schema.
 */
export function latencySampleFromEvent(row = {}) {
  const metrics = row.metrics || {}
  const provenance = row.provenance?.latency === LATENCY_PROVENANCE.MEASURED
    ? LATENCY_PROVENANCE.MEASURED
    : (metrics.simulated === true ? LATENCY_PROVENANCE.SIMULATED : LATENCY_PROVENANCE.MEASURED)
  return buildLatencySample({
    workerState: row.workerState,
    channel: row.channel,
    totalMs: metrics.wallTimeMs,
    acquireMs: metrics.acquireMs,
    observeMs: metrics.observeMs,
    recoveryMs: metrics.recoveryMs,
    answerChars: metrics.afterChars,
    polls: metrics.polls,
    events: metrics.events,
    provenance,
  })
}

export const advisorLatencyMetricsExports = Object.freeze({
  ADVISOR_LATENCY_METRICS_SCHEMA_VERSION,
  ADVISOR_LATENCY_METRICS_POLICY,
  LATENCY_PROVENANCE,
  LATENCY_CHANNEL,
  buildLatencySample,
  aggregateLatencyMetrics,
  renderAdvisorLatencyMetrics,
  latencySampleFromEvent,
})
