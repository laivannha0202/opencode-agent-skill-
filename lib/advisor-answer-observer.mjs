// V16.9 advisor answer observer.
//
// WHY THIS MODULE EXISTS
//
// V16.8 polls the advisor's answer region and hands the raw classification
// straight to the controller's wait loop. The classification primitive is
// already proven (`lib/deepseek-answer.mjs`), but NOTHING owns the observation
// lifecycle: how many polls happened, whether the observed text actually
// STABILISED, whether a read failure was recoverable, and whether the answer
// that was accepted belongs to THIS generation's baseline.
//
// This module owns exactly that. It is transport-agnostic: it accepts POLLING
// snapshots (the only channel the browser worker exposes today) and, when a
// future worker offers a push/event channel, the same classifier is fed by
// events without changing the decision. It does NOT open a socket, spawn a
// process or mutate the page; the caller supplies each observation.
//
// It owns NO parsing policy and NO provider failure classification: those stay
// in `deepseek-answer.mjs` and the provider adapter. This module adds the
// lifecycle: stability window, recoverable read failures, and an honest
// generation-scoped verdict.

import {
  DEEPSEEK_ANSWER_POLL_STATE,
  DEEPSEEK_ANSWER_STABLE_MS,
  classifyAnswerPoll,
  preserveAnswerReadFailure,
  sanitizeAnswerObservation,
  shouldRecoverAnswerRead,
} from "./deepseek-answer.mjs"

export const ADVISOR_ANSWER_OBSERVER_SCHEMA_VERSION = 1
export const ADVISOR_ANSWER_OBSERVER_POLICY = "advisor-answer-observer-v16-9"

// States that mean "keep observing": nothing is final yet.
const PENDING_STATES = new Set([
  DEEPSEEK_ANSWER_POLL_STATE.NO_REGION_YET,
  DEEPSEEK_ANSWER_POLL_STATE.NEW_REGION_EMPTY,
  DEEPSEEK_ANSWER_POLL_STATE.PARTIAL_JSON,
  DEEPSEEK_ANSWER_POLL_STATE.NEW_REGION_STREAMING,
  DEEPSEEK_ANSWER_POLL_STATE.NEW_REGION_TEXT,
])

/**
 * Create an answer observer for one consult/follow-up.
 *
 * @param {object} options
 * @param {number} [options.stableMs] how long the text must be unchanged
 * @param {number} [options.maxPolls] hard poll ceiling
 * @param {number} [options.now] injectable clock (tests)
 */
export function createAdvisorAnswerObserver(options = {}) {
  const stableMs = Number.isFinite(Number(options.stableMs))
    ? Math.max(0, Number(options.stableMs))
    : DEEPSEEK_ANSWER_STABLE_MS
  const maxPolls = Number.isFinite(Number(options.maxPolls)) ? Math.max(1, Math.trunc(Number(options.maxPolls))) : 240
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  let polls = 0
  let consecutiveReadFailures = 0
  let lastState = null
  let lastText = null
  let lastChangeAt = null
  let stableSince = null
  let accepted = null

  /**
   * Feed ONE observation.
   *
   * @param {object} input
   * @param {object} [input.observation] raw observation (sanitized internally)
   * @param {object} [input.baseline]
   * @param {object} [input.parseResult]  {ok, value|error}
   * @param {object} [input.readError]    when the read itself failed
   * @returns {object} a bounded verdict; never throws
   */
  function observe(input = {}) {
    polls += 1
    if (input.readError) {
      consecutiveReadFailures += 1
      // `preserveAnswerReadFailure` is the proven bounded classifier for the
      // failure LABEL; the recovery decision is `shouldRecoverAnswerRead`.
      const classified = preserveAnswerReadFailure(input.readError, consecutiveReadFailures)
      const recoverable = shouldRecoverAnswerRead(consecutiveReadFailures)
      return {
        schemaVersion: ADVISOR_ANSWER_OBSERVER_SCHEMA_VERSION,
        policy: ADVISOR_ANSWER_OBSERVER_POLICY,
        done: false,
        recoverable,
        state: "read-failure",
        failure: classified.answerReadFailure,
        consecutiveReadFailures,
        polls,
        action: recoverable ? "retry-read" : "fail",
        // A read failure is NOT a parse failure: the caller must not treat a
        // recovered read as evidence that the answer was malformed.
        reason: recoverable ? "recoverable-read-failure" : "read-failures-exhausted",
      }
    }
    consecutiveReadFailures = 0
    const observation = sanitizeAnswerObservation(input.observation || {})
    const state = classifyAnswerPoll({ observation, baseline: input.baseline || null, parseResult: input.parseResult || null })
    const text = typeof observation.answerText === "string" ? observation.answerText : ""
    const at = Number(now())
    if (text !== lastText) {
      lastText = text
      lastChangeAt = at
      stableSince = null
    } else if (stableSince === null && lastChangeAt !== null && at - lastChangeAt >= stableMs) {
      stableSince = lastChangeAt
    }
    lastState = state

    const parsed = input.parseResult && input.parseResult.ok === true
    const stable = stableSince !== null
    if (parsed) {
      accepted = { kind: "parsed", state, at }
      return finish(state, true, "valid-complete-json", { stable })
    }
    // Text present, not yet parseable: only STABLE text is a final answer. A
    // streaming answer must keep polling; a stable-but-unparseable answer is a
    // real failure, not a transient one.
    if (text.trim() && stable) {
      accepted = { kind: "unparsed", state, at }
      return finish(state, true, state === DEEPSEEK_ANSWER_POLL_STATE.NEW_REGION_TEXT ? "answer-parse" : "answer-unparseable", { stable })
    }
    if (polls >= maxPolls) {
      return finish(state, true, "poll-ceiling", { stable })
    }
    return {
      schemaVersion: ADVISOR_ANSWER_OBSERVER_SCHEMA_VERSION,
      policy: ADVISOR_ANSWER_OBSERVER_POLICY,
      done: false,
      recoverable: true,
      state,
      polls,
      stable,
      textChars: text.length,
      pending: PENDING_STATES.has(state),
      action: "continue",
      reason: null,
    }
  }

  function finish(state, done, reason, extra) {
    return {
      schemaVersion: ADVISOR_ANSWER_OBSERVER_SCHEMA_VERSION,
      policy: ADVISOR_ANSWER_OBSERVER_POLICY,
      done,
      recoverable: false,
      state,
      polls,
      action: "stop",
      reason,
      ...extra,
    }
  }

  return {
    schemaVersion: ADVISOR_ANSWER_OBSERVER_SCHEMA_VERSION,
    policy: ADVISOR_ANSWER_OBSERVER_POLICY,
    observe,
    state() {
      return {
        schemaVersion: ADVISOR_ANSWER_OBSERVER_SCHEMA_VERSION,
        policy: ADVISOR_ANSWER_OBSERVER_POLICY,
        polls,
        consecutiveReadFailures,
        lastState,
        stable: stableSince !== null,
        accepted,
        stableMs,
        maxPolls,
      }
    },
  }
}
