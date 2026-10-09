// V16.17 (§8, §9) Run Budget Ledger + Run Wall-Clock Deadline.
//
// THE PROBLEM
//
// `reserveRunCost` (lib/orchestration-budget-v16-6.mjs) is a STATELESS
// per-request check: it answers "does THIS one wave fit?" by comparing the
// request against fixed per-request limits. Nothing remembers what earlier
// waves in the SAME run already spent, so N waves each individually "fit" while
// their sum blows past every ceiling. There was also no run-level wall-clock
// deadline — only per-child activity deadlines — so a run could grind forever
// as long as each child stayed individually alive.
//
// WHAT THIS MODULE OWNS
//
//   * ONE run-lifetime cumulative ledger: child turns, simultaneous calls,
//     DeepSeek calls, research calls, subprocess slots, test slots, and tokens.
//   * ONE run wall-clock deadline: runStartedAt / runDeadlineAt / remainingRunMs.
//
// WHAT IT DOES NOT OWN (single-authority law)
//
//   * The per-run BUDGET itself is still `computeOrchestrationBudget`. This
//     ledger WRAPS that result; it never recomputes a second budget.
//   * TOKEN interpretation is still the canonical provider usage normalizer.
//     This ledger accumulates `totalTokens` that the normalizer reported as
//     MEASURED; an UNKNOWN count accumulates as NOT_MEASURED (null) and never
//     silently becomes a measured zero.
//   * PASS remains the local deterministic verifier. This ledger is about
//     spend and time, never about correctness.
//
// HONESTY LAWS
//
//   1. A settled token count that was not provider-reported stays null; the
//      ledger reports `tokensMeasured: false` rather than a fabricated total.
//   2. An expired wall-clock deadline is a STOP signal. It may reduce
//      concurrency, serialize, or stop optional work; it may NOT remove
//      required verification (`verificationIntact` is always true).
//   3. Deterministic: identical inputs and identical `now` values produce an
//      identical decision. No wall-clock read happens unless the caller omits
//      `now`.

import { PROVIDER_USAGE_NORMALIZER_POLICY } from "./provider-usage-normalizer-v16-17.mjs"

export const RUN_BUDGET_LEDGER_POLICY = "run-budget-ledger-v16-17"
export const RUN_BUDGET_LEDGER_SCHEMA_VERSION = 1

/** Cumulative counters a run tracks across every wave. */
const COUNTERS = Object.freeze([
  "childTurns",
  "simultaneousCalls",
  "deepseekCalls",
  "researchCalls",
  "subprocessSlots",
  "testSlots",
])

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function int(value, fallback = 0) {
  return Math.trunc(num(value, fallback))
}

/**
 * Derive the run-lifetime ceilings from the canonical per-run budget. These are
 * the SAME numbers `reserveRunCost` uses per request, but now they are ceilings
 * for the whole run, not for one wave.
 */
export function deriveRunCeilings(budget = null) {
  const turns = budget?.deepSeekTurnBudget?.effectiveMaxTurns
  return {
    childTurns: turns != null ? Math.max(0, int(turns) * 4) : 24,
    simultaneousCalls: Math.max(1, Math.min(3, int(budget?.maxParallel, 2) || 2)),
    deepseekCalls: Math.max(0, Math.min(4, int(turns, 2))),
    researchCalls: 3,
    subprocessSlots: 4,
    testSlots: 4,
    // Token ceiling is intentionally absent: a run has no fabricated token
    // ceiling. Token spend is MEASURED and reported, never capped by a guess.
    totalTokens: null,
  }
}

/**
 * Create a run-scoped ledger. Call ONCE per run and thread the returned object
 * through every wave. Creating two ledgers for one run is the exact bug this
 * module exists to prevent.
 *
 * @param {object} options
 * @param {object} [options.budget]        canonical computeOrchestrationBudget result
 * @param {number} [options.runStartedAt]  epoch ms the run began
 * @param {number} [options.runWallClockMs] hard run deadline budget in ms
 * @param {string} [options.runId]
 * @param {string} [options.budgetSource]  provenance label ("v16_6-run-budget" | ...)
 */
export function createRunBudgetLedger(options = {}) {
  const budget = options.budget || null
  const ceilings = deriveRunCeilings(budget)
  const runStartedAt = num(options.runStartedAt, 0) || (options.runStartedAt ? int(options.runStartedAt) : 0)
  const wallClockMs = options.runWallClockMs === undefined || options.runWallClockMs === null
    ? null
    : Math.max(1_000, int(options.runWallClockMs))
  const runDeadlineAt = wallClockMs === null ? null : (runStartedAt || 0) + wallClockMs

  // Cumulative spend. Tokens are tracked separately with an explicit measured
  // flag so an unmeasured run is never reported as a measured zero.
  const spent = Object.fromEntries(COUNTERS.map((key) => [key, 0]))
  let tokensSpent = null
  let tokensMeasured = false
  let settlements = 0

  function nowMs(now) {
    return Number.isFinite(Number(now)) ? Number(now) : Date.now()
  }

  function remainingRunMs(now) {
    if (runDeadlineAt === null) return null
    return Math.max(0, runDeadlineAt - nowMs(now))
  }

  function expired(now) {
    if (runDeadlineAt === null) return false
    return nowMs(now) >= runDeadlineAt
  }

  /**
   * Reserve a wave against the CUMULATIVE ledger. Unlike the stateless
   * per-request check, `spent + requested` must fit the run ceiling.
   */
  function reserve(request = {}, now) {
    const reasons = []
    const requested = Object.fromEntries(
      COUNTERS.map((key) => [key, int(request[key], 0)]),
    )
    const atDeadline = expired(now)

    for (const key of COUNTERS) {
      const projected = spent[key] + requested[key]
      if (projected > ceilings[key]) {
        reasons.push({
          signal: `cumulative-over-${key}`,
          detail: `run already spent ${spent[key]}, request adds ${requested[key]}, ceiling ${ceilings[key]}`,
        })
      }
    }
    if (atDeadline) {
      reasons.push({ signal: "run-wall-clock-exhausted", detail: "run wall-clock deadline reached" })
    }

    let action = "admit"
    if (reasons.length) {
      const overSimultaneous = reasons.some((row) => row.signal === "cumulative-over-simultaneousCalls")
      const overAdvisor = reasons.some((row) => row.signal === "cumulative-over-deepseekCalls" || row.signal === "cumulative-over-researchCalls")
      const overSlots = reasons.some((row) => row.signal === "cumulative-over-subprocessSlots" || row.signal === "cumulative-over-testSlots")
      if (atDeadline) {
        // The run is out of time. Stop optional work; NEVER drop required
        // verification (the caller keeps every verifier gate).
        action = "stop-optional"
      } else if (overSimultaneous && requested.simultaneousCalls > 1) {
        action = "lower-concurrency"
      } else if (overAdvisor) {
        action = "delay-optional-advisor"
      } else if (overSlots || reasons.some((row) => row.signal === "cumulative-over-childTurns")) {
        action = "serialize"
      } else {
        action = "serialize"
      }
    }

    // Optional work is dropped first; required verification is untouchable.
    return {
      schemaVersion: RUN_BUDGET_LEDGER_SCHEMA_VERSION,
      policy: RUN_BUDGET_LEDGER_POLICY,
      runId: options.runId ? String(options.runId) : null,
      budgetSource: options.budgetSource ? String(options.budgetSource) : (budget ? "canonical-run-budget" : "default-fallback"),
      action,
      admitted: action === "admit",
      reasons,
      ceilings,
      spent: { ...spent },
      requested,
      remainingRunMs: remainingRunMs(now),
      runDeadlineAt,
      runWallClockExhausted: atDeadline,
      // Required verification is never removed by a spend/time decision.
      verificationIntact: true,
      tokensMeasured,
    }
  }

  /**
   * Commit ACTUAL usage after a wave finishes. Counter values are added; token
   * counts are added ONLY when the caller passes a provider-MEASURED number. A
   * `null`/missing token count leaves the measured total untouched (and never
   * turns the run's token accounting into a fabricated zero).
   */
  function settle(actual = {}) {
    for (const key of COUNTERS) {
      if (actual[key] === undefined || actual[key] === null) continue
      spent[key] += int(actual[key], 0)
    }
    const tokens = actual.totalTokens
    if (tokens !== undefined && tokens !== null && Number.isFinite(Number(tokens)) && Number(tokens) >= 0) {
      tokensSpent = (tokensSpent ?? 0) + Number(tokens)
      tokensMeasured = true
    }
    settlements += 1
    return snapshot()
  }

  function snapshot() {
    return {
      schemaVersion: RUN_BUDGET_LEDGER_SCHEMA_VERSION,
      policy: RUN_BUDGET_LEDGER_POLICY,
      runId: options.runId ? String(options.runId) : null,
      budgetSource: options.budgetSource ? String(options.budgetSource) : (budget ? "canonical-run-budget" : "default-fallback"),
      ceilings,
      spent: { ...spent },
      remaining: Object.fromEntries(COUNTERS.map((key) => [key, Math.max(0, ceilings[key] - spent[key])])),
      settlements,
      runStartedAt: runStartedAt || null,
      runDeadlineAt,
      runWallClockMs: wallClockMs,
      // A run whose tokens were never provider-reported keeps totalTokens null;
      // `tokensMeasured` distinguishes "zero tokens" from "unknown tokens".
      totalTokens: tokensMeasured ? tokensSpent : null,
      tokensMeasured,
      tokenProvenance: tokensMeasured ? "MEASURED" : "NOT_MEASURED",
      tokenPolicy: PROVIDER_USAGE_NORMALIZER_POLICY,
      verificationIntact: true,
    }
  }

  return {
    reserve,
    settle,
    snapshot,
    remainingRunMs,
    expired,
    ceilings,
    get spent() { return { ...spent } },
    policy: RUN_BUDGET_LEDGER_POLICY,
  }
}

/**
 * A single-shot helper for callers that already hold a run-scoped ledger: folds
 * a per-request `reserveRunCost`-style request into the ledger and returns the
 * CUMULATIVE decision. Kept tiny so production code does not re-implement the
 * accumulate-then-decide step.
 */
export function admitAgainstRunLedger(ledger, request = {}, now) {
  if (!ledger || typeof ledger.reserve !== "function") {
    throw new Error("admitAgainstRunLedger requires a run budget ledger")
  }
  return ledger.reserve(request, now)
}

export const runBudgetLedgerExports = Object.freeze({
  createRunBudgetLedger,
  deriveRunCeilings,
  admitAgainstRunLedger,
  RUN_BUDGET_LEDGER_POLICY,
  RUN_BUDGET_LEDGER_SCHEMA_VERSION,
})
