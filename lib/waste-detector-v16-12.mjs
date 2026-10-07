// V16.12 Waste Detector + Wall-Time Attribution.
//
// WHY THIS MODULE EXISTS
//
// V16.12's whole premise is "do less work". A premise is unprovable without an
// owner that (a) DETECTS repeated expensive operations deterministically and
// (b) ATTRIBUTES wall time to honest categories. V16.10 Metrics V2 already owns
// aggregate efficiency; this module does NOT compete with it. It owns two
// narrower questions V16.12 needs and nothing else:
//
//   1. WASTE: "was the same expensive deterministic operation performed more
//      than once against an unchanged workspace?" - reported per operation with
//      a count and a measured/derived wasted-wall figure.
//   2. ATTRIBUTION: "how much wall time went to model reasoning, advisor wait,
//      browser, tool exec, repo intelligence, read/search, verification, full
//      suite, release verify, cache lookup, scheduler wait and process startup?"
//
// HONESTY LAWS (inherited from measurement-provenance)
//
//   * Every category carries a provenance label. A category with no observation
//     is `NOT_MEASURED`, never `0`.
//   * `totalWallMs` is MEASURED only when the run supplied a real wall clock.
//   * `criticalPathMs` is DERIVED only when a real dependency chain was recorded.
//   * `parallelOverlapSavedMs` is ESTIMATED and is never added to a measured
//     total as if it were measured.
//   * No token claim is made here. Provider tokens are NOT_MEASURED unless the
//     caller supplies real telemetry.
//
// It OWNS no metrics ledger (efficiency-ledger does), no task telemetry
// (run-telemetry does) and no verification (verification-ladder does).

import { measured, derived, estimated, NOT_MEASURED } from "./measurement-provenance.mjs"

export const WASTE_DETECTOR_SCHEMA_VERSION = 1
export const WASTE_DETECTOR_POLICY = "waste-detector-v16-12"

// Wall-time categories V16.12 attributes. Stable ids; do not rename casually.
export const WALL_CATEGORY = Object.freeze({
  MODEL_REASONING: "model_reasoning_ms",
  ADVISOR_WAIT: "advisor_wait_ms",
  BROWSER_START: "browser_start_ms",
  BROWSER_ANSWER: "browser_answer_ms",
  TOOL_EXEC: "tool_exec_ms",
  REPO_INTELLIGENCE: "repo_intelligence_ms",
  READ_SEARCH: "read_search_ms",
  VERIFICATION: "verification_ms",
  FULL_SUITE: "full_suite_ms",
  RELEASE_VERIFY: "release_verify_ms",
  CACHE_LOOKUP: "cache_lookup_ms",
  SCHEDULER_WAIT: "scheduler_wait_ms",
  PROCESS_STARTUP: "process_startup_ms",
})

export const WALL_CATEGORIES = Object.freeze(Object.values(WALL_CATEGORY))

// Operation kinds the detector watches for repeats.
export const WASTE_OPERATION = Object.freeze({
  GATE: "gate",
  READ: "read",
  FILE_SCAN: "file-scan",
  SEARCH: "search",
  FULL_SUITE: "full-suite",
  BROWSER: "browser",
  REPO_INDEX: "repo-index",
  ADVISOR_EVIDENCE: "advisor-evidence",
})

// The efficiency-ledger `kind`s this module emits when it FEEDS Metrics V2. It
// is a PRODUCER of observations, never a second metrics authority: the counting
// and honesty rules live in efficiency-metrics-v16-10.
export const WASTE_EFFICIENCY_KIND = "execution-acceleration"

function finite(value) {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Deterministic waste detector. It records each expensive operation as
 * (operation, identity, workspaceGeneration) and reports a repeat when the SAME
 * identity is observed again at the SAME workspace generation.
 *
 * @param {object} [options]
 * @param {number} [options.now] deterministic clock (ms)
 */
export function createWasteDetector(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const seen = new Map() // key -> { count, firstMs, lastMs, wallMs, generation, operation, identity }
  const order = []

  function keyOf(operation, identity, generation) {
    return [String(operation), String(identity), String(generation)].join("\u0000")
  }

  return {
    schemaVersion: WASTE_DETECTOR_SCHEMA_VERSION,
    policy: WASTE_DETECTOR_POLICY,

    /**
     * Record one execution of an operation.
     * @returns {{ repeated: boolean, count: number, wastedWallMs: number }}
     */
    record(operation, identity, wallMs = null, generation = null) {
      const at = Number(now())
      const key = keyOf(operation, identity, generation)
      const wall = finite(wallMs)
      let row = seen.get(key)
      if (!row) {
        row = { operation: String(operation), identity: String(identity), generation, count: 0, firstMs: at, lastMs: at, wallMs: 0, measuredWall: true }
        seen.set(key, row)
        order.push(key)
      }
      row.count += 1
      row.lastMs = at
      if (wall != null) row.wallMs += wall
      else row.measuredWall = false
      const repeated = row.count > 1
      return { repeated, count: row.count, wastedWallMs: repeated && wall != null ? wall : 0 }
    },

    /** The waste report: only operations with count > 1 are wasted work. */
    report() {
      const wasted = []
      for (const key of order) {
        const row = seen.get(key)
        if (!row || row.count <= 1) continue
        // Wasted wall = the wall time of every repeat AFTER the first.
        const perRepeat = row.measuredWall && row.count > 1 ? row.wallMs / row.count : null
        const wastedWallMs = perRepeat != null ? perRepeat * (row.count - 1) : null
        wasted.push({
          operation: row.operation,
          identity: row.identity,
          workspaceGeneration: row.generation,
          count: row.count,
          // A repeat count is MEASURED; the wall figure is DERIVED from a measured
          // total, or NOT_MEASURED when no timing was supplied.
          wastedWallMs: wastedWallMs != null ? derived(Math.round(wastedWallMs)) : NOT_MEASURED,
          reason: "same-operation-same-workspace-generation",
        })
      }
      wasted.sort((a, b) => (b.count - a.count) || String(a.operation).localeCompare(String(b.operation)))
      return {
        schemaVersion: WASTE_DETECTOR_SCHEMA_VERSION,
        policy: WASTE_DETECTOR_POLICY,
        operationsObserved: order.length,
        wastedOperations: wasted.length,
        wasted,
      }
    },

    reset() {
      seen.clear()
      order.length = 0
    },
  }
}

/**
 * Wall-time attribution. Collect MEASURED samples per category and render an
 * honest summary. A category with no sample reads as NOT_MEASURED.
 */
export function createWallTimeAttribution(options = {}) {
  const samples = new Map()
  const counters = {
    fresh_tool_calls: 0,
    reused_tool_results: 0,
    fresh_gate_runs: 0,
    reused_gate_receipts: 0,
    repo_scans: 0,
    index_rebuilds: 0,
    affected_test_count: 0,
    full_suite_count: 0,
    release_verify_count: 0,
  }
  let totalWallMs = finite(options.totalWallMs)

  return {
    schemaVersion: WASTE_DETECTOR_SCHEMA_VERSION,
    policy: WASTE_DETECTOR_POLICY,

    /** Add a MEASURED wall sample to a category. */
    observe(category, wallMs) {
      const value = finite(wallMs)
      if (value == null) return
      if (!WALL_CATEGORIES.includes(/** @type {any} */ (String(category)))) return
      samples.set(category, (samples.get(category) || 0) + value)
    },

    /** Increment a count counter. */
    count(name, delta = 1) {
      if (name in counters) counters[name] += Number(delta) || 0
    },

    setTotalWall(wallMs) {
      totalWallMs = finite(wallMs)
    },

    summary() {
      const categories = {}
      for (const category of WALL_CATEGORIES) {
        const value = samples.get(category)
        categories[category] = value == null ? NOT_MEASURED : measured(value)
      }
      // A sum of MEASURED categories is DERIVED, and only when at least one
      // category was measured. It is explicitly NOT the total wall time: phases
      // can overlap or be unobserved.
      const measuredCategories = WALL_CATEGORIES.filter((category) => samples.has(category))
      const attributedMs = measuredCategories.length
        ? measuredCategories.reduce((sum, category) => sum + (samples.get(category) || 0), 0)
        : null
      return {
        schemaVersion: WASTE_DETECTOR_SCHEMA_VERSION,
        policy: WASTE_DETECTOR_POLICY,
        categories,
        attributedMs: attributedMs == null ? NOT_MEASURED : derived(attributedMs),
        totalWallMs: totalWallMs == null ? NOT_MEASURED : measured(totalWallMs),
        counters: { ...counters },
        // Honest: we do not fabricate a critical path or an overlap saving.
        criticalPathMs: NOT_MEASURED,
        parallelOverlapSavedMs: NOT_MEASURED,
        provenance: {
          categories: measuredCategories.length ? "MEASURED" : "NOT_MEASURED",
          attributed: attributedMs == null ? "NOT_MEASURED" : "DERIVED",
          criticalPath: "NOT_MEASURED",
          overlapSaved: "NOT_MEASURED",
        },
      }
    },

    reset() {
      samples.clear()
      for (const key of Object.keys(counters)) counters[key] = 0
    },
  }
}

/**
 * Estimate an overlap saving from measured serial and overlapped wall times.
 * ESTIMATED, and only when both sides are real measurements. Never promoted.
 */
export function estimateOverlapSaving(serialMs, overlappedMs) {
  const serial = finite(serialMs)
  const overlapped = finite(overlappedMs)
  if (serial == null || overlapped == null || overlapped > serial) return NOT_MEASURED
  return estimated(Math.max(0, serial - overlapped))
}

/**
 * Bridge a wall-time attribution summary + a waste report into
 * `efficiency.observation` rows that V16.10 Metrics V2 already knows how to
 * aggregate. This module PRODUCES observations; it does NOT aggregate them.
 * Every count is MEASURED (a count of a real event); a wasted-wall figure keeps
 * its own DERIVED/NOT_MEASURED provenance and is never promoted.
 *
 * @param {object} wallSummary  a createWallTimeAttribution().summary() result
 * @param {object} wasteReport  a createWasteDetector().report() result
 * @returns {object[]} efficiency.observation rows (in-memory; persist via
 *   efficiency-ledger.recordEfficiencyEvent if desired)
 */
export function wallAttributionToEfficiencyEvents(wallSummary = {}, wasteReport = {}) {
  const counters = wallSummary.counters || {}
  const events = []
  const countEvent = (operation, count) => {
    const value = finite(count)
    if (value == null) return
    events.push({
      kind: WASTE_EFFICIENCY_KIND,
      operation,
      metrics: { count: Math.max(0, value) },
      provenance: { count: "MEASURED" },
    })
  }
  countEvent("reused-tool-results", counters.reused_tool_results)
  countEvent("fresh-tool-calls", counters.fresh_tool_calls)
  countEvent("reused-gate-receipts", counters.reused_gate_receipts)
  countEvent("fresh-gate-runs", counters.fresh_gate_runs)
  countEvent("repo-scans", counters.repo_scans)
  countEvent("index-rebuilds", counters.index_rebuilds)
  countEvent("affected-test-count", counters.affected_test_count)
  countEvent("full-suite-runs", counters.full_suite_count)
  countEvent("release-verify-runs", counters.release_verify_count)
  // Repeated operations: the repeat COUNT is measured; the wasted wall figure
  // keeps the provenance the detector assigned it (DERIVED or NOT_MEASURED).
  for (const row of wasteReport.wasted || []) {
    events.push({
      kind: WASTE_EFFICIENCY_KIND,
      operation: `repeat:${row.operation}`,
      metrics: { count: Number(row.count) || 0, wastedWallMs: row.wastedWallMs?.value ?? null },
      provenance: { count: "MEASURED", wastedWallMs: row.wastedWallMs?.provenance || "NOT_MEASURED" },
    })
  }
  return events
}

export const wasteDetectorExports = Object.freeze({
  createWasteDetector,
  createWallTimeAttribution,
  estimateOverlapSaving,
  wallAttributionToEfficiencyEvents,
  WALL_CATEGORY,
  WALL_CATEGORIES,
  WASTE_OPERATION,
  WASTE_EFFICIENCY_KIND,
})
