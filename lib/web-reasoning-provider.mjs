// V16.3 Phase B, step 8: the generic web-reasoning provider interface.
//
// DeepSeek Web is the only provider V16.3 ships, and this file is the reason
// that is a choice rather than a coupling. Nothing above this interface mentions
// DeepSeek, a URL, or a DOM selector; the escalation controller, the Decision Packet builder and the response parser all speak only to these five methods:
//
//   capability()        -> what this provider can do right now
//   startSession()      -> a bounded, reusable session (or a refusal)
//   consult(packet)     -> structured advice, or a failure with a reason
//   followUp(delta)     -> revised advice in the SAME session
//   closeSession()      -> release everything, always
//
// Two rules are enforced here rather than trusted to providers:
//
//   1. A provider is a CONSULTANT. `authority` is fixed at construction and
//      cannot be raised by the provider object, so no adapter can return itself
//      as a verification authority.
//   2. Every answer is untrusted external data. `normalizeAdvice` is the only way
//      advice enters the system and it always stamps the trust contract.

import { createHash } from "node:crypto"
import { externalTrustContract } from "./browser-security.mjs"
import { redactStructure } from "./secret-redaction.mjs"
import { WEB_REASONING_BOUNDS } from "./deepseek-turn-policy-v16-6.mjs"

export const WEB_REASONING_PROVIDER_IDS = Object.freeze({
  DEEPSEEK_WEB: "deepseek-web",
  CHATGPT_WEB: "chatgpt-web",
  GEMINI_WEB: "gemini-web",
})

export const WEB_REASONING_AUTHORITY = Object.freeze({
  CONSULTANT: "consultant-only",
})

// Provider capability states. `needs-auth` is a first-class state, not an
// error: the answer to "can you answer?" is "not until a human logs in", and
// retrying through it forever is the failure mode this enum exists to prevent.
export const WEB_REASONING_CAPABILITY = Object.freeze({
  READY: "ready",
  NEEDS_AUTH: "needs-auth",
  UNAVAILABLE: "unavailable",
  DEGRADED: "degraded",
  // V16.6.1: the explicit non-ready states an adapter may report. They are not
  // collapsed into `degraded`/`unavailable` because the operator action differs:
  // `logged-out` needs a human, `ui-changed` needs a selector review, `timeout`
  // may be retried, `closed` needs a new session.
  LOGGED_OUT: "logged-out",
  UI_CHANGED: "ui-changed",
  TIMEOUT: "timeout",
  CLOSED: "closed",
  UNKNOWN: "unknown",
})

const CAPABILITY_STATE_ALIASES = Object.freeze({
  ready: WEB_REASONING_CAPABILITY.READY,
  needs_auth: WEB_REASONING_CAPABILITY.NEEDS_AUTH,
  requires_auth: WEB_REASONING_CAPABILITY.NEEDS_AUTH,
  auth_required: WEB_REASONING_CAPABILITY.NEEDS_AUTH,
  unavailable: WEB_REASONING_CAPABILITY.UNAVAILABLE,
  degraded: WEB_REASONING_CAPABILITY.DEGRADED,
  logged_out: WEB_REASONING_CAPABILITY.LOGGED_OUT,
  ui_changed: WEB_REASONING_CAPABILITY.UI_CHANGED,
  selector_drift: WEB_REASONING_CAPABILITY.UI_CHANGED,
  timeout: WEB_REASONING_CAPABILITY.TIMEOUT,
  closed: WEB_REASONING_CAPABILITY.CLOSED,
  session_lost: WEB_REASONING_CAPABILITY.CLOSED,
  unknown: WEB_REASONING_CAPABILITY.UNKNOWN,
})

/**
 * Normalize an adapter-reported capability state.
 *
 * V16.6.1 fail-closed rule: ONLY an explicit, recognized READY observation is
 * READY. A missing state, an unrecognized word, a null or a non-string used to
 * fall through `String(raw?.state || READY)` and become READY, which let a
 * provider that never reported anything be treated as authenticated.
 */
export function normalizeCapabilityState(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { state: WEB_REASONING_CAPABILITY.UNKNOWN, recognized: false, failClosed: true }
  }
  const text = String(raw).trim().toLowerCase()
  const key = text.replace(/[\s-]+/g, "_")
  const state = CAPABILITY_STATE_ALIASES[key]
  if (state) return { state, recognized: true, failClosed: state !== WEB_REASONING_CAPABILITY.READY }
  return { state: WEB_REASONING_CAPABILITY.UNAVAILABLE, recognized: false, failClosed: true }
}

/** A state that may start/keep a conversation. Everything else may not. */
export function isUsableCapabilityState(state) {
  return state === WEB_REASONING_CAPABILITY.READY
}

export const WEB_REASONING_METHODS = Object.freeze([
  "capability",
  "startSession",
  "consult",
  "followUp",
  "closeSession",
])

export const WEB_REASONING_UNAVAILABLE = "WEB_REASONING_UNAVAILABLE"

export class WebReasoningError extends Error {
  constructor(reason, message = reason, details = {}) {
    super(message)
    this.name = "WebReasoningError"
    this.code = reason === "unavailable" ? WEB_REASONING_UNAVAILABLE : reason
    this.reason = reason
    Object.assign(this, details)
  }
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

// Adapters signal failure by returning `{ ok: false, failure: "<code>" }` or by
// throwing with a code in the message. The wrapper normalises both into a
// WebReasoningError carrying a real `reason`, so the controller can count
// "deepseek-response-timeout" as a timeout instead of an anonymous
// "provider-error" that matches nothing. The code list is declared BY the
// adapter, which keeps this module free of any provider-specific knowledge.
function normalizeProviderError(error, id, failureCodes) {
  if (error instanceof WebReasoningError) return error
  const message = String(error?.message || error || "")
  const codes = Array.isArray(failureCodes) ? failureCodes : []
  const matched = codes.find((code) => message.includes(code))
  return new WebReasoningError(matched || "provider-error", message || `${id} provider error`, {
    cause: error,
    provider: id,
  })
}

// An adapter reports a failure by RETURNING `{ ok: false, failure: "<code>" }`
// rather than throwing. Left alone, that envelope flowed into the advice
// normaliser, got JSON-stringified, and came out of the response parser as
// `schema-invalid` -- a real timeout wearing the costume of a malformed answer.
// So the failure envelope is converted to the same WebReasoningError a thrown
// error produces, and the two paths are indistinguishable downstream.
function throwIfFailed(advice, id) {
  const failure = advice && typeof advice === "object" ? advice.failure : null
  const explicit = advice && typeof advice === "object" && advice.ok === false
  if (!failure && !explicit) return advice
  throw new WebReasoningError(
    String(failure || "provider-error"),
    String(advice?.reason || advice?.message || `${id} provider reported a failure`),
    { provider: id, details: advice?.details ?? null },
  )
}

/**
 * Wrap a provider adapter so the consultant-only and untrusted-external
 * contracts cannot be bypassed by the adapter itself.
 */
export function defineWebReasoningProvider(adapter = {}) {
  const id = String(adapter.id || "").trim()
  if (!id) throw new WebReasoningError("invalid-provider", "web reasoning provider requires an id")
  for (const method of WEB_REASONING_METHODS) {
    if (typeof adapter[method] !== "function") {
      throw new WebReasoningError("invalid-provider", `web reasoning provider ${id} is missing ${method}()`)
    }
  }

  const maxSessionMs = boundedInt(adapter.maxSessionMs, 300_000, 5_000, 3_600_000)
  // V16.6.1: the generic wrapper still supports a broad technical ceiling, but
  // its DEFAULT is the canonical production bound, so a caller that passes
  // nothing can never end up with 4 (or 16) follow-ups by accident.
  const maxFollowUps = boundedInt(adapter.maxFollowUps, WEB_REASONING_BOUNDS.maxFollowUps, 0, 16)
  const failureCodes = Object.freeze([...(adapter.failureCodes || [])].map(String))

  const provider = {
    id,
    // Fixed at construction. An adapter cannot widen it; there is no setter.
    authority: WEB_REASONING_AUTHORITY.CONSULTANT,
    maxSessionMs,
    maxFollowUps,
    failureCodes,
    isConsultantOnly: true,
    trust: externalTrustContract("web-reasoning-response"),
    options: adapter.options || {},

    // V16.7.1: capability options (notably AbortSignal) are part of the
    // production cancellation path. The wrapper must forward them rather than
    // silently dropping them before they reach the browser adapter.
    async capability(options = {}) {
      try {
        const raw = await adapter.capability(options)
        // Fail-closed: only an explicit recognized READY becomes READY.
        const normalized = normalizeCapabilityState(raw?.state)
        return {
          schemaVersion: 1,
          provider: id,
          state: normalized.state,
          stateRecognized: normalized.recognized,
          failClosed: normalized.failClosed,
          reason: raw?.reason || (normalized.recognized ? null : `capability-state-unrecognized:${String(raw?.state ?? "missing")}`),
          sessionReusable: normalized.state === WEB_REASONING_CAPABILITY.READY && raw?.sessionReusable === true,
          supportsFollowUp: normalized.state === WEB_REASONING_CAPABILITY.READY && raw?.supportsFollowUp !== false,
          maxPacketChars: normalized.state === WEB_REASONING_CAPABILITY.READY
            ? boundedInt(raw?.maxPacketChars, 60_000, 1_000, 2_000_000)
            : 0,
          latencyHintMs: Number.isFinite(Number(raw?.latencyHintMs)) ? Number(raw.latencyHintMs) : null,
          trustLevel: "untrusted-external",
        }
      } catch (error) {
        return {
          schemaVersion: 1,
          provider: id,
          state: WEB_REASONING_CAPABILITY.UNAVAILABLE,
          reason: `capability-probe-failed:${error?.message || error}`.slice(0, 200),
          sessionReusable: false,
          supportsFollowUp: false,
          maxPacketChars: 60_000,
          latencyHintMs: null,
          trustLevel: "untrusted-external",
        }
      }
    },

    async startSession(input = {}) {
      const startedAt = Date.now()
      const session = await adapter.startSession(input)
      if (!session) {
        throw new WebReasoningError("no-session", `web reasoning provider ${id} returned no session`)
      }
      // V16.6.1 fail-closed: a session is usable only when the adapter reports
      // an explicit READY. `logged-out`, `ui-changed`, `timeout`, `closed`,
      // `unknown`, a malformed value or a MISSING value all stop here instead
      // of being reported as a live conversation.
      const normalized = normalizeCapabilityState(session.state)
      if (normalized.state !== WEB_REASONING_CAPABILITY.READY) {
        throw new WebReasoningError(
          normalized.state === WEB_REASONING_CAPABILITY.NEEDS_AUTH ? "needs-auth" : `session-${normalized.state}`,
          `web reasoning provider ${id} session is not usable: ${normalized.state}`,
          {
            provider: id,
            state: normalized.state,
            failClosed: true,
            reason: session.reason || null,
            sessionId: session.sessionId ? String(session.sessionId) : null,
          },
        )
      }
      return {
        schemaVersion: 1,
        provider: id,
        sessionId: String(session.sessionId || `${id}-${startedAt.toString(36)}`),
        startedAt,
        reused: session.reused === true,
        state: WEB_REASONING_CAPABILITY.READY,
        reason: session.reason || null,
        maxFollowUps,
        _adapterSession: session,
        trustLevel: "untrusted-external",
      }
    },

    async consult(session, packet, options = {}) {
      assertConsult(session)
      const startedAt = Date.now()
      let advice
      try {
        advice = await adapter.consult(session._adapterSession, packet, options)
        throwIfFailed(advice, id)
      } catch (error) {
        throw normalizeProviderError(error, id, failureCodes)
      }
      return normalizeAdvice(advice, {
        provider: id,
        sessionId: session.sessionId,
        kind: options.kind || "consult",
        durationMs: Date.now() - startedAt,
        followUpIndex: session.followUps || 0,
        requestId: options.requestId || null,
      })
    },

    async followUp(session, delta, options = {}) {
      assertConsult(session)
      const used = Number(session.followUps || 0)
      if (used >= maxFollowUps) {
        throw new WebReasoningError("follow-up-budget-exhausted", `${id} follow-up budget exhausted`)
      }
      const startedAt = Date.now()
      session.followUps = used + 1
      let advice
      try {
        advice = await adapter.followUp(session._adapterSession, delta, options)
        throwIfFailed(advice, id)
      } catch (error) {
        throw normalizeProviderError(error, id, failureCodes)
      }
      return normalizeAdvice(advice, {
        provider: id,
        sessionId: session.sessionId,
        kind: "follow-up",
        durationMs: Date.now() - startedAt,
        followUpIndex: session.followUps,
        requestId: options.requestId || null,
      })
    },

    async closeSession(session) {
      if (!session) return { closed: false, reason: "no-session" }
      let closed = false
      try {
        closed = await adapter.closeSession(session._adapterSession) !== false
      } catch {
        // Cleanup failures must not mask the result that produced them.
        closed = false
      }
      return { closed, provider: id, sessionId: session.sessionId }
    },

    // Escape hatch for the deterministic test double and for adapter internals.
    _adapter: adapter,
  }
  return Object.freeze(provider)
}

function assertConsult(session) {
  if (!session || session._adapterSession === undefined) {
    throw new WebReasoningError("no-session", "web reasoning session is not started")
  }
}

// The ONLY entry point for provider output into the system. Whatever the adapter
// hands back is (a) structurally validated upstream by the response parser,
// (b) redacted, (c) hashed for audit, and (d) stamped untrusted-external.
export function normalizeAdvice(advice, context = {}) {
  // The exact provider text is preserved as `rawText` before any shaping, so
  // the response parser sees the model's own words rather than a re-serialised
  // envelope. Without this the controller would parse `{answer: "..."}` as if
  // the object itself were the advice schema.
  const rawText = typeof advice === "string"
    ? advice
    : typeof advice?.answer === "string"
      ? advice.answer
      : typeof advice?.answerText === "string"
        ? advice.answerText
        : JSON.stringify(advice ?? "", null, 0)
  const scrubbed = redactStructure(advice ?? null, { maxDepth: 8, maxKeys: 800 })
  return {
    schemaVersion: 1,
    kind: "ues-web-reasoning-advice",
    provider: context.provider || null,
    sessionId: context.sessionId || null,
    consultKind: context.kind || "consult",
    followUpIndex: Number(context.followUpIndex || 0),
    latencyMs: Number(context.durationMs || 0),
    advice: scrubbed.value,
    rawText,
    rawSha256: createHash("sha256").update(rawText).digest("hex").slice(0, 32),
    rawChars: rawText.length,
    authority: WEB_REASONING_AUTHORITY.CONSULTANT,
    // Explicit, machine-checkable negatives. A downstream consumer that only
    // reads these fields still cannot mistake advice for a verdict.
    mayAuthorizeSideEffects: false,
    mayGrantPermissions: false,
    mayProduceVerificationVerdict: false,
    mayRequestSecrets: false,
    trustLevel: "untrusted-external",
    ...externalTrustContract("web-reasoning-response"),
  }
}

// Registry is a map, not a switch. Adding `chatgpt-web` later is a registration
// line, not a controller edit, and a missing provider fails closed here rather
// than deep inside a consultation.
export function createWebReasoningRegistry(adapters = []) {
  /** @type {Map<string, any>} */
  const providers = new Map()
  for (const adapter of Array.isArray(adapters) ? adapters : []) {
    const provider = defineWebReasoningProvider(adapter)
    providers.set(provider.id, provider)
  }
  return {
    ids: () => [...providers.keys()].sort(),
    has: (id) => providers.has(String(id || "")),
    get: (id) => providers.get(String(id || "")) || null,
    register(adapter) {
      const provider = defineWebReasoningProvider(adapter)
      providers.set(provider.id, provider)
      return provider
    },
    defaultId: WEB_REASONING_PROVIDER_IDS.DEEPSEEK_WEB,
    resolve(id) {
      const wanted = String(id || this.defaultId)
      return this.get(wanted) || this.get(this.defaultId) || null
    },
  }
}
