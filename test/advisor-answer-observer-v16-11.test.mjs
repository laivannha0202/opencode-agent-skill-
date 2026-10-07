// V16.11 event-first answer bridge tests.
//
// These prove the event-first path AND the bounded poll fallback, and that the
// bridge reports WHICH channel produced the answer honestly. No browser.

import test from "node:test"
import assert from "node:assert/strict"

import {
  ADVISOR_EVENT_BRIDGE_POLICY,
  OBSERVATION_CHANNEL,
  createAdvisorEventBridge,
} from "../lib/advisor-event-bridge-v16-11.mjs"
import { BROWSER_EVENT, decodeTransportMessage } from "../lib/browser-transport-v16-11.mjs"

function stableEvent(text) {
  return decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_STABLE, data: { text }, workerEpoch: 1, generation: 1 })
}

test("bridge: an answer.stable event is accepted on the EVENT channel", () => {
  const bridge = createAdvisorEventBridge({
    eventChannel: true,
    baseline: { counts: { dataMessageRoleAssistant: 0 } },
    parseAnswer: (text) => ({ ok: true, value: { text } }),
  })
  const result = bridge.onEvent(stableEvent('{"a":1}'))
  assert.equal(result.done, true)
  assert.equal(bridge.isDone(), true)
  assert.equal(bridge.state().answerChannel, OBSERVATION_CHANNEL.EVENT)
  assert.equal(bridge.state().polls, 0, "an event win must not spend a poll")
})

test("bridge: a recovery event stops the bridge and is NOT an answer", () => {
  const bridge = createAdvisorEventBridge({ eventChannel: true, baseline: {} })
  const event = decodeTransportMessage({ type: "event", event: BROWSER_EVENT.AUTH_EXPIRED, data: {}, workerEpoch: 1 })
  const result = bridge.onEvent(event)
  assert.equal(result.recovery.reason, "auth-expired")
  assert.equal(bridge.accepted(), null, "auth failure must never be accepted as an answer")
  assert.equal(bridge.recovery().reason, "auth-expired")
})

test("bridge: a page crash surfaces a recovery signal, not text", () => {
  const bridge = createAdvisorEventBridge({ eventChannel: true, baseline: {} })
  bridge.onEvent(decodeTransportMessage({ type: "event", event: BROWSER_EVENT.PAGE_CRASHED, data: {} }))
  assert.equal(bridge.recovery().reason, "page-crashed")
})

test("bridge: with no event channel the bridge uses the bounded poll fallback", async () => {
  let calls = 0
  const bridge = createAdvisorEventBridge({
    eventChannel: false,
    baseline: { counts: { dataMessageRoleAssistant: 0 } },
    readObservation: async () => {
      calls += 1
      return { counts: { dataMessageRoleAssistant: 1 }, answerText: '{"a":1}' }
    },
    parseAnswer: (text) => ({ ok: true, value: { text } }),
  })
  const result = await bridge.pollOnce()
  assert.equal(result.done, true)
  assert.equal(bridge.state().answerChannel, OBSERVATION_CHANNEL.POLL)
  assert.equal(calls, 1)
})

test("bridge: a silent event channel degrades to polling after the silence window", async () => {
  let clock = 0
  let polls = 0
  const bridge = createAdvisorEventBridge({
    eventChannel: true,
    eventSilenceMs: 1000,
    now: () => clock,
    baseline: { counts: { dataMessageRoleAssistant: 0 } },
    readObservation: async () => {
      polls += 1
      return { counts: { dataMessageRoleAssistant: 1 }, answerText: '{"a":1}' }
    },
    parseAnswer: (text) => ({ ok: true, value: { text } }),
  })
  // The event channel just opened; a poll now must be skipped (no need to poll).
  const skipped = await bridge.pollOnce()
  assert.equal(skipped.skipped, true)
  assert.equal(polls, 0)

  // The channel goes silent past the window: the bridge degrades to polling.
  clock = 2000
  const result = await bridge.pollOnce()
  assert.equal(result.done, true)
  // No event was ever CONSUMED, so the honest channel is plain `poll`: an
  // advertised-but-silent event channel must not be reported as an event win.
  assert.equal(bridge.state().answerChannel, OBSERVATION_CHANNEL.POLL)
  assert.equal(polls, 1)
})

test("bridge: an event channel that later goes silent is reported as event-then-poll", async () => {
  let clock = 0
  const bridge = createAdvisorEventBridge({
    eventChannel: true,
    eventSilenceMs: 1000,
    now: () => clock,
    baseline: { counts: { dataMessageRoleAssistant: 0 } },
    readObservation: async () => ({ counts: { dataMessageRoleAssistant: 1 }, answerText: '{"a":1}' }),
    parseAnswer: (text) => ({ ok: true, value: { text } }),
  })
  // One non-terminal delta arrives on the event channel.
  clock = 100
  bridge.onEvent(decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_DELTA, data: { text: '{"a":' }, workerEpoch: 1 }))
  // Then silence: poll picks it up.
  clock = 5000
  await bridge.pollOnce()
  assert.equal(bridge.state().answerChannel, OBSERVATION_CHANNEL.EVENT_THEN_POLL)
  assert.equal(bridge.state().eventsSeen, 1)
})

test("bridge: a recovered read failure does not end the bridge", async () => {
  let attempts = 0
  const bridge = createAdvisorEventBridge({
    eventChannel: false,
    maxPolls: 10,
    baseline: {},
    readObservation: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("transient read failure")
      return { counts: { dataMessageRoleAssistant: 1 }, answerText: '{"a":1}' }
    },
    parseAnswer: (text) => ({ ok: true, value: { text } }),
  })
  const first = await bridge.pollOnce()
  assert.equal(first.done, false, "one read failure is recoverable")
  const second = await bridge.pollOnce()
  assert.equal(second.done, true)
  assert.equal(bridge.state().answerChannel, OBSERVATION_CHANNEL.POLL)
})

test("bridge: a stale event after completion is refused", () => {
  const bridge = createAdvisorEventBridge({
    eventChannel: true,
    baseline: {},
    parseAnswer: () => ({ ok: true, value: {} }),
  })
  bridge.onEvent(stableEvent('{"a":1}'))
  const late = bridge.onEvent(stableEvent('{"b":2}'))
  assert.equal(late.handled, false)
  assert.equal(late.stale, true)
})

test("bridge: the policy id is stable", () => {
  assert.equal(ADVISOR_EVENT_BRIDGE_POLICY, "advisor-event-bridge-v16-11")
})
