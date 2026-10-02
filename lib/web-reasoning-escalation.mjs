// V16.3 Phase B, steps 12, 17, 20, 21, 22 and 23: the escalation router and
// the consultation controller.
//
// The controller is the only component allowed to say "ask DeepSeek". It has to
// answer four questions, in this order:
//
//   1. SHOULD we?     (mode + complexity/uncertainty signals)   -> escalate?
//   2. CAN we?        (provider capability)                     -> consult | fall back
//   3. WHAT do we send?(Decision Packet, budgeted + cached)     -> packet | delta
//   4. WHAT happens next?(local verification, then bounded retry) -> accept | reject
//
// The failure posture is the load-bearing part. DeepSeek must never become a
// single point of failure, and it must never become an authority:
//
//   - AUTO  : any failure falls back to local execution, and says so.
//   - FORCE : any failure is `WEB_REASONING_UNAVAILABLE`, explicitly. It is
//             never silently downgraded to a local run, because a caller that
//             asked for a consultation and silently got none has been lied to.
//   - OFF   : no provider is probed at all.

import {
  buildDecisionPacket,
  buildFollowUpDelta,
  estimatePacketChars,
} from "./decision-packet.mjs"
import { parseDeepSeekResponse, verifyLocalAdvice } from "./deepseek-response.mjs"
import {
  WEB_REASONING_CAPABILITY,
  WEB_REASONING_UNAVAILABLE,
  createWebReasoningRegistry,
} from "./web-reasoning-provider.mjs"

export const WEB_ESCALATION_MODE = Object.freeze({
  OFF: "off",
  AUTO: "auto",
  FORCE: "force",
})

export const WEB_ESCALATION_REASON = Object.freeze({
  MODE_OFF: "web-reasoning-disabled",
  MODE_FORCE: "web-reasoning-forced",
  SIGNAL: "escalation-signal-present",
  NO_SIGNAL: "task-already-well-grounded",
})

// Signals that make an external second opinion worth its cost. Each is a
// POSITIVE trigger; the absence of all of them means Pi keeps the work.
export const ESCALATION_SIGNAL = Object.freeze({
  MULTI_SUBSYSTEM: "multi-subsystem-task",
  ARCHITECTURAL_UNCERTAINTY: "architectural-uncertainty",
  AMBIGUOUS_ROOT_CAUSE: "ambiguous-root-cause",
  VERIFIER_REPEATED_FAILURE: "verifier-repeated-failure",
  SEVERAL_PLAUSIBLE_FIXES: "several-plausible-fixes",
  LOW_CONFIDENCE: "low-local-confidence",
  LONG_HORIZON_SECOND_OPINION: "long-horizon-reasoning-second-opinion",
  BOUNDED_RECOVERY_EXHAUSTED: "local-bounded-recovery-exhausted",
})

// The inverse list exists because the cost of a needless consultation is real:
// latency, tokens, a browser session and an external dependency on a task that
// a local read would have closed. These are stated explicitly so the skip
// decision is auditable rather than implicit.
export const NON_ESCALATION_SIGNAL = Object.freeze({
  VERSION_BUMP: "version-bump",
  DOC_EDIT: "readme-or-doc-edit",
  TRIVIAL_ONE_FILE: "trivial-one-file-deterministic-fix",
  SYNTAX_ONLY: "simple-syntax-issue",
  ALREADY_GROUNDED: "already-grounded-low-risk-task",
})

const ESCALATION_PATTERNS = [
  [/(multi[- ]?(?:subsystem|module|package|cross[- ]cutting)|cross[- ]layer|end[- ]to[- ]end refactor)/i, ESCALATION_SIGNAL.MULTI_SUBSYSTEM],
  [/(architect(?:ure|ural)|design decision|how should (?:we|i) (?:structure|split|design)|trade[- ]?off)/i, ESCALATION_SIGNAL.ARCHITECTURAL_UNCERTAINTY],
  [/(root cause|ambiguous|unclear why|conflicting symptoms|multiple (?:possible )?causes|not sure (?:why|which))/i, ESCALATION_SIGNAL.AMBIGUOUS_ROOT_CAUSE],
  [/(verifier (?:still )?fail|test (?:still )?fail|repeated failure|keeps failing|flaky)/i, ESCALATION_SIGNAL.VERIFIER_REPEATED_FAILURE],
  [/(several (?:possible )?fix(?:es)?|more than one way|either (?:approach|fix)|alternative approach)/i, ESCALATION_SIGNAL.SEVERAL_PLAUSIBLE_FIXES],
  [/(low confidence|not confident|uncertain about|second opinion)/i, ESCALATION_SIGNAL.LOW_CONFIDENCE],
  [/(long[- ]horizon|multi[- ]step plan|over many (?:steps|turns)|end[- ]to[- ]end)/i, ESCALATION_SIGNAL.LONG_HORIZON_SECOND_OPINION],
  [/(bounded recovery (?:exhausted|failed)|already tried|recovery did not)/i, ESCALATION_SIGNAL.BOUNDED_RECOVERY_EXHAUSTED],
]

const NON_ESCALATION_PATTERNS = [
  [/^\s*(?:bump|increase|update)\s+(?:the\s+)?(?:package\s+)?version\b/i, NON_ESCALATION_SIGNAL.VERSION_BUMP],
  [/^\s*(?:update|edit|fix|rewrite|translate)\s+(?:the\s+)?(?:readme|changelog|docs?\b|typos?)/i, NON_ESCALATION_SIGNAL.DOC_EDIT],
  [/\b(?:rename a (?:variable|constant)|add a (?:missing )?(?:import|export)|typo\b|syntax error|missing semicolon|trailing comma)\b/i, NON_ESCALATION_SIGNAL.SYNTAX_ONLY],
]

/**
 * Decide whether to escalate. Deterministic, synchronous, and it reports the
 * signals it used in BOTH directions so a skip is as auditable as a consult.
 */
export function decideWebEscalation(input = {}) {
  const mode = String(input.mode || WEB_ESCALATION_MODE.AUTO)
  if (mode === WEB_ESCALATION_MODE.OFF) {
    return { escalate: false, mode, reason: WEB_ESCALATION_REASON.MODE_OFF, signals: [], nonEscalationSignals: [] }
  }

  const text = `${input.task || ""}\n${(input.notes || []).join("\n")}`.trim()
  const explicit = Array.isArray(input.signals) ? input.signals.map(String) : []
  const detected = explicit.slice()
  for (const [pattern, signal] of ESCALATION_PATTERNS) {
    if (pattern.test(text)) detected.push(signal)
  }
  for (const [pattern, signal] of ESCALATION_PATTERNS) {
    if (input[signal] === true) detected.push(signal)
  }
  if (Number(input.verifierRetries || 0) >= 2) detected.push(ESCALATION_SIGNAL.VERIFIER_REPEATED_FAILURE)
  if (Number(input.localConfidence ?? 1) < 0.5) detected.push(ESCALATION_SIGNAL.LOW_CONFIDENCE)
  if (Number(input.affectedSubsystems || 0) >= 3) detected.push(ESCALATION_SIGNAL.MULTI_SUBSYSTEM)

  const nonEscalation = []
  for (const [pattern, signal] of NON_ESCALATION_PATTERNS) {
    if (pattern.test(text)) nonEscalation.push(signal)
  }

  const uniqueSignals = [...new Set(detected)]
  if (mode === WEB_ESCALATION_MODE.FORCE) {
    return {
      escalate: true,
      mode,
      reason: WEB_ESCALATION_REASON.MODE_FORCE,
      signals: uniqueSignals,
      nonEscalationSignals: nonEscalation,
      // FORCE is a caller instruction, not a hint. Non-escalation signals are
      // reported but never veto it.
      forcedOverNonEscalation: nonEscalation.length > 0,
    }
  }

  // AUTO. An explicit "already grounded / trivial" signal vetoes, because a
  // caller that has already grounded the task is stating a fact about it.
  const hardSkip = nonEscalation.some((signal) =>
    signal === NON_ESCALATION_SIGNAL.ALREADY_GROUNDED ||
    signal === NON_ESCALATION_SIGNAL.VERSION_BUMP ||
    signal === NON_ESCALATION_SIGNAL.DOC_EDIT)
  if (hardSkip) {
    return {
      escalate: false,
      mode,
      reason: WEB_ESCALATION_REASON.NO_SIGNAL,
      signals: uniqueSignals,
      nonEscalationSignals: nonEscalation,
    }
  }

  if (!uniqueSignals.length) {
    return {
      escalate: false,
      mode,
      reason: WEB_ESCALATION_REASON.NO_SIGNAL,
      signals: [],
      nonEscalationSignals: nonEscalation,
    }
  }
  return {
    escalate: true,
    mode,
    reason: WEB_ESCALATION_REASON.SIGNAL,
    signals: uniqueSignals,
    nonEscalationSignals: nonEscalation,
  }
}

export function createWebReasoningTelemetry() {
  const counters = Object.create(null)
  const bump = (name, amount = 1) => {
    counters[name] = Number(counters[name] || 0) + Number(amount || 0)
  }
  return {
    bump,
    snapshot() {
      return {
        schemaVersion: 1,
        kind: "ues-web-reasoning-telemetry",
        webReasoningCalls: Number(counters.webReasoningCalls || 0),
        webReasoningEscalations: Number(counters.webReasoningEscalations || 0),
        webReasoningSkipped: Number(counters.webReasoningSkipped || 0),
        webReasoningFallbacks: Number(counters.webReasoningFallbacks || 0),
        decisionPacketChars: Number(counters.decisionPacketChars || 0),
        decisionPacketFiles: Number(counters.decisionPacketFiles || 0),
        decisionPacketCacheHits: Number(counters.decisionPacketCacheHits || 0),
        followUpDeltaChars: Number(counters.followUpDeltaChars || 0),
        webLatencyMs: Number(counters.webLatencyMs || 0),
        deepseekSessionReuse: Number(counters.deepseekSessionReuse || 0),
        deepseekTimeouts: Number(counters.deepseekTimeouts || 0),
        deepseekParseFailures: Number(counters.deepseekParseFailures || 0),
        localVerificationRejects: Number(counters.localVerificationRejects || 0),
        localVerificationAccepts: Number(counters.localVerificationAccepts || 0),
        deepseekUnavailable: Number(counters.deepseekUnavailable || 0),
        deepseekAuthRequired: Number(counters.deepseekAuthRequired || 0),
        webReasoningUntrustedInstructions: Number(counters.webReasoningUntrustedInstructions || 0),
        estimatedTokensSent: counters.estimatedTokensSent ?? null,
        estimatedTokensSaved: counters.estimatedTokensSaved ?? null,
      }
    },
  }
}

// Rough token estimate for packet accounting ONLY. Never presented as a measured
// provider number; the field is named `estimated` for exactly that reason.
export function estimateTokens(chars) {
  const value = Number(chars)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value / 4)
}

/**
 * Run one consultation (or a bounded follow-up) end to end.
 *
 * Returns a decision record, never a bare answer, so the caller cannot act on
 * advice without also seeing whether it was verified, how much it cost and what
 * happened when the provider was unavailable.
 */
export async function runWebConsultation(input = {}, deps = {}) {
  const telemetry = deps.telemetry || createWebReasoningTelemetry()
  const mode = String(input.mode || WEB_ESCALATION_MODE.AUTO)
  const registry = deps.registry || createWebReasoningRegistry(deps.adapters || [])

  const decision = deps.decision || decideWebEscalation({ ...input, mode })
  if (!decision.escalate) {
    telemetry.bump("webReasoningSkipped")
    return {
      schemaVersion: 1,
      kind: "ues-web-consultation",
      consulted: false,
      outcome: "skipped",
      reason: decision.reason,
      mode,
      decision,
      fallbackToLocal: true,
      telemetry: telemetry.snapshot(),
    }
  }
  telemetry.bump("webReasoningEscalations")

  // --- provider availability, probed once and reused -----------------------
  const providerId = String(input.provider || registry.defaultId)
  const provider = registry.get(providerId)
  if (!provider) {
    telemetry.bump("deepseekUnavailable")
    return unavailableOutcome({
      mode,
      decision,
      reason: `provider-not-registered:${providerId}`,
      telemetry,
      providerId,
    })
  }

  const capability = deps.capability || await provider.capability()
  if (capability.state !== WEB_REASONING_CAPABILITY.READY) {
    if (capability.state === WEB_REASONING_CAPABILITY.NEEDS_AUTH) telemetry.bump("deepseekAuthRequired")
    else telemetry.bump("deepseekUnavailable")
    return unavailableOutcome({
      mode,
      decision,
      reason: capability.reason || `provider-state:${capability.state}`,
      telemetry,
      providerId,
      capability,
    })
  }

  // --- packet ---------------------------------------------------------------
  const packet = input.packet || buildDecisionPacket(input.packetInput || {}, {
    provider: providerId,
    ...(input.budget || {}),
  })
  telemetry.bump("decisionPacketChars", packet.chars)
  telemetry.bump("decisionPacketFiles", packet.sections?.relevantFiles?.length || 0)
  if (packet.cacheHit) telemetry.bump("decisionPacketCacheHits")

  const isFollowUp = Boolean(input.delta)
  const payloadChars = isFollowUp ? Number(input.delta.chars || 0) : Number(packet.chars || 0)
  telemetry.bump("estimatedTokensSent", estimateTokens(payloadChars))

  let session = null
  let raw = null
  let failure = null
  try {
    session = input.session || await provider.startSession({ reuseSessionId: input.reuseSessionId })
    if (!session || session.state === "needs-auth") {
      telemetry.bump("deepseekAuthRequired")
      return unavailableOutcome({
        mode,
        decision,
        reason: "provider-requires-auth",
        telemetry,
        providerId,
        capability,
        packet,
      })
    }
    if (session.reused) telemetry.bump("deepseekSessionReuse")

    const startedAt = typeof deps.now === "function" ? Number(deps.now()) : Date.now()
    raw = isFollowUp
      ? await provider.followUp(session, input.delta, { requestId: input.requestId })
      : await provider.consult(session, packet, { requestId: input.requestId })
    telemetry.bump("webLatencyMs", Math.max(0, raw.latencyMs || 0))
    telemetry.bump("webReasoningCalls")

    // The provider wrapper returns a NORMALIZED advice envelope whose `rawText`
    // is the model's own text. Parsing that is the difference between a
    // structured result and a schema failure on a re-serialised envelope.
    const payload = raw?.rawText !== undefined && raw?.rawText !== null && raw?.rawText !== ""
      ? raw.rawText
      : (raw?.advice ?? raw?.answer ?? raw ?? null)
    const parsed = parseDeepSeekResponse(payload, {
      knownFiles: input.knownFiles,
      maxChars: input.maxResponseChars,
    })
    if (!parsed.ok) {
      telemetry.bump("deepseekParseFailures")
      failure = parsed.failure
    } else {
      if (parsed.flagged) telemetry.bump("webReasoningUntrustedInstructions")
      const verification = verifyLocalAdvice({ ...parsed.advice, flagged: parsed.flagged, evidenceBinding: parsed.evidenceBinding }, {
        knownFiles: input.knownFiles,
        minConfidence: input.minConfidence,
        verificationRequired: input.verificationRequired,
      })
      if (verification.accepted) telemetry.bump("localVerificationAccepts")
      else telemetry.bump("localVerificationRejects")

      return {
        schemaVersion: 1,
        kind: "ues-web-consultation",
        consulted: true,
        outcome: verification.accepted ? "advice-accepted" : "advice-rejected",
        mode,
        decision,
        provider: providerId,
        capability,
        packet: {
          fingerprint: packet.fingerprint,
          chars: packet.chars,
          files: packet.sections?.relevantFiles?.length || 0,
          cacheHit: packet.cacheHit,
        },
        delta: isFollowUp ? { chars: input.delta.chars, changedSections: input.delta.changedSections } : null,
        advice: parsed.advice,
        evidenceBinding: parsed.evidenceBinding,
        verification,
        flagged: parsed.flagged,
        authorityAttempts: parsed.authorityAttempts,
        // Explicit negatives a consumer can read without understanding the rest.
        isTaskVerdict: false,
        canProducePass: false,
        mayChangePermissions: false,
        mayAuthorizeSideEffects: false,
        sessionId: session.sessionId,
        durationMs: Math.max(0, (typeof deps.now === "function" ? Number(deps.now()) : Date.now()) - startedAt),
        nextStep: verification.accepted ? "implement-then-verify-locally" : "reject-advice-and-retry-locally",
        telemetry: telemetry.snapshot(),
        _session: session,
      }
    }
  } catch (error) {
    failure = error?.reason || error?.code || `provider-error:${error?.message || error}`.slice(0, 200)
  } finally {
    // Session release happens on EVERY path, including a thrown error, and is
    // skipped only for an explicit keep-alive follow-up.
    if (session && input.keepSession !== true) {
      try {
        await provider.closeSession(session)
      } catch {
        // A failed close must not mask the consultation outcome.
      }
    }
  }

  if (failure === "deepseek-response-timeout") telemetry.bump("deepseekTimeouts")
  if (failure === "deepseek-auth-required") telemetry.bump("deepseekAuthRequired")

  return unavailableOutcome({
    mode,
    decision,
    reason: failure || "unknown-provider-failure",
    telemetry,
    providerId,
    capability,
    packet,
    sessionStarted: Boolean(session),
  })
}

// The single fallback choke point. AUTO degrades to local execution; FORCE
// fails loudly with the documented code and a sessionId that proves no
// consultation happened.
function unavailableOutcome({ mode, decision, reason, telemetry, providerId, capability = null, packet = null, sessionStarted = false }) {
  const forced = mode === WEB_ESCALATION_MODE.FORCE
  if (!forced) telemetry.bump("webReasoningFallbacks")
  return {
    schemaVersion: 1,
    kind: "ues-web-consultation",
    consulted: false,
    outcome: forced ? "unavailable" : "fallback-local",
    mode,
    decision,
    provider: providerId,
    capability,
    reason,
    code: forced ? WEB_REASONING_UNAVAILABLE : null,
    fallbackToLocal: !forced,
    // The receipt of a consultation that did not happen. Anything that needs to
    // distinguish "asked and got nothing" from "never asked" reads this.
    sessionStarted,
    packet: packet ? { fingerprint: packet.fingerprint, chars: packet.chars } : null,
    isTaskVerdict: false,
    canProducePass: false,
    telemetry: telemetry.snapshot(),
  }
}

/**
 * Bounded follow-up after a verifier failure. Reuses the session when it is
 * still healthy and sends ONLY the delta; a dead session restarts exactly once.
 */
export async function runWebFollowUp(input = {}, deps = {}) {
  const telemetry = deps.telemetry || createWebReasoningTelemetry()
  const maxFollowUps = Number(input.maxFollowUps ?? 2)
  const attempt = Number(input.attempt || 1)
  if (attempt > maxFollowUps) {
    telemetry.bump("webReasoningSkipped")
    return {
      schemaVersion: 1,
      kind: "ues-web-follow-up",
      followedUp: false,
      outcome: "follow-up-budget-exhausted",
      reason: "follow-up-budget-exhausted",
      fallbackToLocal: true,
      isTaskVerdict: false,
      canProducePass: false,
      telemetry: telemetry.snapshot(),
    }
  }

  const delta = input.delta || buildFollowUpDelta(input.previousPacket || {}, input.nextPacket || {}, input.budget || {})
  if (!delta.changed) {
    telemetry.bump("webReasoningSkipped")
    return {
      schemaVersion: 1,
      kind: "ues-web-follow-up",
      followedUp: false,
      outcome: "no-delta",
      reason: delta.reason,
      fallbackToLocal: true,
      isTaskVerdict: false,
      canProducePass: false,
      telemetry: telemetry.snapshot(),
    }
  }
  telemetry.bump("followUpDeltaChars", delta.chars)
  telemetry.bump("estimatedTokensSaved", estimateTokens(Math.max(0, (input.previousPacket?.chars || 0) - delta.chars)))

  const result = await runWebConsultation({
    ...input,
    delta,
    session: input.session,
    keepSession: true,
  }, {
    ...deps,
    // The SAME telemetry recorder. Creating a second one inside the nested
    // consultation made the follow-up counters invisible on the returned
    // snapshot, which is the number a benchmark actually reads.
    telemetry,
  })

  return {
    ...result,
    kind: "ues-web-follow-up",
    followedUp: result.consulted === true,
    delta: { chars: delta.chars, changedSections: delta.changedSections, savedChars: delta.savedChars },
    attempt,
    maxFollowUps,
  }
}
