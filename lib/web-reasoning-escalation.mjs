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
// V16.4 production wiring: the escalation router's structural evidence,
// Vietnamese fallback signals and evidence-first routing matrix are owned by
// `lib/web-reasoning-structural.mjs`. This file is the production caller.
import {
  detectVietnameseFallbackSignals,
  routeWithStructuralEvidence,
  scoreStructuralEvidence,
} from "./web-reasoning-structural.mjs"
// The signal vocabulary is owned by `lib/web-reasoning-signals.mjs` so the
// structural module can use it without an import cycle back into this file.
// Both names are re-exported here, so every existing importer is unaffected.
import {
  ESCALATION_SIGNAL,
  NON_ESCALATION_SIGNAL,
} from "./web-reasoning-signals.mjs"

export { ESCALATION_SIGNAL, NON_ESCALATION_SIGNAL }

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

// The single structured vocabulary for a consultation that could not complete.
// It is the ONLY classification a journal reader has to understand, and it is
// deliberately closed: every entry is a fixed literal, so no provider text,
// message or stack can leak through it.
//
// V16.7.1 Part 14: the provider bucket is split so an operator can tell a
// transient timeout from a login wall, a selector drift, a missing browser, a
// rate limit, a service outage or a locked profile WITHOUT parsing prose. Every
// distinct class is a fixed literal; the generic `PROVIDER` remains as the
// honest catch-all for an unclassifiable failure, and `CONSULTATION` remains for
// a failure inside the controller's own consultation orchestration.
export const WEB_CONSULTATION_ERROR = Object.freeze({
  CONSULTATION: "consultation-error",
  ESCALATION: "escalation-error",
  PROVIDER: "provider-error",
  UNAVAILABLE: "unavailable",
  TIMEOUT: "timeout",
  // V16.7.1 Part 14 split:
  NEEDS_AUTH: "needs-auth",
  UI_CHANGED: "ui-changed",
  BROWSER_UNAVAILABLE: "browser-unavailable",
  SERVICE_UNAVAILABLE: "service-unavailable",
  RATE_LIMITED: "rate-limited",
  PROFILE_LOCKED: "profile-locked",
})

/**
 * Normalize the free-form `notes` a caller passes into the escalation router.
 *
 * The controller historically passes a JOINED STRING (one `\n\n`-separated
 * blob), while earlier callers passed an ARRAY of strings. Both shapes must
 * route identically, and a non-array must never reach `.join()`. This is the
 * single canonical boundary: nothing downstream re-normalizes, and no caller
 * has to know the escalation router's preferred shape.
 */
export function normalizeNotes(notes) {
  if (Array.isArray(notes)) return notes.map((row) => String(row ?? "")).filter((row) => row !== "")
  if (notes === null || notes === undefined || notes === "") return []
  return [String(notes)]
}

/**
 * Classify a thrown consultation error into the closed vocabulary above.
 *
 * It NEVER returns or logs the raw message: an operator gets a stable reason
 * they can alert on, and a hostile provider payload cannot smuggle a secret
 * into the journal through an error string.
 */
export function classifyConsultationError(error) {
  const tagged = error?.uesConsultationReason
  if (Object.values(WEB_CONSULTATION_ERROR).includes(tagged)) return tagged
  const code = String(error?.code || "")
  const name = String(error?.name || "")
  if (code === WEB_REASONING_UNAVAILABLE || name === WEB_REASONING_UNAVAILABLE) {
    return WEB_CONSULTATION_ERROR.UNAVAILABLE
  }
  if (/timeout|timed out|etimedout/i.test(`${code} ${name}`)) return WEB_CONSULTATION_ERROR.TIMEOUT
  const message = String(error?.message || "")
  const reason = String(error?.reason || "")
  const haystack = `${code} ${name} ${reason} ${message}`
  // V16.7.1 Part 14: classify the distinct provider failure families BEFORE the
  // generic buckets, so a login wall, a selector drift, a missing browser, a
  // rate limit, a service outage and a locked profile are each reported as their
  // own closed literal. Each branch matches only stable provider tokens; no
  // message text is ever returned. `profile-locked` is checked first because it
  // is the most specific and is a distinct operational remedy.
  if (/profile.?lock|UES_PROFILE_LOCKED|owner-process/i.test(haystack)) return WEB_CONSULTATION_ERROR.PROFILE_LOCKED
  if (/rate.?limit|too many requests|\b429\b/i.test(haystack)) return WEB_CONSULTATION_ERROR.RATE_LIMITED
  if (/deepseek-auth-required|needs-auth|logged-out|login.?wall|not signed in/i.test(haystack)) return WEB_CONSULTATION_ERROR.NEEDS_AUTH
  if (/ui-selector-changed|ui-changed|selector.?changed|send-unresolvable|composer-unresolvable/i.test(haystack)) return WEB_CONSULTATION_ERROR.UI_CHANGED
  if (/browser-unavailable|browser-worker-unavailable|no-browser-lane|browser-closed/i.test(haystack)) return WEB_CONSULTATION_ERROR.BROWSER_UNAVAILABLE
  if (/service unavailable|bad gateway|gateway timeout|\b50[234]\b|econnreset|econnrefused|socket hang up/i.test(haystack)) return WEB_CONSULTATION_ERROR.SERVICE_UNAVAILABLE
  // A provider timeout surfaces as a stable reason string (`deepseek-response-
  // timeout`) rather than an error code, so the message is matched against the
  // closed timeout vocabulary. No message is ever returned or logged.
  if (/timeout|timed out/i.test(message)) return WEB_CONSULTATION_ERROR.TIMEOUT
  // The historical bug: `(notes || []).join is not a function` inside the
  // escalation router. A thrown escalation is an escalation error, not a
  // provider error, and must be reported as such.
  if (error?.uesEscalationThrow === true || /\.join is not a function|escalat/i.test(message)) {
    return WEB_CONSULTATION_ERROR.ESCALATION
  }
  return WEB_CONSULTATION_ERROR.PROVIDER
}

// Signals that make an external second opinion worth its cost live in
// `lib/web-reasoning-signals.mjs` and are re-exported above.

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

// V16.4 Slice C: Vietnamese task signals live in
// `lib/web-reasoning-structural.mjs` (text-level fallback only; grounded
// structural evidence wins over text in `routeWithStructuralEvidence`).

/**
 * Decide whether to escalate. Deterministic, synchronous, and it reports the
 * signals it used in BOTH directions so a skip is as auditable as a consult.
 */
export function decideWebEscalation(input = {}) {
  const mode = String(input.mode || WEB_ESCALATION_MODE.AUTO)
  if (mode === WEB_ESCALATION_MODE.OFF) {
    return { escalate: false, mode, reason: WEB_ESCALATION_REASON.MODE_OFF, signals: [], nonEscalationSignals: [] }
  }

  const text = `${input.task || ""}\n${normalizeNotes(input.notes).join("\n")}`.trim()
  const explicit = Array.isArray(input.signals) ? input.signals.map(String) : []
  const detected = explicit.slice()
  // Grounded structural evidence (V16.4): measured quantities and declared
  // facts. Collected separately from text so the routing matrix can rank them
  // above text without changing the reported signal list.
  const grounded = scoreStructuralEvidence(input)
  const declaredFlags = []
  for (const [pattern, signal] of ESCALATION_PATTERNS) {
    if (pattern.test(text)) detected.push(signal)
  }
  for (const [pattern, signal] of ESCALATION_PATTERNS) {
    if (input[signal] === true) {
      declaredFlags.push(signal)
      detected.push(signal)
    }
  }
  for (const signal of grounded.signals) {
    if (!detected.includes(signal)) detected.push(signal)
  }

  const nonEscalation = []
  for (const [pattern, signal] of NON_ESCALATION_PATTERNS) {
    if (pattern.test(text)) nonEscalation.push(signal)
  }
  // V16.4 structural V2: Vietnamese fallback signals come from the shared
  // structural module (text-level fallback only). The patterns are identical to
  // the V16.3 inline list, so an AUTO/FORCE/OFF decision is unchanged.
  for (const signal of detectVietnameseFallbackSignals(text)) {
    if (!detected.includes(signal)) detected.push(signal)
  }
  // Signals that came from text rather than from a measured/declared fact.
  const textOnly = detected.filter((signal) => !grounded.signals.includes(signal) && !declaredFlags.includes(signal) && !explicit.includes(signal))

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
  // V16.4 evidence-first routing. The matrix is the single decision site:
  // groundedSkip carries the hard-skip veto, so a caller-verified trivial task
  // still wins over structural evidence exactly as it did in V16.3.
  const route = routeWithStructuralEvidence({
    structural: [...new Set([...grounded.signals, ...declaredFlags, ...explicit])],
    textSignals: textOnly,
    nonEscalation,
    groundedSkip: hardSkip,
  })
  if (!route.escalate) {
    return {
      escalate: false,
      mode,
      reason: WEB_ESCALATION_REASON.NO_SIGNAL,
      // V16.4: an empty `signals` array was only meaningful when nothing at all
      // was detected. A grounded skip still reports what was detected, so the
      // veto is auditable.
      signals: hardSkip ? uniqueSignals : [],
      nonEscalationSignals: nonEscalation,
      basis: route.basis,
      structuralSignals: grounded.signals,
    }
  }
  return {
    escalate: true,
    mode,
    reason: WEB_ESCALATION_REASON.SIGNAL,
    signals: uniqueSignals,
    nonEscalationSignals: nonEscalation,
    // V16.4: which kind of evidence actually produced the escalation.
    basis: route.basis,
    structuralSignals: grounded.signals,
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
      requestId: input.requestId || null,
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
      requestId: input.requestId || null,
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
        requestId: input.requestId || null,
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
  // V16.6.1: a fail-closed session state is an AUTH/unavailable condition, not
  // an anonymous provider error, so the telemetry and the operator message stay
  // actionable ("log in", "the UI changed", "timed out").
  if (failure === "needs-auth" || failure === "session-needs-auth") telemetry.bump("deepseekAuthRequired")
  if (failure === "session-logged-out") telemetry.bump("deepseekAuthRequired")

  return unavailableOutcome({
    mode,
    decision,
    reason: failure || "unknown-provider-failure",
    telemetry,
    providerId,
    capability,
    packet,
    sessionStarted: Boolean(session),
    requestId: input.requestId || null,
  })
}

// The single fallback choke point. AUTO degrades to local execution; FORCE
// fails loudly with the documented code and a sessionId that proves no
// consultation happened.
function unavailableOutcome({ mode, decision, reason, telemetry, providerId, capability = null, packet = null, sessionStarted = false, requestId = null }) {
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
    requestId,
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
  // V16.4 production wiring: the follow-up budget, the fresh-evidence gate and
  // the second-follow-up admission rule are owned by two focused modules. This
  // function is their only production caller.
  const [{ normalizeFollowUpBudget, maySendSecondFollowUp }, { gateFollowUpDispatch, snapshotRepositoryEvidence }] = await Promise.all([
    import("./followup-budget.mjs"),
    import("./fresh-evidence.mjs"),
  ])
  const maxFollowUps = normalizeFollowUpBudget(input.maxFollowUps ?? 1)
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

  // --- V16.4 fresh evidence BEFORE a follow-up -----------------------------
  // The local side snapshots the CURRENT repository state and compares it with
  // what the provider already saw. A refresh that failed fails CLOSED to local;
  // a refresh that proved nothing changed must not resend anything.
  const currentEvidence = input.currentEvidence || snapshotRepositoryEvidence({
    files: Object.fromEntries((input.knownFiles || []).map((name) => [String(name), ""])),
    diff: input.localDiff || "",
    diagnostics: input.localDiagnostics || [],
    failingTests: input.localFailingTests || [],
  })
  const freshGate = gateFollowUpDispatch(input.providerSeenEvidence || null, currentEvidence, {
    refreshOk: input.repositoryRefreshOk !== false,
  })
  if (!freshGate.ok) {
    telemetry.bump("webReasoningSkipped")
    telemetry.bump("webReasoningStaleState")
    return {
      schemaVersion: 1,
      kind: "ues-web-follow-up",
      followedUp: false,
      outcome: "stale-repository-state",
      reason: freshGate.reason,
      // Nothing is sent and nothing is claimed. The run continues locally.
      fallbackToLocal: true,
      freshEvidence: { ok: false, reason: freshGate.reason, provenance: "local-repository-refresh" },
      isTaskVerdict: false,
      canProducePass: false,
      telemetry: telemetry.snapshot(),
    }
  }

  // --- V16.4 second follow-up admission ------------------------------------
  // The default budget is ONE follow-up. A second is only admitted when fresh
  // local verifier evidence, a changed fingerprint, an unresolved first
  // follow-up, benefit over cost and a healthy session all hold.
  //
  // `requireVerifiedSecondFollowUp` is opt-in because the rule is stronger than
  // the plain budget: a caller that cannot produce that evidence must be able
  // to run with the budget alone. The production controller opts IN
  // (`pi/extensions/ues.ts`), which is the path that spends real money.
  if (attempt >= 2 && input.requireVerifiedSecondFollowUp === true) {
    const admission = maySendSecondFollowUp({ followUpsSent: Number(input.followUpsSent ?? 1) }, {
      freshVerifierEvidence: input.freshVerifierEvidence === true || freshGate.delta?.changed === true,
      fingerprintChanged: input.fingerprintChanged === true || freshGate.delta?.verificationChanged === true,
      firstResolved: input.firstResolved === true,
      benefitExceedsCost: input.benefitExceedsCost === true,
      submitBudgetAllows: input.submitBudgetAllows === true,
      sessionHealthy: input.sessionHealthy === true,
    })
    if (!admission.allowed) {
      telemetry.bump("webReasoningSkipped")
      telemetry.bump("webReasoningSecondFollowUpDenied")
      return {
        schemaVersion: 1,
        kind: "ues-web-follow-up",
        followedUp: false,
        outcome: "second-follow-up-not-admitted",
        reason: admission.reason,
        reasons: admission.reasons,
        fallbackToLocal: true,
        freshEvidence: { ok: true, reason: freshGate.reason, delta: freshGate.delta, provenance: "local-repository-refresh" },
        isTaskVerdict: false,
        canProducePass: false,
        telemetry: telemetry.snapshot(),
      }
    }
  }

  const delta = input.delta || buildFollowUpDelta(input.previousPacket || {}, input.nextPacket || {}, input.budget || {})
  if (!delta.changed || freshGate.sendDelta === false) {
    telemetry.bump("webReasoningSkipped")
    return {
      schemaVersion: 1,
      kind: "ues-web-follow-up",
      followedUp: false,
      outcome: "no-delta",
      reason: delta.changed ? "no-repository-change" : delta.reason,
      fallbackToLocal: true,
      freshEvidence: { ok: true, reason: freshGate.reason, delta: freshGate.delta, provenance: "local-repository-refresh" },
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
    freshEvidence: { ok: true, reason: freshGate.reason, delta: freshGate.delta, provenance: "local-repository-refresh" },
    attempt,
    maxFollowUps,
  }
}
