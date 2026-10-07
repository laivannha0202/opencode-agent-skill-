// V16.12 Waste Detector + Wall-Time Attribution: behavior tests.
//
// This module DETECTS repeated expensive operations and ATTRIBUTES wall time to
// honest categories. It must never become a second metrics authority: it PRODUCES
// observations for V16.10 Metrics V2. Every value carries a provenance label and
// a category with no observation reads NOT_MEASURED, never 0.

import test from "node:test"
import assert from "node:assert/strict"

import {
  WASTE_DETECTOR_POLICY,
  WALL_CATEGORY,
  WALL_CATEGORIES,
  WASTE_OPERATION,
  WASTE_EFFICIENCY_KIND,
  createWasteDetector,
  createWallTimeAttribution,
  estimateOverlapSaving,
  wallAttributionToEfficiencyEvents,
} from "../lib/waste-detector-v16-12.mjs"
import { PROVENANCE } from "../lib/measurement-provenance.mjs"
import { aggregateEfficiencyMetrics } from "../lib/efficiency-metrics-v16-10.mjs"

function makeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test("waste detector policy id is byte-stable", () => {
  assert.equal(WASTE_DETECTOR_POLICY, "waste-detector-v16-12")
})

test("a single occurrence is not waste", () => {
  const detector = createWasteDetector({ now: () => 0 })
  const result = detector.record(WASTE_OPERATION.GATE, "npm test", 100, "g1")
  assert.equal(result.repeated, false)
  assert.equal(detector.report().wastedOperations, 0)
})

test("the same operation at the same workspace generation is waste", () => {
  const clock = makeClock()
  const detector = createWasteDetector({ now: clock.now })
  detector.record(WASTE_OPERATION.GATE, "npm test", 100, "g1")
  clock.advance(10)
  const second = detector.record(WASTE_OPERATION.GATE, "npm test", 100, "g1")
  assert.equal(second.repeated, true)
  assert.equal(second.count, 2)
  assert.equal(second.wastedWallMs, 100)
  const report = detector.report()
  assert.equal(report.wastedOperations, 1)
  assert.equal(report.wasted[0].operation, WASTE_OPERATION.GATE)
  assert.equal(report.wasted[0].count, 2)
  assert.equal(report.wasted[0].wastedWallMs.provenance, PROVENANCE.DERIVED)
  assert.equal(report.wasted[0].wastedWallMs.value, 100)
})

test("a repeat at a DIFFERENT workspace generation is not waste (the work was needed)", () => {
  const detector = createWasteDetector({ now: () => 0 })
  detector.record(WASTE_OPERATION.GATE, "npm test", 100, "g1")
  detector.record(WASTE_OPERATION.GATE, "npm test", 100, "g2")
  assert.equal(detector.report().wastedOperations, 0)
})

test("wasted wall is NOT_MEASURED when no timing was supplied", () => {
  const detector = createWasteDetector({ now: () => 0 })
  detector.record(WASTE_OPERATION.SEARCH, "q", null, "g1")
  detector.record(WASTE_OPERATION.SEARCH, "q", null, "g1")
  const row = detector.report().wasted[0]
  assert.equal(row.count, 2)
  assert.equal(row.wastedWallMs.provenance, PROVENANCE.NOT_MEASURED)
})

test("the waste report sorts by repeat count", () => {
  const detector = createWasteDetector({ now: () => 0 })
  detector.record(WASTE_OPERATION.GATE, "a", 1, "g")
  detector.record(WASTE_OPERATION.GATE, "a", 1, "g")
  detector.record(WASTE_OPERATION.SEARCH, "b", 1, "g")
  detector.record(WASTE_OPERATION.SEARCH, "b", 1, "g")
  detector.record(WASTE_OPERATION.SEARCH, "b", 1, "g")
  const wasted = detector.report().wasted
  assert.equal(wasted[0].operation, WASTE_OPERATION.SEARCH)
  assert.equal(wasted[0].count, 3)
})

test("detector.reset clears all observations", () => {
  const detector = createWasteDetector({ now: () => 0 })
  detector.record(WASTE_OPERATION.GATE, "x", 1, "g")
  detector.record(WASTE_OPERATION.GATE, "x", 1, "g")
  detector.reset()
  assert.equal(detector.report().operationsObserved, 0)
})

test("wall attribution: an unobserved category reads NOT_MEASURED, never 0", () => {
  const wall = createWallTimeAttribution()
  wall.observe(WALL_CATEGORY.TOOL_EXEC, 120)
  const summary = wall.summary()
  assert.equal(summary.categories[WALL_CATEGORY.TOOL_EXEC].provenance, PROVENANCE.MEASURED)
  assert.equal(summary.categories[WALL_CATEGORY.TOOL_EXEC].value, 120)
  assert.equal(summary.categories[WALL_CATEGORY.VERIFICATION].provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(summary.categories[WALL_CATEGORY.VERIFICATION].value, null)
})

test("wall attribution: the attributed sum is DERIVED and never the total wall", () => {
  const wall = createWallTimeAttribution({ totalWallMs: 1000 })
  wall.observe(WALL_CATEGORY.TOOL_EXEC, 100)
  wall.observe(WALL_CATEGORY.VERIFICATION, 50)
  const summary = wall.summary()
  assert.equal(summary.attributedMs.provenance, PROVENANCE.DERIVED)
  assert.equal(summary.attributedMs.value, 150)
  assert.equal(summary.totalWallMs.provenance, PROVENANCE.MEASURED)
  assert.equal(summary.totalWallMs.value, 1000)
  // No fabricated critical path or overlap saving.
  assert.equal(summary.criticalPathMs.provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(summary.parallelOverlapSavedMs.provenance, PROVENANCE.NOT_MEASURED)
})

test("wall attribution: an unknown category is ignored, not recorded", () => {
  const wall = createWallTimeAttribution()
  wall.observe("not-a-category", 999)
  assert.equal(wall.summary().attributedMs.provenance, PROVENANCE.NOT_MEASURED)
})

test("estimateOverlapSaving is ESTIMATED and only from two real measurements", () => {
  assert.equal(estimateOverlapSaving(200, 80).provenance, PROVENANCE.ESTIMATED)
  assert.equal(estimateOverlapSaving(200, 80).value, 120)
  assert.equal(estimateOverlapSaving(null, 80).provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(estimateOverlapSaving(80, 200).provenance, PROVENANCE.NOT_MEASURED)
})

test("counters are tracked for tool calls, gate runs, suite and repo scans", () => {
  const wall = createWallTimeAttribution()
  wall.count("reused_tool_results", 3)
  wall.count("full_suite_count", 1)
  wall.count("repo_scans", 2)
  const counters = wall.summary().counters
  assert.equal(counters.reused_tool_results, 3)
  assert.equal(counters.full_suite_count, 1)
  assert.equal(counters.repo_scans, 2)
})

test("the efficiency bridge produces observations Metrics V2 can aggregate", () => {
  const detector = createWasteDetector({ now: () => 0 })
  detector.record(WASTE_OPERATION.GATE, "npm test", 100, "g1")
  detector.record(WASTE_OPERATION.GATE, "npm test", 100, "g1")
  const wall = createWallTimeAttribution({ totalWallMs: 500 })
  wall.count("reused_gate_receipts", 2)
  wall.count("fresh_gate_runs", 1)
  const events = wallAttributionToEfficiencyEvents(wall.summary(), detector.report())
  assert.ok(events.every((event) => event.kind === WASTE_EFFICIENCY_KIND))
  const rows = events.map((event) => ({ type: "efficiency.observation", ...event }))
  const metrics = aggregateEfficiencyMetrics(rows, [])
  // The events ARE observations to Metrics V2 - this module is a producer.
  assert.equal(metrics.observations, rows.length)
  const repeat = events.find((event) => event.operation === "repeat:gate")
  assert.equal(repeat.provenance.count, "MEASURED")
  assert.equal(repeat.provenance.wastedWallMs, "DERIVED")
})

test("every wall category id is stable and unique", () => {
  const values = Object.values(WALL_CATEGORY)
  assert.equal(new Set(values).size, values.length)
  assert.deepEqual(values, WALL_CATEGORIES)
})
