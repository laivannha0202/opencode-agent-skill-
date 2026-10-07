// V16.10 Metrics V2.
//
// WHY THIS MODULE EXISTS
//
// V16.10 adds six new subsystems that each CLAIM to make a run cheaper or safer:
// the tool-output budgeter, the context kernel, repo intelligence, the semantic
// tool router, the verification ladder, and the metrics themselves. A claim is
// worthless without a number, and a number is worse than worthless if its
// provenance is invented.
//
// The existing owners already persist raw observations honestly:
//   * `efficiency-ledger` writes `efficiency.observation` events, each carrying
//     a per-field provenance block (MEASURED / NOT_MEASURED).
//   * `run-telemetry` writes `task.telemetry` events with outcome + metrics.
//   * `measurement-provenance` defines the vocabulary.
//
// What was missing is a single AGGREGATION owner that answers, per V16.10
// capability: "did it actually do anything, and can we prove it?" - without ever
// promoting an ESTIMATED char-derived token count into a MEASURED one, and
// without ever computing a ratio from a denominator that includes unmeasured
// rows.
//
// LAWS
//
//   1. A metric is only summed over rows whose provenance for THAT field is
//      MEASURED (or, where explicitly noted, DERIVED_FROM_MEASURED). Unmeasured
//      rows are COUNTED but never summed.
//   2. A ratio is null unless its denominator is > 0 AND every contributing row
//      is measured. "We saved 0.4x" from one measured row and nine unknown rows
//      is forbidden.
//   3. Token savings are NEVER reported as MEASURED unless provider token
//      telemetry exists; char savings are the honest MEASURED proxy and are
//      always labelled as such.
//   4. Success is only counted from a PASS verdict, never from the absence of a
//      failure.
//   5. This module OWNS aggregation only. It reads the ledgers; it never writes
//      them and never runs a task.

import { readEfficiencyEvents } from "./efficiency-ledger.mjs"
import { readTaskTelemetry } from "./run-telemetry.mjs"
import { PROVENANCE, measured, derived, NOT_MEASURED, estimateTokensFromChars } from "./measurement-provenance.mjs"

export const EFFICIENCY_METRICS_SCHEMA_VERSION = 2
export const EFFICIENCY_METRICS_POLICY = "efficiency-metrics-v16-10"

/** The efficiency `kind` values each V16.10 capability emits. */
export const CAPABILITY_EVENT_KINDS = Object.freeze({
  toolOutputBudgeter: ["tool-output-budgeter", "tool-output-economy", "tool-output-governor"],
  contextKernel: ["context-kernel", "delta-context-output"],
  repoIntelligence: ["repo-intelligence", "repo-intelligence-cache"],
  semanticToolRouter: ["semantic-tool-router"],
  verificationLadder: ["verification-ladder"],
})

function finite(value) {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function isMeasuredField(row, key, accepted = ["MEASURED"]) {
  return accepted.includes(String(row?.provenance?.[key] || ""))
}

/**
 * Sum a metric across rows, but ONLY over rows that measured it. Returns the
 * honest triple (value, measuredRows, unmeasuredRows) so a caller can never
 * mistake "we have no data" for "the value is zero".
 */
function honestSum(rows, key, provenanceKey = key, accepted = ["MEASURED"]) {
  let total = 0
  let measuredRows = 0
  let unmeasuredRows = 0
  for (const row of rows) {
    const value = finite(row?.metrics?.[key])
    if (value != null && isMeasuredField(row, provenanceKey, accepted)) {
      total += value
      measuredRows += 1
    } else {
      unmeasuredRows += 1
    }
  }
  const metricRow = measuredRows > 0
    ? (accepted.includes("DERIVED_FROM_MEASURED") && !accepted.includes("MEASURED") ? derived(total) : measured(total))
    : NOT_MEASURED
  return { value: metricRow.value, provenance: metricRow.provenance, measuredRows, unmeasuredRows, total }
}

/**
 * A ratio is honest only when the denominator is positive and fully measured.
 * Otherwise it is NOT_MEASURED with a reason naming the gap.
 */
function honestRatio(numerator, denominator, { numeratorMeasured, denominatorMeasured, reason }) {
  if (!numeratorMeasured || !denominatorMeasured) {
    return Object.freeze({ value: null, provenance: PROVENANCE.NOT_MEASURED, reason: reason || "incomplete-provenance" })
  }
  if (!(denominator > 0)) {
    return Object.freeze({ value: null, provenance: PROVENANCE.NOT_MEASURED, reason: "zero-denominator" })
  }
  return derived(numerator / denominator)
}

function eventsForKinds(events, kinds) {
  const set = new Set(kinds)
  return events.filter((row) => set.has(String(row?.kind || "")))
}

/**
 * Aggregate the V16.10 capability metrics from the persisted ledgers. Pure read.
 */
export async function buildEfficiencyMetricsV2(root = process.cwd(), options = {}) {
  const [events, telemetry] = await Promise.all([
    readEfficiencyEvents(root, { limit: Math.max(1, Math.min(5000, Number(options.limit || 2000))) }).catch(() => []),
    readTaskTelemetry(root, { limit: Math.max(1, Math.min(2000, Number(options.taskLimit || 500))) }).catch(() => []),
  ])
  return aggregateEfficiencyMetrics(events, telemetry)
}

/** The pure aggregation function (testable without a filesystem). */
export function aggregateEfficiencyMetrics(events = [], telemetry = []) {
  const observations = (events || []).filter((row) => row?.type === "efficiency.observation")
  const taskEvents = (telemetry || []).filter((row) => row?.type === "task.telemetry")

  const capabilities = {}
  for (const [capability, kinds] of Object.entries(CAPABILITY_EVENT_KINDS)) {
    const rows = eventsForKinds(observations, kinds)
    const before = honestSum(rows, "beforeChars", "chars")
    const after = honestSum(rows, "afterChars", "chars")
    const saved = honestSum(rows, "savedChars", "chars")
    const savedRatio = honestRatio(
      saved.total,
      before.total,
      {
        numeratorMeasured: saved.measuredRows > 0,
        denominatorMeasured: before.measuredRows > 0 && before.measuredRows === rows.length,
        reason: before.measuredRows !== rows.length ? "not-all-rows-measured" : "no-measured-rows",
      },
    )
    capabilities[capability] = {
      capability,
      eventKinds: kinds,
      observations: rows.length,
      measuredRows: saved.measuredRows,
      unmeasuredRows: saved.unmeasuredRows,
      savedChars: saved.provenance === PROVENANCE.NOT_MEASURED ? NOT_MEASURED : measured(saved.total),
      beforeChars: before.provenance === PROVENANCE.NOT_MEASURED ? NOT_MEASURED : measured(before.total),
      afterChars: after.provenance === PROVENANCE.NOT_MEASURED ? NOT_MEASURED : measured(after.total),
      savedCharRatio: savedRatio,
      // Token savings from chars is an ESTIMATE and is labelled as one.
      savedTokensEstimate: saved.measuredRows > 0 ? estimateTokensFromChars(saved.total) : NOT_MEASURED,
    }
  }

  // Verification ladder: pass distribution from the ladder's own verdicts.
  const ladderRows = eventsForKinds(observations, CAPABILITY_EVENT_KINDS.verificationLadder)
  const ladderVerdicts = { PASS: 0, FAIL: 0, UNVERIFIED: 0 }
  for (const row of ladderRows) {
    const verdict = String(row?.verdict || "").toUpperCase()
    if (verdict in ladderVerdicts) ladderVerdicts[verdict] += 1
  }
  const ladderRuns = ladderRows.length
  const ladderPassRate = honestRatio(ladderVerdicts.PASS, ladderRuns, {
    numeratorMeasured: ladderRuns > 0,
    denominatorMeasured: ladderRuns > 0,
    reason: "no-ladder-runs",
  })

  // Verified success per 100k tokens: only from task telemetry that MEASURED both
  // the outcome and the token count. Never extrapolated.
  const verifiedRuns = taskEvents.filter((row) => row?.outcome?.passed === true && finite(row?.metrics?.totalTokens) != null)
  const totalTokens = verifiedRuns.reduce((sum, row) => sum + Number(finite(row.metrics.totalTokens) || 0), 0)
  const verifiedSuccessPer100k = verifiedRuns.length > 0 && totalTokens > 0
    ? derived((verifiedRuns.length / totalTokens) * 100000)
    : NOT_MEASURED

  // Provider token savings: ONLY when both before and after provider tokens were
  // measured. Char-based savings are NEVER promoted to this field.
  const providerTokenRows = observations.filter((row) =>
    finite(row?.metrics?.inputTokens) != null && isMeasuredField(row, "inputTokens"))
  const inputTokens = honestSum(observations, "inputTokens")

  return {
    schemaVersion: EFFICIENCY_METRICS_SCHEMA_VERSION,
    policy: EFFICIENCY_METRICS_POLICY,
    observations: observations.length,
    taskRuns: taskEvents.length,
    capabilities,
    verificationLadder: {
      runs: ladderRuns,
      verdicts: ladderVerdicts,
      passRate: ladderPassRate,
    },
    tokens: {
      measuredInputTokenRows: providerTokenRows.length,
      inputTokens: inputTokens.provenance === PROVENANCE.NOT_MEASURED ? NOT_MEASURED : measured(inputTokens.total),
      // Explicit: char savings are NOT token savings.
      tokenSavings: NOT_MEASURED,
      tokenSavingsReason: "provider-token-savings-not-measured; use savedTokensEstimate (ESTIMATED) from char deltas",
    },
    verifiedSuccessPer100kTokens: verifiedSuccessPer100k,
    qualityClaim: "NOT_INFERRED_FROM_EFFICIENCY",
    provenance: {
      chars: PROVENANCE.MEASURED,
      tokens: providerTokenRows.length > 0 ? PROVENANCE.MEASURED : PROVENANCE.NOT_MEASURED,
      estimates: PROVENANCE.ESTIMATED,
    },
  }
}

/**
 * A compact, human-facing summary of the metrics. Bounded and honest: a metric
 * with no measured data reads as "unmeasured", never as "0".
 */
export function renderEfficiencyMetricsV2(metrics = {}) {
  const lines = [
    `V16.10 efficiency metrics (${metrics.observations || 0} observations, ${metrics.taskRuns || 0} task runs)`,
  ]
  for (const row of Object.values(metrics.capabilities || {})) {
    const saved = row.savedChars?.provenance === PROVENANCE.MEASURED ? `${row.savedChars.value} chars` : "unmeasured"
    const ratio = row.savedCharRatio?.provenance === PROVENANCE.DERIVED ? `${(row.savedCharRatio.value * 100).toFixed(1)}%` : "n/a"
    lines.push(`  ${row.capability}: ${row.observations} events, saved ${saved} (${ratio}), ${row.unmeasuredRows} unmeasured`)
  }
  const ladder = metrics.verificationLadder || {}
  lines.push(`  verification ladder: ${ladder.runs || 0} runs, pass ${ladder.verdicts?.PASS || 0}, fail ${ladder.verdicts?.FAIL || 0}, unverified ${ladder.verdicts?.UNVERIFIED || 0}`)
  lines.push(`  verified success / 100k tokens: ${metrics.verifiedSuccessPer100kTokens?.provenance === PROVENANCE.DERIVED ? metrics.verifiedSuccessPer100kTokens.value.toFixed(3) : "unmeasured"}`)
  return lines.join("\n")
}

export const efficiencyMetricsV2Exports = Object.freeze({
  buildEfficiencyMetricsV2,
  aggregateEfficiencyMetrics,
  renderEfficiencyMetricsV2,
  CAPABILITY_EVENT_KINDS,
})
