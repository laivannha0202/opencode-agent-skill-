// V16.11 Browser Transport V2 tests.
//
// These prove the wire contract: version negotiation, capability advertisement,
// decode of V2 events and legacy V1 responses, redaction of text-bearing events,
// bounded coalescing, and fail-closed malformed handling. No browser involved.

import test from "node:test"
import assert from "node:assert/strict"

import {
  BROWSER_EVENT,
  BROWSER_TRANSPORT_FAILURE,
  BROWSER_TRANSPORT_V2_POLICY,
  BROWSER_TRANSPORT_V2_VERSION,
  canUseEventChannel,
  createCoalescingEventSink,
  createTransportCapabilities,
  decodeTransportMessage,
  encodeRequestV2,
  negotiateProtocol,
} from "../lib/browser-transport-v16-11.mjs"

test("transport: capability advertisement gates the event channel", () => {
  const withEvents = createTransportCapabilities({ protocolVersion: 2, eventChannel: true })
  assert.equal(withEvents.policy, BROWSER_TRANSPORT_V2_POLICY)
  assert.equal(canUseEventChannel(withEvents), true)
  assert.equal(withEvents.answerObserver, "mutation-observer")
  assert.ok(withEvents.events.includes(BROWSER_EVENT.ANSWER_STABLE))

  const pollingOnly = createTransportCapabilities({ protocolVersion: 2, eventChannel: false })
  assert.equal(canUseEventChannel(pollingOnly), false)
  assert.equal(pollingOnly.answerObserver, "poll")
  assert.equal(pollingOnly.pollingFallback, true)
})

test("transport: a V1 worker is usable through the polling fallback", () => {
  const negotiation = negotiateProtocol({ protocolVersion: 1 })
  assert.equal(negotiation.ok, true)
  assert.equal(negotiation.eventChannel, false)
  assert.equal(negotiation.reason, "v1-worker-polling-only")
})

test("transport: a V2 worker negotiates the event channel", () => {
  const negotiation = negotiateProtocol({ protocolVersion: 2, eventChannel: true })
  assert.equal(negotiation.ok, true)
  assert.equal(negotiation.eventChannel, true)
})

test("transport: an incompatible protocol version is refused, not guessed", () => {
  const negotiation = negotiateProtocol({ protocolVersion: 9 })
  assert.equal(negotiation.ok, false)
  assert.equal(negotiation.reason, BROWSER_TRANSPORT_FAILURE.PROTOCOL_MISMATCH)
})

test("transport: encodeRequestV2 produces a typed envelope with epochs", () => {
  const envelope = encodeRequestV2({ id: "req-1", method: "answer.read", params: { selector: "main" }, workerEpoch: 2, generation: 5 })
  assert.equal(envelope.type, "request")
  assert.equal(envelope.id, "req-1")
  assert.equal(envelope.method, "answer.read")
  assert.equal(envelope.workerEpoch, 2)
  assert.equal(envelope.generation, 5)
})

test("transport: decode an answer.stable event with its epoch", () => {
  const decoded = decodeTransportMessage({
    type: "event",
    event: BROWSER_EVENT.ANSWER_STABLE,
    data: { text: "final answer" },
    workerEpoch: 2,
    conversationId: "c1",
    conversationEpoch: 3,
    generation: 5,
  })
  assert.equal(decoded.ok, true)
  assert.equal(decoded.kind, "event")
  assert.equal(decoded.event, BROWSER_EVENT.ANSWER_STABLE)
  assert.equal(decoded.known, true)
  assert.equal(decoded.text, "final answer")
  assert.equal(decoded.workerEpoch, 2)
  assert.equal(decoded.conversationId, "c1")
  assert.equal(decoded.generation, 5)
})

test("transport: a legacy V1 response (no type) decodes as a response", () => {
  const decoded = decodeTransportMessage({ requestId: "req-7", operation: "answer.read", result: { text: "legacy" } })
  assert.equal(decoded.ok, true)
  assert.equal(decoded.kind, "response")
  assert.equal(decoded.id, "req-7")
  assert.equal(decoded.method, "answer.read")
  assert.equal(decoded.success, true)
  assert.equal(decoded.result.text, "legacy")
})

test("transport: an error response decodes with success=false", () => {
  const decoded = decodeTransportMessage({ type: "response", id: "r1", ok: false, error: "auth-expired" })
  assert.equal(decoded.success, false)
  assert.equal(decoded.error, "auth-expired")
})

test("transport: a text-bearing event is redacted", () => {
  const decoded = decodeTransportMessage({
    type: "event",
    event: BROWSER_EVENT.ANSWER_COMPLETED,
    data: { text: "token is sk-abcdef0123456789abcdef0123456789 end" },
  })
  assert.equal(decoded.redacted, true)
  assert.ok(decoded.redactionHits >= 1)
  assert.ok(!/sk-abcdef0123456789/.test(decoded.text))
})

test("transport: a malformed message fails closed without throwing", () => {
  const notJson = decodeTransportMessage("{ this is not json")
  assert.equal(notJson.ok, false)
  assert.equal(notJson.failure, BROWSER_TRANSPORT_FAILURE.MALFORMED)
  const unknown = decodeTransportMessage({ type: "quantum-entangle" })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.failure, BROWSER_TRANSPORT_FAILURE.UNKNOWN_TYPE)
})

test("transport: an unknown EVENT name is decoded but flagged unknown", () => {
  const decoded = decodeTransportMessage({ type: "event", event: "future.event", data: {} })
  assert.equal(decoded.ok, true)
  assert.equal(decoded.kind, "event")
  assert.equal(decoded.known, false)
})

test("transport: the coalescing sink keeps the latest delta and drops the flood", () => {
  let clock = 0
  const seen = []
  const sink = createCoalescingEventSink({ maxPerWindow: 3, windowMs: 1000, now: () => clock, onEvent: (e) => seen.push(e) })
  for (let i = 0; i < 10; i += 1) {
    sink.push(decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_DELTA, data: { text: `t${i}` } }))
  }
  const state = sink.state()
  assert.ok(state.coalesced >= 1, "a delta flood must be coalesced")
  // A terminal event flushes the latest delta and is delivered.
  sink.push(decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_STABLE, data: { text: "final" } }))
  const last = seen[seen.length - 1]
  assert.equal(last.event, BROWSER_EVENT.ANSWER_STABLE)
  // The flush before the terminal carries the LAST delta seen, not the first.
  const deltas = seen.filter((e) => e.event === BROWSER_EVENT.ANSWER_DELTA)
  assert.equal(deltas[deltas.length - 1].text, "t9")
})

test("transport: a terminal event is always delivered even inside a flood", () => {
  let clock = 0
  const seen = []
  const sink = createCoalescingEventSink({ maxPerWindow: 1, windowMs: 10_000, now: () => clock, onEvent: (e) => seen.push(e) })
  for (let i = 0; i < 20; i += 1) sink.push(decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_DELTA, data: { text: `t${i}` } }))
  sink.push(decodeTransportMessage({ type: "event", event: BROWSER_EVENT.AUTH_EXPIRED, data: {} }))
  assert.ok(seen.some((e) => e.event === BROWSER_EVENT.AUTH_EXPIRED), "auth.expired must never be coalesced away")
})
