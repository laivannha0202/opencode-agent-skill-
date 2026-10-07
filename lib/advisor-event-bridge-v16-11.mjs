// V16.11 event-first answer bridge.
//
// WHY THIS MODULE EXISTS
//
// V16.9's `advisor-answer-observer.mjs` owns the answer STABILITY lifecycle, but
// it is only ever fed by a POLL loop: Node asks the worker to read the answer
// region every 500ms. That works, but it burns wall-clock (each poll is a full
// round-trip) and it cannot react the instant the page changes.
//
// V16.11 adds an EVENT channel (see `browser-transport-v16-11.mjs`). This bridge
// is the SINGLE place that decides, for one consult, WHICH channel is driving the
// observation:
//
//   * EVENT-FIRST: when the worker advertises the event channel, the bridge feeds
//     decoded events straight into the proven observer. A push notification
//     replaces a poll round-trip, so the answer is accepted as soon as it is
//     stable instead of on the next tick.
//
//   * BOUNDED POLL FALLBACK: when there is no event channel -- or the event
//     channel goes silent for longer than `eventSilenceMs` -- the bridge falls
//     back to polling. The fallback is ALWAYS bounded, so a worker that never
//     pushes an event can never hang the run.
//
// It reports WHICH channel produced the accepted answer, so Metrics can record
// `event_first` vs `poll_fallback` honestly and never claim an event win that did
// not happen.
//
// It owns NO stability policy (the observer does), NO transport (the protocol
// module does) and NO lifecycle (the session manager does).

import {
  ADVISOR_ANSWER_OBSERVER_POLICY,
  createAdvisorAnswerObserver,
} from "./advisor-answer-observer.mjs"
import { BROWSER_EVENT } from "./browser-transport-v16-11.mjs"

export const ADVISOR_EVENT_BRIDGE_SCHEMA_VERSION = 1
export const ADVISOR_EVENT_BRIDGE_POLICY = "advisor-event-bridge-v16-11"

// How the accepted answer was observed. Recorded verbatim so a measurement can
// never blur the two channels.
export const OBSERVATION_CHANNEL = Object.freeze({
  EVENT: "event",
  POLL: "poll",
  EVENT_THEN_POLL: "event-then-poll",
  NONE: "none",
})

// Events that require RECOVERY rather than an answer. The bridge surfaces them
// as a `recovery` signal and stops observing; it never treats them as an answer.
const RECOVERY_EVENTS = Object.freeze({
  [BROWSER_EVENT.AUTH_EXPIRED]: "auth-expired",
  [BROWSER_EVENT.AUTH_LOGIN_REQUIRED]: "auth-login-required",
  [BROWSER_EVENT.PAGE_CRASHED]: "page-crashed",
  [BROWSER_EVENT.BROWSER_DISCONNECTED]: "browser-disconnected",
  [BROWSER_EVENT.WORKER_EXITED]: "worker-exited",
})

// Events that carry answer TEXT and can advance the observer.
const ANSWER_EVENTS = new Set([
  BROWSER_EVENT.ANSWER_STARTED,
  BROWSER_EVENT.ANSWER_DELTA,
  BROWSER_EVENT.ANSWER_STABLE,
  BROWSER_EVENT.ANSWER_COMPLETED,
  BROWSER_EVENT.ANSWER_ERROR,
])

/**
 * Create the event-first bridge for ONE consult.
 *
 * @param {object} options
 * @param {object} options.baseline the pre-consult answer-region baseline
 * @param {boolean} [options.eventChannel] whether the worker advertises events
 * @param {number} [options.eventSilenceMs] fall back to polling after this gap
 * @param {number} [options.pollIntervalMs] bounded poll cadence
 * @param {number} [options.maxPolls] hard poll ceiling (always enforced)
 * @param {Function} [options.now] injectable clock
 * @param {Function} [options.readObservation] async () => observation (poll source)
 * @param {Function} [options.parseAnswer] (text) => { ok, value|error }
 * @param {object} [options.observer] a pre-built observer (tests)
 */
export function createAdvisorEventBridge(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const eventChannel = options.eventChannel === true
  const eventSilenceMs = Number.isFinite(Number(options.eventSilenceMs)) ? Math.max(0, Number(options.eventSilenceMs)) : 6000
  const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs)) ? Math.max(1, Number(options.pollIntervalMs)) : 500
  const readObservation = typeof options.readObservation === "function" ? options.readObservation : null
  const parseAnswer = typeof options.parseAnswer === "function" ? options.parseAnswer : (text) => ({ ok: false, error: "no-parser", text })
  const observer = options.observer || createAdvisorAnswerObserver({
    stableMs: options.stableMs,
    maxPolls: options.maxPolls,
    now,
  })

  let accepted = null
  let recovery = null
  let usedEvent = false
  let usedPoll = false
  let lastEventAt = eventChannel ? Number(now()) : null
  let eventsSeen = 0
  let polls = 0
  let deltasCoalesced = 0
  let lastText = ""
  let done = false

  function classifyEventText(decodedEvent) {
    const text = typeof decodedEvent.text === "string"
      ? decodedEvent.text
      : (typeof decodedEvent.data?.text === "string" ? decodedEvent.data.text : lastText)
    return text
  }

  /**
   * Feed ONE decoded transport event.
   *
   * Returns `{ handled, done, verdict?, recovery? }`. A recovery event is NOT an
   * answer: it returns `{ handled: true, recovery }` and marks the bridge done so
   * the caller runs the recovery path instead of accepting text.
   */
  function onEvent(decodedEvent = {}) {
    if (done) return { handled: false, done: true, stale: true }
    if (decodedEvent.kind !== "event") return { handled: false, done: false }
    eventsSeen += 1
    lastEventAt = Number(now())

    const recoveryReason = RECOVERY_EVENTS[decodedEvent.event]
    if (recoveryReason) {
      done = true
      recovery = { reason: recoveryReason, event: decodedEvent.event, workerEpoch: decodedEvent.workerEpoch, conversationId: decodedEvent.conversationId }
      return { handled: true, done: true, recovery }
    }
    if (!ANSWER_EVENTS.has(decodedEvent.event)) {
      // A harmless/unknown event: acknowledged, but it does not advance the answer.
      return { handled: false, done: false }
    }

    usedEvent = true
    const text = classifyEventText(decodedEvent)
    lastText = text
    const terminal = decodedEvent.event === BROWSER_EVENT.ANSWER_STABLE
      || decodedEvent.event === BROWSER_EVENT.ANSWER_COMPLETED
      || decodedEvent.event === BROWSER_EVENT.ANSWER_ERROR

    // A terminal push event is authoritative: it says the provider finished, so
    // the observer is told the text is stable without waiting out the window.
    const parseResult = terminal ? parseAnswer(text) : (decodedEvent.event === BROWSER_EVENT.ANSWER_ERROR ? { ok: false, error: "answer-error" } : null)
    const verdict = observer.observe({
      observation: { answerText: text, counts: { dataMessageRoleAssistant: 1 } },
      baseline: options.baseline || null,
      parseResult: terminal ? parseResult : null,
    })
    if (verdict.done === true) {
      done = true
      accepted = { channel: channelOf(), reason: verdict.reason, text, at: Number(now()) }
      return { handled: true, done: true, verdict }
    }
    return { handled: true, done: false, verdict }
  }

  /**
   * Run ONE bounded poll tick. Only meaningful in the poll channel or after the
   * event channel has gone silent past `eventSilenceMs`.
   */
  async function pollOnce() {
    if (done) return { done: true }
    // While the event channel is advertised AND alive (an event was seen recently)
    // OR it has only just opened, polling is unnecessary: skip without spending a
    // poll read. `!usedPoll` means we are still in the event-first phase.
    const eventPhase = eventChannel && !usedPoll
    if (eventPhase && lastEventAt !== null && Number(now()) - lastEventAt < eventSilenceMs) {
      return { skipped: true, reason: "event-channel-active", done: false }
    }
    polls += 1
    usedPoll = true
    if (!readObservation) return { done: false, error: "no-observation-source" }
    let observation = null
    try {
      observation = await readObservation()
    } catch (error) {
      const verdict = observer.observe({ readError: error })
      if (verdict.done === true || verdict.action === "fail") {
        done = true
        return { done: true, verdict, channel: channelOf() }
      }
      return { done: false, verdict, channel: channelOf() }
    }
    const text = typeof observation?.answerText === "string" ? observation.answerText : ""
    lastText = text
    const verdict = observer.observe({ observation, baseline: options.baseline || null, parseResult: parseAnswer(text) })
    if (verdict.done === true) {
      done = true
      accepted = { channel: channelOf(), reason: verdict.reason, text, at: Number(now()) }
      return { done: true, verdict, channel: channelOf() }
    }
    return { done: false, verdict, channel: channelOf() }
  }

  function channelOf() {
    if (usedEvent && usedPoll) return OBSERVATION_CHANNEL.EVENT_THEN_POLL
    if (usedEvent) return OBSERVATION_CHANNEL.EVENT
    if (usedPoll) return OBSERVATION_CHANNEL.POLL
    return OBSERVATION_CHANNEL.NONE
  }

  /** Note that the caller coalesced deltas (for honest measurement). */
  function noteCoalesced(count = 1) {
    deltasCoalesced += Math.max(0, Math.trunc(Number(count) || 0))
  }

  return {
    schemaVersion: ADVISOR_EVENT_BRIDGE_SCHEMA_VERSION,
    policy: ADVISOR_EVENT_BRIDGE_POLICY,
    observerPolicy: ADVISOR_ANSWER_OBSERVER_POLICY,
    eventChannel,
    pollIntervalMs,
    eventSilenceMs,
    onEvent,
    pollOnce,
    noteCoalesced,
    isDone: () => done,
    accepted: () => accepted,
    recovery: () => recovery,
    state() {
      return {
        schemaVersion: ADVISOR_EVENT_BRIDGE_SCHEMA_VERSION,
        policy: ADVISOR_EVENT_BRIDGE_POLICY,
        eventChannel,
        channel: channelOf(),
        // The honest measurement: which channel actually produced the answer.
        answerChannel: accepted ? accepted.channel : OBSERVATION_CHANNEL.NONE,
        done,
        eventsSeen,
        polls,
        deltasCoalesced,
        lastEventAt,
        recovery,
        observer: observer.state(),
      }
    },
  }
}
