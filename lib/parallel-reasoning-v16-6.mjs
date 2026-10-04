// V16.6 parallel reasoning overlap.
//
// DeepSeek generation is network-bound and read-only; local investigation is
// disk-bound and read-only. Running them together is the one safe concurrency
// V16.6 adds: the DeepSeek turn proceeds WHILE local read-only work happens.
//
// Hard rules (enforced, not advisory):
//   * exactly ONE DeepSeek writer in flight, ever
//   * local work during an overlap must be READ-ONLY: no writes, no git
//     mutations, no permission changes, no verifier execution
//   * bounded by the unified budget (maxParallel) and the session pool
//   * overlap duration is MEASURED when a clock is supplied, otherwise
//     NOT_MEASURED - never invented
//
// If any rule is broken the overlap is refused (fail-closed): the run simply
// continues serially.

import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"

export const PARALLEL_REASONING_SCHEMA_VERSION = 1
export const PARALLEL_REASONING_RELEASE = "v16.6"
export const PARALLEL_REASONING_POLICY = "parallel-reasoning-v16-6"

export const READ_ONLY_OPERATIONS = Object.freeze([
  "read",
  "ls",
  "grep",
  "find",
  "ues_code",
  "diff",
  "status",
  "log",
  "show",
  "test-list",
  "telemetry",
])

export const FORBIDDEN_DURING_OVERLAP = Object.freeze([
  "write",
  "edit",
  "bash",
  "git-commit",
  "git-checkout",
  "git-reset",
  "permission",
  "verify",
  "browser",
  "spawn",
  "publish",
  "deploy",
])

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function createParallelReasoningState() {
  return {
    schemaVersion: PARALLEL_REASONING_SCHEMA_VERSION,
    policy: PARALLEL_REASONING_POLICY,
    planned: 0,
    executed: 0,
    refused: 0,
    overlapMs: null,
    overlapWindows: 0,
    writersDuringOverlap: 0,
    forbiddenOpsDuringOverlap: 0,
    readOnlyOpsDuringOverlap: 0,
    refusals: [],
    measuredWindows: 0,
  }
}

/**
 * Decide whether an overlap may start.
 *
 * `budget`      the unified orchestration budget
 * `session`     the session pool (or null)
 * `localWork`   the local operations about to run
 */
export function planParallelReasoning(input = {}) {
  const budget = input.budget || {}
  const state = input.state || createParallelReasoningState()
  const localWork = Array.isArray(input.localWork) ? input.localWork : []
  const reasons = []
  state.planned += 1

  if (budget.deepSeekMode === "off" || !budget.deepSeekMode) reasons.push("deepseek-off")
  if (budget.parallelReasoning === false) reasons.push("budget-disallows-overlap")
  const maxParallel = int(budget.maxParallel, 0, 0, 3)
  if (maxParallel < 1) reasons.push("max-parallel=0")
  if (input.deepSeekWriterInFlight === true) reasons.push("writer-already-in-flight")

  const forbidden = localWork
    .map((op) => String(op?.kind || op || "").toLowerCase())
    .filter((kind) => FORBIDDEN_DURING_OVERLAP.includes(kind))
  if (forbidden.length) reasons.push(`local-work-not-read-only:${forbidden.join(",")}`)

  const readOnly = localWork
    .filter((op) => READ_ONLY_OPERATIONS.includes(String(op?.kind || op || "").toLowerCase()))
    .map((op) => String(op?.kind || op))
  if (!readOnly.length && localWork.length) reasons.push("no-recognized-read-only-work")

  if (reasons.length) {
    state.refused += 1
    state.refusals.push(reasons[0])
    return {
      ok: false,
      overlapAllowed: false,
      reasons,
      readers: [],
      writer: "deepseek",
      maxReaders: Math.max(0, maxParallel - 1),
      policy: PARALLEL_REASONING_POLICY,
    }
  }

  state.executed += 1
  return {
    ok: true,
    overlapAllowed: true,
    reasons: ["read-only-overlap-approved"],
    readers: readOnly.slice(0, Math.max(1, maxParallel - 1)),
    writer: "deepseek",
    maxReaders: Math.max(1, maxParallel - 1),
    policy: PARALLEL_REASONING_POLICY,
  }
}

/**
 * Guard an overlap window that actually ran. Any violation means the window was
 * unsafe and must be reported; `ok:false` makes the run fall back to serial.
 */
export function guardOverlapWindow(input = {}) {
  const state = input.state || createParallelReasoningState()
  const plan = input.plan || { overlapAllowed: false }
  const operations = Array.isArray(input.operations) ? input.operations : []
  const violations = []

  if (!plan.overlapAllowed) violations.push("overlap-not-approved")
  if (int(input.deepSeekWriters, 0, 0, 8) > 1) violations.push("multiple-deepseek-writers")
  for (const op of operations) {
    const kind = String(op?.kind || op || "").toLowerCase()
    if (FORBIDDEN_DURING_OVERLAP.includes(kind)) {
      violations.push(`forbidden-op-during-overlap:${kind}`)
      state.forbiddenOpsDuringOverlap += 1
    } else if (READ_ONLY_OPERATIONS.includes(kind)) {
      state.readOnlyOpsDuringOverlap += 1
    }
  }
  if (int(input.deepSeekWriters, 0, 0, 8) >= 1) state.writersDuringOverlap += 1

  const start = Number(input.startedAt)
  const end = Number(input.endedAt)
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    const duration = end - start
    state.overlapWindows += 1
    state.measuredWindows += 1
    state.overlapMs = (state.overlapMs || 0) + duration
  }

  if (violations.length) state.refused += 1
  return { ok: violations.length === 0, violations, policy: PARALLEL_REASONING_POLICY }
}

/**
 * Telemetry. `overlapMs` is MEASURED only when every window supplied a clock;
 * otherwise it is NOT_MEASURED (never an estimate presented as fact).
 */
export function parallelReasoningTelemetry(state) {
  const row = state || createParallelReasoningState()
  const fullyMeasured = row.measuredWindows > 0 && row.measuredWindows === row.overlapWindows && row.overlapWindows > 0
  return {
    schemaVersion: PARALLEL_REASONING_SCHEMA_VERSION,
    policy: PARALLEL_REASONING_POLICY,
    planned: measured(int(row.planned, 0, 0, 9999)),
    executed: measured(int(row.executed, 0, 0, 9999)),
    refused: measured(int(row.refused, 0, 0, 9999)),
    overlapWindows: measured(int(row.overlapWindows, 0, 0, 9999)),
    readOnlyOpsDuringOverlap: measured(int(row.readOnlyOpsDuringOverlap, 0, 0, 99_999)),
    forbiddenOpsDuringOverlap: measured(int(row.forbiddenOpsDuringOverlap, 0, 0, 99_999)),
    writersDuringOverlap: measured(int(row.writersDuringOverlap, 0, 0, 99_999)),
    overlapMs: fullyMeasured ? measured(row.overlapMs) : NOT_MEASURED,
    overlapWallMs: NOT_MEASURED,
    wallClockSaved: NOT_MEASURED,
    serialBaselineMs: NOT_MEASURED,
    refusals: [...(row.refusals || [])].slice(0, 8),
    provenance: {
      counters: "MEASURED",
      overlapMs: fullyMeasured ? "MEASURED" : "NOT_MEASURED",
      savings: "NOT_MEASURED",
    },
  }
}

export const PARALLEL_REASONING_EXPORTS = Object.freeze([
  "createParallelReasoningState",
  "planParallelReasoning",
  "guardOverlapWindow",
  "parallelReasoningTelemetry",
  "READ_ONLY_OPERATIONS",
  "FORBIDDEN_DURING_OVERLAP",
])
