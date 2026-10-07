// V16.11 Browser Transport V2: a duplex, event-capable wire contract.
//
// WHY THIS MODULE EXISTS
//
// V16.3's browser transport is request/response only. Every answer observation
// therefore has to be a POLL: Node asks the worker to read the answer region,
// waits, asks again. That is correct but it burns wall-clock and DOM reads, and
// it cannot be notified the moment the page changes.
//
// V16.11 adds an EVENT channel alongside the existing request/response messages.
// The worker may push events (`answer.delta`, `answer.stable`, `auth.expired`,
// `page.crashed`, ...) and Node consumes them. Polling stays as a bounded
// fallback, so an environment whose worker does not advertise the event channel
// behaves exactly as before.
//
// This module owns the PROTOCOL: message shapes, version negotiation, capability
// advertisement, ordering tolerance and redaction. It owns NO browser, NO DOM and
// NO lifecycle. The `browser-worker-client.mjs` binds it to a real subprocess; the
// lifecycle module owns the epochs an event is checked against.
//
// Three message kinds:
//   request  { type:"request",  id, method, params, workerEpoch, generation }
//   response { type:"response", id, result|error, workerEpoch, generation }
//   event    { type:"event",    event, data, workerEpoch, conversationId, generation }
//
// V1 messages (no `type`) are still accepted on decode so an old worker keeps
// working; V1 responses are normalized to the V2 `response` shape.

import { redactStructure } from "./secret-redaction.mjs"

export const BROWSER_TRANSPORT_V2_VERSION = 2
export const BROWSER_TRANSPORT_V2_POLICY = "browser-transport-v16-11"

// The event vocabulary the worker may emit. An event NOT in this set is ignored
// safely (an unknown harmless event must never fail a run), but it is reported
// so capability drift is observable.
export const BROWSER_EVENT = Object.freeze({
  WORKER_READY: "worker.ready",
  WORKER_HEALTH: "worker.health",
  PAGE_READY: "page.ready",
  AUTH_READY: "auth.ready",
  AUTH_EXPIRED: "auth.expired",
  AUTH_LOGIN_REQUIRED: "auth.login-required",
  CONVERSATION_OPENED: "conversation.opened",
  CONVERSATION_CHANGED: "conversation.changed",
  ANSWER_STARTED: "answer.started",
  ANSWER_DELTA: "answer.delta",
  ANSWER_STABLE: "answer.stable",
  ANSWER_COMPLETED: "answer.completed",
  ANSWER_ERROR: "answer.error",
  NAVIGATION_REDIRECT: "navigation.redirect",
  PAGE_CRASHED: "page.crashed",
  BROWSER_DISCONNECTED: "browser.disconnected",
  WORKER_EXITED: "worker.exited",
})

const KNOWN_EVENTS = new Set(Object.values(BROWSER_EVENT))

// Events that carry page text and must be bounded/redacted exactly like an answer.
const TEXT_BEARING_EVENTS = new Set([
  BROWSER_EVENT.ANSWER_DELTA,
  BROWSER_EVENT.ANSWER_STABLE,
  BROWSER_EVENT.ANSWER_COMPLETED,
])

export const BROWSER_TRANSPORT_FAILURE = Object.freeze({
  PROTOCOL_MISMATCH: "browser-transport-protocol-mismatch",
  MALFORMED: "browser-transport-malformed-message",
  UNKNOWN_TYPE: "browser-transport-unknown-type",
  NO_EVENT_CHANNEL: "browser-transport-no-event-channel",
})

const MAX_EVENT_TEXT_CHARS = 40_000
const MAX_PARAM_CHARS = 200_000

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeId(value) {
  const raw = value === undefined || value === null ? "" : String(value)
  return raw.slice(0, 200)
}

function epochOf(value) {
  if (value === undefined || value === null) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return Math.max(0, Math.trunc(parsed))
}

/**
 * The capability descriptor a worker advertises in response to `capability`.
 *
 * A worker that does NOT advertise `eventChannel: true` is driven by the polling
 * fallback only. This is how the event path is negotiated, never assumed.
 */
export function createTransportCapabilities(input = {}) {
  const protocolVersion = boundedInt(input.protocolVersion, BROWSER_TRANSPORT_V2_VERSION, 1, 99)
  const eventChannel = input.eventChannel === true
  return Object.freeze({
    schemaVersion: 1,
    policy: BROWSER_TRANSPORT_V2_POLICY,
    protocolVersion,
    // The wire protocol this transport speaks. A worker reporting a different
    // MAJOR version is refused rather than driven with a partially-compatible
    // event schema.
    eventChannel,
    answerObserver: eventChannel ? String(input.answerObserver || "mutation-observer").slice(0, 60) : "poll",
    pollingFallback: input.pollingFallback !== false,
    supportsCancellation: input.supportsCancellation === true,
    // `reportsProviderTokens` is almost always false for the DeepSeek web UI.
    // Keeping it explicit is what lets Metrics record `NOT_MEASURED` honestly.
    reportsProviderTokens: input.reportsProviderTokens === true,
    events: Array.isArray(input.events)
      ? input.events.filter((name) => KNOWN_EVENTS.has(String(name))).slice(0, 40)
      : (eventChannel ? [...KNOWN_EVENTS] : []),
  })
}

/** Whether a worker's advertised capabilities allow the event-first path. */
export function canUseEventChannel(capabilities = {}) {
  return capabilities.eventChannel === true
    && Number(capabilities.protocolVersion || 0) === BROWSER_TRANSPORT_V2_VERSION
}

/** Negotiate: compare a worker's advertised protocol version to this transport's. */
export function negotiateProtocol(workerCapabilities = {}) {
  const workerVersion = boundedInt(workerCapabilities.protocolVersion, 1, 1, 99)
  if (workerVersion === BROWSER_TRANSPORT_V2_VERSION) {
    return { ok: true, version: workerVersion, eventChannel: canUseEventChannel(workerCapabilities), reason: null }
  }
  if (workerVersion === 1) {
    // An old V1 worker is fully usable through the polling fallback.
    return { ok: true, version: 1, eventChannel: false, reason: "v1-worker-polling-only" }
  }
  return { ok: false, version: workerVersion, eventChannel: false, reason: BROWSER_TRANSPORT_FAILURE.PROTOCOL_MISMATCH }
}

/** Encode a V2 request envelope from a V1-style request object. */
export function encodeRequestV2(request = {}) {
  return {
    type: "request",
    id: normalizeId(request.id || request.requestId),
    method: String(request.method || request.operation || "").slice(0, 80),
    params: request.params && typeof request.params === "object" ? request.params : {},
    workerEpoch: epochOf(request.workerEpoch),
    generation: epochOf(request.generation),
  }
}

/**
 * Decode ANY inbound message -- V2 request/response/event or a legacy V1
 * response -- into a normalized envelope. Never throws; a malformed message is a
 * value (`{ ok: false, failure }`) so a caller can fail closed without a crash.
 */
export function decodeTransportMessage(message = {}) {
  const raw = typeof message === "string" ? safeJson(message) : message
  if (!raw || typeof raw !== "object") {
    return { ok: false, failure: BROWSER_TRANSPORT_FAILURE.MALFORMED, raw: String(message ?? "").slice(0, 400) }
  }
  const type = raw.type === undefined || raw.type === null ? null : String(raw.type)
  if (type === "event") return decodeEvent(raw)
  if (type === "request") return decodeRequest(raw)
  if (type === "response") return decodeResponse(raw)
  // Legacy V1: no `type`. Treat a message carrying `requestId` as a response.
  if (type === null && (raw.requestId !== undefined || raw.operation !== undefined)) {
    return decodeResponse({ ...raw, type: "response" })
  }
  return { ok: false, failure: BROWSER_TRANSPORT_FAILURE.UNKNOWN_TYPE, type }
}

function decodeRequest(raw = {}) {
  return {
    ok: true,
    kind: "request",
    id: normalizeId(raw.id || raw.requestId),
    method: String(raw.method || raw.operation || "").slice(0, 80),
    params: raw.params && typeof raw.params === "object" ? boundParams(raw.params) : {},
    workerEpoch: epochOf(raw.workerEpoch),
    generation: epochOf(raw.generation),
  }
}

function decodeResponse(raw = {}) {
  const isError = raw.ok === false || (raw.error !== undefined && raw.ok !== true) || (raw.failure !== undefined && raw.ok !== true)
  const scrubbed = redactStructure(raw.result ?? raw.payload ?? null, { maxDepth: 6, maxKeys: 600 })
  return {
    ok: true,
    kind: "response",
    id: normalizeId(raw.id || raw.requestId),
    method: String(raw.method || raw.operation || "").slice(0, 80),
    success: !isError,
    result: scrubbed.value || {},
    error: isError ? String(raw.error || raw.failure || "provider-error").slice(0, 200) : null,
    workerEpoch: epochOf(raw.workerEpoch),
    generation: epochOf(raw.generation),
    redacted: scrubbed.redacted,
    redactionHits: scrubbed.hits,
  }
}

function decodeEvent(raw = {}) {
  const name = String(raw.event || raw.name || "")
  const data = raw.data && typeof raw.data === "object" ? raw.data : {}
  const scrubbed = redactStructure(data, { maxDepth: 5, maxKeys: 200 })
  const safeData = scrubbed.value || {}
  // A text-bearing event carries a bounded text field, redacted and truncated.
  const text = TEXT_BEARING_EVENTS.has(name) && typeof safeData.text === "string"
    ? safeData.text.slice(0, MAX_EVENT_TEXT_CHARS)
    : null
  return {
    ok: true,
    kind: "event",
    event: name,
    known: KNOWN_EVENTS.has(name),
    data: {
      ...safeData,
      ...(text !== null ? { text } : {}),
    },
    text,
    textChars: text ? text.length : (Number(safeData.textChars) || 0),
    workerEpoch: epochOf(raw.workerEpoch),
    profileEpoch: epochOf(raw.profileEpoch),
    conversationId: normalizeId(raw.conversationId) || null,
    conversationEpoch: epochOf(raw.conversationEpoch),
    requestId: normalizeId(raw.requestId) || null,
    generation: epochOf(raw.generation),
    redacted: scrubbed.redacted,
    redactionHits: scrubbed.hits,
  }
}

function boundParams(params = {}) {
  const out = {}
  for (const [key, value] of Object.entries(params).slice(0, 40)) {
    if (typeof value === "string") out[key] = value.slice(0, MAX_PARAM_CHARS)
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value
    else if (Array.isArray(value)) out[key] = value.slice(0, 50)
    else if (value && typeof value === "object") out[key] = value
  }
  return out
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * A bounded, coalescing event sink.
 *
 * The directive forbids streaming every DOM character mutation to Node. This sink
 * keeps only the LATEST delta text (coalescing intermediate deltas) and counts
 * what it dropped, so a flood cannot grow Node memory. `answer.stable` /
 * `answer.completed` are always delivered because they are terminal.
 *
 * It owns NO lifecycle: it simply forwards normalized events to a listener and
 * reports coalescing statistics.
 */
export function createCoalescingEventSink(options = {}) {
  const maxPerWindow = boundedInt(options.maxPerWindow, 8, 1, 200)
  const windowMs = boundedInt(options.windowMs, 250, 0, 10_000)
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const listener = typeof options.onEvent === "function" ? options.onEvent : () => null
  let windowStart = now()
  let inWindow = 0
  let coalesced = 0
  let delivered = 0
  let lastDelta = null

  function push(decodedEvent) {
    if (!decodedEvent || decodedEvent.kind !== "event") return { delivered: false, coalesced: false }
    const terminal = decodedEvent.event === BROWSER_EVENT.ANSWER_STABLE
      || decodedEvent.event === BROWSER_EVENT.ANSWER_COMPLETED
      || decodedEvent.event === BROWSER_EVENT.ANSWER_ERROR
      || decodedEvent.event === BROWSER_EVENT.PAGE_CRASHED
      || decodedEvent.event === BROWSER_EVENT.WORKER_EXITED
      || decodedEvent.event === BROWSER_EVENT.AUTH_EXPIRED
    const at = now()
    if (at - windowStart >= windowMs) {
      windowStart = at
      inWindow = 0
    }
    if (decodedEvent.event === BROWSER_EVENT.ANSWER_DELTA) {
      // Keep only the latest delta in a window; a terminal event flushes it.
      lastDelta = decodedEvent
      inWindow += 1
      if (inWindow > maxPerWindow && !terminal) {
        coalesced += 1
        return { delivered: false, coalesced: true }
      }
    }
    if (terminal && lastDelta) {
      // Flush the most recent delta before the terminal event so the final text
      // is reconstructable, then clear it.
      delivered += 1
      try { listener(lastDelta) } catch { /* listener failure must not break the sink */ }
      lastDelta = null
    }
    delivered += 1
    try { listener(decodedEvent) } catch { /* ignore */ }
    return { delivered: true, coalesced: false }
  }

  return {
    policy: BROWSER_TRANSPORT_V2_POLICY,
    push,
    /** Drain a pending coalesced delta (e.g. on a bounded poll tick). */
    flush() {
      if (!lastDelta) return false
      delivered += 1
      try { listener(lastDelta) } catch { /* ignore */ }
      lastDelta = null
      return true
    },
    state() {
      return { delivered, coalesced, pendingDelta: lastDelta !== null, windowMs, maxPerWindow }
    },
  }
}

export const browserTransportV2Exports = Object.freeze({
  BROWSER_TRANSPORT_V2_VERSION,
  BROWSER_TRANSPORT_V2_POLICY,
  BROWSER_EVENT,
  BROWSER_TRANSPORT_FAILURE,
  createTransportCapabilities,
  canUseEventChannel,
  negotiateProtocol,
  encodeRequestV2,
  decodeTransportMessage,
  createCoalescingEventSink,
})
