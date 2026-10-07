// V16.9 advisor dialogue coordinator.
//
// WHY THIS MODULE EXISTS
//
// V16.8 can consult and, on a second bounded turn, follow up. But the SEQUENCING
// is implicit in the controller: which turn is legal, whether the follow-up
// carries a real delta, and - the invariant that matters most - that NO second
// Pi LLM reasoning turn runs concurrently with the advisor. A controller that
// sequences turns with `if` statements inside a 10k-line file cannot enforce
// that invariant; it can only hope the branches are exhaustive.
//
// This module owns the DIALOGUE SEQUENCE. It does NOT call the provider, does
// NOT build packets and does NOT decide admission: those are owned by the lane,
// `decision-packet.mjs` and `advisor-admission.mjs`. It composes two proven
// primitives:
//
//   * `lib/fresh-evidence.mjs`      - is there a real delta worth a follow-up?
//   * `lib/followup-budget.mjs`     - does the submit budget allow the send?
//
// and enforces one invariant the primitives do not: a single-flight turn lock.
// Only one advisor turn may be IN FLIGHT at a time, and no Pi reasoning turn may
// be dispatched while one is. `beginTurn()` refuses a concurrent turn rather
// than queueing it, because a queued second consult is exactly the "second Pi
// turn concurrent with DeepSeek" failure the V16.9 rules forbid.

import { computeFollowUpDelta, gateFollowUpDispatch } from "./fresh-evidence.mjs"
import { accountExternalSubmit, maySendSecondFollowUp } from "./followup-budget.mjs"

export const ADVISOR_DIALOGUE_SCHEMA_VERSION = 1
export const ADVISOR_DIALOGUE_POLICY = "advisor-dialogue-coordinator-v16-9"

export const DIALOGUE_TURN = Object.freeze({
  CONSULT: "consult",
  FOLLOW_UP: "follow-up",
})

export const DIALOGUE_REASON = Object.freeze({
  READY: "ready",
  CONSULT_ALREADY_SENT: "consult-already-sent",
  TURN_IN_FLIGHT: "advisor-turn-in-flight",
  NO_DELTA: "no-fresh-delta",
  STALE_STATE: "stale-repository-state",
  BUDGET_EXHAUSTED: "submit-budget-exhausted",
  SECOND_FOLLOW_UP_DENIED: "second-follow-up-denied",
  ADVISOR_UNAVAILABLE: "advisor-unavailable",
})

/**
 * Create the dialogue coordinator for one advisor lifecycle.
 *
 * @param {object} options
 * @param {number} [options.maxFollowUps] hard ceiling on follow-ups
 * @param {number} [options.submitBudget] external-submit budget
 */
export function createAdvisorDialogueCoordinator(options = {}) {
  const maxFollowUps = Number.isFinite(Number(options.maxFollowUps)) ? Math.max(0, Math.trunc(Number(options.maxFollowUps))) : 1
  let consultSent = false
  let followUpsSent = 0
  let inFlight = null
  let ledger = { submitted: 0, budget: Number.isFinite(Number(options.submitBudget)) ? Math.max(0, Math.trunc(Number(options.submitBudget))) : 1 + maxFollowUps }
  let providerSeenEvidence = null
  let lastDelta = null
  const events = []

  function log(type, detail) {
    events.push({ type, at: Date.now(), detail })
    if (events.length > 64) events.shift()
  }

  /**
   * Reserve the single flight slot for one advisor turn. Returns a token that
   * MUST be passed to `endTurn()`. A concurrent call is REFUSED, never queued.
   */
  function beginTurn(kind) {
    if (inFlight) return { ok: false, reason: DIALOGUE_REASON.TURN_IN_FLIGHT, inFlight: inFlight.kind }
    const token = { kind: String(kind), startedAt: Date.now() }
    inFlight = token
    return { ok: true, token }
  }

  /** Release the flight slot. Safe to call twice. */
  function endTurn(token) {
    if (inFlight && (!token || inFlight === token)) inFlight = null
    return true
  }

  /** Whether ANY advisor turn is currently in flight. */
  function isTurnInFlight() {
    return inFlight !== null
  }

  /**
   * Decide whether a CONSULT may start. Records the consult as sent on approval.
   * The caller then MUST `beginTurn` before dispatching.
   */
  function mayConsult() {
    if (consultSent) return { ok: false, reason: DIALOGUE_REASON.CONSULT_ALREADY_SENT }
    if (inFlight) return { ok: false, reason: DIALOGUE_REASON.TURN_IN_FLIGHT }
    return { ok: true, reason: DIALOGUE_REASON.READY }
  }

  function noteConsultDispatched(evidence = null) {
    consultSent = true
    if (evidence) providerSeenEvidence = evidence
    ledger = accountExternalSubmit(ledger, 1)
    log("consult-dispatched", { submitted: ledger.submitted })
    return ledger
  }

  /**
   * Decide whether a FOLLOW-UP may start, given the CURRENT repository evidence.
   *
   * A follow-up requires ALL of:
   *   - a consult was already sent;
   *   - a fresh, CHANGED delta exists (owned by fresh-evidence);
   *   - the follow-up ceiling and submit budget allow it (owned by
   *     followup-budget).
   * The second-follow-up rule (the strictest case) is delegated to
   * `maySendSecondFollowUp` so its policy is not duplicated.
   */
  function mayFollowUp(currentEvidence, gate = {}) {
    if (inFlight) return { ok: false, reason: DIALOGUE_REASON.TURN_IN_FLIGHT }
    if (!consultSent) return { ok: false, reason: DIALOGUE_REASON.CONSULT_ALREADY_SENT }
    if (followUpsSent >= maxFollowUps) return { ok: false, reason: DIALOGUE_REASON.BUDGET_EXHAUSTED }
    const dispatched = gateFollowUpDispatch(providerSeenEvidence || {}, currentEvidence || {}, { refreshOk: gate.refreshOk !== false })
    if (!dispatched.ok) return { ok: false, reason: DIALOGUE_REASON.STALE_STATE, delta: dispatched.delta }
    if (dispatched.sendDelta === false) return { ok: false, reason: DIALOGUE_REASON.NO_DELTA, delta: dispatched.delta }
    if (followUpsSent >= 1) {
      const second = maySendSecondFollowUp(
        { followUpsSent },
        {
          freshVerifierEvidence: gate.freshVerifierEvidence === true,
          fingerprintChanged: dispatched.delta?.changed === true,
          firstResolved: gate.firstResolved === true,
          benefitExceedsCost: gate.benefitExceedsCost === true,
          submitBudgetAllows: ledger.remaining > 0,
          sessionHealthy: gate.sessionHealthy !== false,
        },
      )
      if (!second.allowed) return { ok: false, reason: DIALOGUE_REASON.SECOND_FOLLOW_UP_DENIED, blockedBy: second.reasons, delta: dispatched.delta }
    }
    if (ledger.remaining <= 0) return { ok: false, reason: DIALOGUE_REASON.BUDGET_EXHAUSTED, delta: dispatched.delta }
    lastDelta = dispatched.delta
    return { ok: true, reason: DIALOGUE_REASON.READY, delta: dispatched.delta }
  }

  function noteFollowUpDispatched(currentEvidence = null) {
    followUpsSent += 1
    ledger = accountExternalSubmit(ledger, 1)
    if (currentEvidence) providerSeenEvidence = currentEvidence
    log("follow-up-dispatched", { followUpsSent, submitted: ledger.submitted })
    return ledger
  }

  /** Refresh the evidence the provider last saw (after a delivered turn). */
  function noteProviderSeen(evidence) {
    if (evidence) providerSeenEvidence = evidence
    return providerSeenEvidence
  }

  return {
    schemaVersion: ADVISOR_DIALOGUE_SCHEMA_VERSION,
    policy: ADVISOR_DIALOGUE_POLICY,
    maxFollowUps,
    beginTurn,
    endTurn,
    isTurnInFlight,
    mayConsult,
    noteConsultDispatched,
    mayFollowUp,
    noteFollowUpDispatched,
    noteProviderSeen,
    /** Bounded delta between the last provider-seen state and current. */
    deltaAgainst(currentEvidence) {
      return computeFollowUpDelta(providerSeenEvidence || {}, currentEvidence || {})
    },
    state() {
      return {
        schemaVersion: ADVISOR_DIALOGUE_SCHEMA_VERSION,
        policy: ADVISOR_DIALOGUE_POLICY,
        consultSent,
        followUpsSent,
        inFlight: inFlight?.kind || null,
        submitted: ledger.submitted,
        remainingSubmits: ledger.remaining,
        automaticRetries: ledger.automaticRetries,
        lastDelta,
        events: events.slice(-8),
      }
    },
  }
}
