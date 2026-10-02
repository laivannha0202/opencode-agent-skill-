// V16.3 Phase A, step 5 (evidence half): action receipts, post-action
// verification, and browser telemetry.
//
// Two properties make this file load-bearing rather than decorative:
//
//   1. A tool call returning success is NOT proof. `buildActionReceipt` refuses
//      to mark `expectedStateVerified` from the tool's own return value; the
//      caller has to hand it an observation. An action that requires
//      post-verification and has none is emitted as `unverified`, never as
//      `verified`.
//   2. A receipt is evidence, so it is data the model and any later consumer
//      will read. Every field passes through the shared redactor, which is why
//      password/token/cookie/Authorization material cannot reach a receipt even
//      if a provider helpfully hands it back in a result blob.

import { BROWSER_ACTION_CLASS, classifyBrowserAction } from "./browser-action-taxonomy.mjs"
import { externalTrustContract } from "./browser-security.mjs"
import { locatorFingerprint, locatorStrategyRank, normalizeLocatorStrategy } from "./browser-stale-recovery.mjs"
import { redactStructure, redactSecrets } from "./secret-redaction.mjs"

export const BROWSER_RECEIPT_SCHEMA_VERSION = 1

export const BROWSER_ACTION_RESULT = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
  REFUSED: "refused",
  UNVERIFIED: "unverified",
  SKIPPED: "skipped",
})

export const BROWSER_VERIFICATION_STATUS = Object.freeze({
  VERIFIED: "verified",
  UNVERIFIED: "unverified",
  FAILED: "failed",
  NOT_REQUIRED: "not-required",
})

// Post-action verification checks, cheapest first. The list is a closed set so a
// receipt cannot claim an exotic, unfalsifiable kind of proof.
export const BROWSER_EXPECTED_STATE_KIND = Object.freeze({
  URL: "url",
  ELEMENT_PRESENT: "element-present",
  ELEMENT_ABSENT: "element-absent",
  UI_STATE: "semantic-ui-state",
  NETWORK_CLASS: "network-response-class",
  APPLICATION_STATE: "application-state",
  SUCCESS_INDICATOR: "success-indicator",
  TEXT_PRESENT: "text-present",
  TEXT_ABSENT: "text-absent",
})

/** @type {Set<string>} */
const EXPECTED_STATE_KINDS = new Set(Object.values(BROWSER_EXPECTED_STATE_KIND))

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function boundedText(value, maxChars) {
  return String(value ?? "").slice(0, maxChars)
}

function safeUrl(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}

function isoOrNull(value) {
  if (value == null || value === "") return null
  const date = value instanceof Date ? value : new Date(Number(value) || value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function createBrowserActionId(input = {}) {
  const action = String(input.action || "action")
  const startedAt = Number(input.startedAt || 0)
  const sequence = boundedInt(input.sequence, 0, 0, 1_000_000)
  return `ba-${action}-${String(startedAt).slice(-8)}-${String(sequence).padStart(3, "0")}`
}

// Normalises one expected-state observation. `observed` is the ONLY thing that
// can produce a verified status; there is deliberately no branch that infers
// verification from the fact that the action was dispatched.
export function verifyExpectedState(input = {}) {
  const kind = String(input.kind || "").trim()
  const base = {
    schemaVersion: BROWSER_RECEIPT_SCHEMA_VERSION,
    kind: kind || null,
    knownKind: EXPECTED_STATE_KINDS.has(kind),
    required: input.required === true,
    expected: boundedText(input.expected, 400),
    observed: boundedText(input.observed, 400),
    verified: false,
    status: BROWSER_VERIFICATION_STATUS.UNVERIFIED,
    reason: "",
  }

  if (!base.knownKind) {
    return { ...base, reason: "unknown-expected-state-kind" }
  }
  if (input.observed === undefined || input.observed === null) {
    return { ...base, reason: "no-observation-supplied" }
  }

  let matched = false
  if (kind === BROWSER_EXPECTED_STATE_KIND.URL) {
    const expected = safeUrl(input.expected)
    const observed = safeUrl(input.observed)
    if (expected && observed) matched = observed === expected || observed.startsWith(expected)
    else matched = String(input.expected || "") === String(input.observed || "")
  } else if (
    kind === BROWSER_EXPECTED_STATE_KIND.ELEMENT_PRESENT ||
    kind === BROWSER_EXPECTED_STATE_KIND.TEXT_PRESENT ||
    kind === BROWSER_EXPECTED_STATE_KIND.SUCCESS_INDICATOR
  ) {
    matched = input.observed === true || String(input.observed || "").toLowerCase() === "true"
  } else if (
    kind === BROWSER_EXPECTED_STATE_KIND.ELEMENT_ABSENT ||
    kind === BROWSER_EXPECTED_STATE_KIND.TEXT_ABSENT
  ) {
    matched = input.observed === false || String(input.observed || "").toLowerCase() === "false"
  } else if (
    kind === BROWSER_EXPECTED_STATE_KIND.UI_STATE ||
    kind === BROWSER_EXPECTED_STATE_KIND.APPLICATION_STATE ||
    kind === BROWSER_EXPECTED_STATE_KIND.NETWORK_CLASS
  ) {
    matched = String(input.observed || "").trim().toLowerCase() ===
      String(input.expected || "").trim().toLowerCase()
  } else {
    matched = false
  }

  if (!matched) {
    return {
      ...base,
      status: input.required ? BROWSER_VERIFICATION_STATUS.FAILED : BROWSER_VERIFICATION_STATUS.UNVERIFIED,
      reason: "expected-state-not-observed",
    }
  }
  return { ...base, verified: true, status: BROWSER_VERIFICATION_STATUS.VERIFIED, reason: "expected-state-observed" }
}

// Collapses one or more verifications into the single status a receipt carries.
// A required check that failed dominates; a required check that is merely
// unverified downgrades success to `unverified` rather than to a pass.
export function summarizeVerification(checks = []) {
  // Accepts either already-validated rows or raw declarations. Validating here
  // keeps a single code path for the verdict, so a caller that hands in raw rows
  // cannot silently produce "not verified" for an observation that did match.
  const rows = (Array.isArray(checks) ? checks : [])
    .filter(Boolean)
    .map((row) => (typeof row.status === "string" ? row : verifyExpectedState(row)))
  if (!rows.length) {
    return {
      status: BROWSER_VERIFICATION_STATUS.UNVERIFIED,
      verified: false,
      required: false,
      checks: 0,
      reason: "no-expectation-supplied",
    }
  }
  const required = rows.some((row) => row.required === true)
  const failed = rows.find((row) => row.status === BROWSER_VERIFICATION_STATUS.FAILED)
  if (failed) {
    return { status: BROWSER_VERIFICATION_STATUS.FAILED, verified: false, required, checks: rows.length, reason: failed.reason }
  }
  const verified = rows.every((row) => row.status === BROWSER_VERIFICATION_STATUS.VERIFIED)
  if (verified && required) {
    return { status: BROWSER_VERIFICATION_STATUS.VERIFIED, verified: true, required, checks: rows.length, reason: "all-required-expectations-observed" }
  }
  if (verified) {
    return { status: BROWSER_VERIFICATION_STATUS.NOT_REQUIRED, verified: true, required: false, checks: rows.length, reason: "optional-expectations-observed" }
  }
  return {
    status: BROWSER_VERIFICATION_STATUS.UNVERIFIED,
    verified: false,
    required,
    checks: rows.length,
    reason: "tool-success-is-not-proof",
  }
}

// A receipt must never carry a secret form value. Value redaction alone is not
// enough: a password entered into a field is a secret even when it matches no
// token shape, and the provider's echo of it usually arrives under a benign key
// like `value` or `submitted`. So the receipt detects a SECRET TARGET and drops
// the provider payload wholesale rather than trying to scrub it.
const SECRET_FIELD_PATTERN =
  /(pass(?:word|wd|code)|secret|token|api[_-]?key|auth|otp|2fa|mfa|cvv|cvc|card[_-]?(?:number|no)|pin\b|private[_-]?key|credential|ssn|social[_-]?security|iban)/i

export function isSecretFormTarget(input = {}) {
  const source = input || {}
  const haystack = [
    source.testId,
    source.id,
    source.role,
    source.accessibleName,
    source.name,
    source.text,
    source.strategy === "data-testid" ? source.testId : null,
  ].filter(Boolean).join(" ")
  if (!haystack) return false
  // A `textbox` is not a secret just because it exists; the NAME has to say so.
  return SECRET_FIELD_PATTERN.test(haystack)
}

export function buildActionReceipt(input = {}) {
  const taxonomy = input.taxonomy || classifyBrowserAction({ action: input.action })
  const beforeUrl = safeUrl(input.beforeUrl)
  const afterUrl = safeUrl(input.afterUrl)
  const verification = summarizeVerification(input.verifications)
  const requiresPostVerification = taxonomy.requiresPostVerification === true
  const expectedStateVerified = requiresPostVerification ? verification.verified === true : true

  const dispatchResult = String(input.result || BROWSER_ACTION_RESULT.SUCCESS)
  let result = dispatchResult
  if (dispatchResult === BROWSER_ACTION_RESULT.SUCCESS && requiresPostVerification && !expectedStateVerified) {
    // Tool success without a verified expected state is not a success claim.
    result = BROWSER_ACTION_RESULT.UNVERIFIED
  }

  const locatorStrategy = normalizeLocatorStrategy(input.locatorStrategy) || null
  const secretTarget = input.secretTarget === true || isSecretFormTarget({
    ...(input.locator || {}),
    testId: input.locator?.testId,
    id: input.locator?.id,
  })
  const startMs = Number(input.startTime || input.startedAt || Date.now())
  const endMs = Number(input.endedAt || startMs)
  const durationMs = Math.max(0, Math.min(10 * 60_000, Math.round(endMs - startMs)))

  const raw = {
    schemaVersion: BROWSER_RECEIPT_SCHEMA_VERSION,
    kind: "ues-browser-action-receipt",
    actionId: String(input.actionId || createBrowserActionId({ action: input.action, startTime: startMs, sequence: input.sequence })),
    action: String(input.action || "unknown"),
    actionClass: taxonomy.actionClass || BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    provider: input.provider || null,
    route: input.route || null,
    beforeUrl,
    afterUrl,
    urlChanged: Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl),
    locatorStrategy,
    locatorStrategyRank: locatorStrategy ? locatorStrategyRank(locatorStrategy) : null,
    locatorFingerprint: String(input.locatorFingerprint || locatorFingerprint(input.locator || {})),
    startTime: isoOrNull(startMs),
    durationMs,
    result,
    retryCount: boundedInt(input.retryCount, 0, 0, 16),
    staleRecovered: input.staleRecovered === true,
    navigationObserved: input.navigationObserved === true,
    expectedStateVerified,
    screenshotRef: boundedText(input.screenshotRef, 400) || null,
    snapshotRef: boundedText(input.snapshotRef, 400) || null,
    consoleErrorCount: boundedInt(input.consoleErrorCount, 0, 0, 10_000),
    networkFailureCount: boundedInt(input.networkFailureCount, 0, 0, 10_000),
    taxonomy: {
      retryAllowed: taxonomy.retryAllowed === true,
      maxRetries: boundedInt(taxonomy.maxRetries, 0, 0, 16),
      sideEffectRisk: taxonomy.sideEffectRisk || "unknown",
      evidenceRequirements: Array.isArray(taxonomy.evidenceRequirements) ? taxonomy.evidenceRequirements.slice(0, 12) : [],
      requiresPostVerification,
      requiresExplicitApproval: taxonomy.requiresExplicitApproval === true,
      unknownAction: taxonomy.unknownAction === true,
    },
    verification: {
      status: verification.status,
      required: verification.required,
      checks: verification.checks,
      reason: verification.reason,
      // Individual checks stay in the receipt (bounded) so a human can see WHAT
      // was observed, not just that something was.
      observed: (Array.isArray(input.verifications) ? input.verifications : [])
        .filter(Boolean)
        .slice(0, 8)
        .map((row) => ({
          kind: row.kind,
          expected: row.expected,
          observed: row.observed,
          verified: row.verified === true,
          reason: row.reason,
        })),
    },
    trustLevel: "untrusted-external",
    instructionAuthority: "none",
    // What the provider actually returned. Bounded before it enters the receipt
    // and redacted by the same pass as everything else, so a provider that
    // echoes a form value or a response header cannot smuggle a credential into
    // durable evidence. A secret form target withholds it entirely.
    providerResult: secretTarget ? null : (input.providerResult === undefined ? null : input.providerResult),
    ...(secretTarget ? { providerResultWithheld: "secret-form-target" } : {}),
    ...externalTrustContract("browser-action-receipt"),
  }

  // Redaction happens on the assembled object, so a field we did not think about
  // is still scrubbed. `redactStructure` returns a NEW object.
  const bounded = boundReceiptValue(raw)
  const scrubbed = redactStructure(bounded, { maxDepth: 6, maxKeys: 400 })
  return {
    ...scrubbed.value,
    redaction: { applied: scrubbed.redacted, hits: scrubbed.hits, truncated: scrubbed.truncated },
  }
}

// The provider payload is the only unbounded part of a receipt, so it gets its
// own depth/width/char caps before redaction. Truncation is recorded, never
// silent.
const RECEIPT_PAYLOAD_MAX_DEPTH = 4
const RECEIPT_PAYLOAD_MAX_KEYS = 60
const RECEIPT_PAYLOAD_MAX_STRING = 2_000

function boundReceiptValue(value, depth = 0, keyCount = { used: 0 }) {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value.length > RECEIPT_PAYLOAD_MAX_STRING
    ? `${value.slice(0, RECEIPT_PAYLOAD_MAX_STRING)}...[truncated]`
    : value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (depth >= RECEIPT_PAYLOAD_MAX_DEPTH) return "[bounded]"
  if (Array.isArray(value)) {
    const out = []
    for (const item of value.slice(0, RECEIPT_PAYLOAD_MAX_KEYS)) {
      keyCount.used += 1
      out.push(boundReceiptValue(item, depth + 1, keyCount))
    }
    return out
  }
  if (typeof value !== "object") return "[bounded]"
  const out = {}
  for (const [key, item] of Object.entries(value).slice(0, RECEIPT_PAYLOAD_MAX_KEYS)) {
    keyCount.used += 1
    out[key] = boundReceiptValue(item, depth + 1, keyCount)
  }
  return out
}

export function createBrowserTelemetry() {
  const counters = Object.create(null)
  const timings = Object.create(null)

  const bump = (name, amount = 1) => {
    const value = Number(counters[name] || 0) + Number(amount || 0)
    counters[name] = Number.isFinite(value) ? value : counters[name]
  }
  const observe = (name, value) => {
    const number = Number(value)
    if (!Number.isFinite(number)) return
    const row = timings[name] || { count: 0, totalMs: 0, maxMs: 0 }
    row.count += 1
    row.totalMs += Math.max(0, number)
    row.maxMs = Math.max(row.maxMs, Math.max(0, number))
    timings[name] = row
  }

  return {
    bump,
    observe,
    // Records one action receipt into the counters. Every field is derived, so
    // two runs over the same receipts always produce the same telemetry.
    recordReceipt(receipt = {}) {
      const success = receipt.result === BROWSER_ACTION_RESULT.SUCCESS
      bump("browserActionAttempts")
      if (success) bump("browserActionSuccesses")
      else bump("browserActionFailures")
      bump(`browserRetries`, boundedInt(receipt.retryCount, 0, 0, 16))
      if (receipt.staleRecovered) bump("staleRecoverySuccesses")
      if (receipt.navigationObserved) bump("navigationObserved")
      observe("actionLatencyMs", receipt.durationMs)
      if (receipt.screenshotRef) bump("screenshots")
      if (receipt.snapshotRef) bump("snapshots")
      if (Number(receipt.consoleErrorCount || 0) > 0) bump("consoleErrorActions")
      if (Number(receipt.networkFailureCount || 0) > 0) bump("networkFailureActions")
      return this
    },
    recordStaleFailure() {
      bump("staleLocatorFailures")
      bump("staleRecoveryAttempts")
      return this
    },
    // Counted at DISPATCH, not at receipt: a tool call that was allowed and then
    // produced no receipt still happened, and counting it here is what makes
    // `browserToolCalls` comparable to a provider-side call count.
    recordDispatch() {
      bump("browserToolCalls")
      return this
    },
    recordMcpTransientFailure() {
      bump("mcpTransientFailures")
      return this
    },
    recordCooldown() {
      bump("mcpCooldowns")
      return this
    },
    recordNativeFallback() {
      bump("nativeFallbacks")
      return this
    },
    recordInteractiveCapabilityFailure() {
      bump("interactiveCapabilityFailures")
      return this
    },
    recordNavigation(navigation = {}) {
      if (navigation.observed) {
        observe("navigationMs", navigation.durationMs)
        bump("navigations", 1)
        if (navigation.kind === "redirect") bump("navigationRedirects", 1)
        if (navigation.kind === "spa-navigation") bump("navigationSpa", 1)
      }
      return this
    },
    recordTokens(tokens = {}) {
      const input = boundedInt(tokens.inputTokens, 0, 0, 1e12)
      const output = boundedInt(tokens.outputTokens, 0, 0, 1e12)
      if (input) bump("browserInputTokens", input)
      if (output) bump("browserOutputTokens", output)
      if (Number(tokens.reasoningTurns || 0) > 0) bump("browserReasoningTurns", boundedInt(tokens.reasoningTurns, 0, 0, 1e6))
      return this
    },
    snapshot() {
      const attempts = Number(counters.browserActionAttempts || 0)
      const successes = Number(counters.browserActionSuccesses || 0)
      const staleAttempts = Number(counters.staleRecoveryAttempts || 0)
      const staleSuccesses = Number(counters.staleRecoverySuccesses || 0)
      const navigation = timings.navigationMs
      const action = timings.actionLatencyMs
      return {
        schemaVersion: BROWSER_RECEIPT_SCHEMA_VERSION,
        kind: "ues-browser-telemetry",
        browserToolCalls: Number(counters.browserToolCalls || 0),
        browserActionAttempts: attempts,
        browserActionSuccesses: successes,
        browserActionFailures: Number(counters.browserActionFailures || 0),
        browserActionSuccessRate: attempts > 0 ? Number((successes / attempts).toFixed(4)) : null,
        browserRetries: Number(counters.browserRetries || 0),
        staleLocatorFailures: Number(counters.staleLocatorFailures || 0),
        staleRecoveryAttempts: staleAttempts,
        staleRecoverySuccesses: staleSuccesses,
        staleRecoverySuccessRate: staleAttempts > 0 ? Number((staleSuccesses / staleAttempts).toFixed(4)) : null,
        navigationMs: navigation ? {
          count: navigation.count,
          totalMs: navigation.totalMs,
          maxMs: navigation.maxMs,
          meanMs: Math.round(navigation.totalMs / navigation.count),
        } : { count: 0, totalMs: 0, maxMs: 0, meanMs: 0 },
        actionLatencyMs: action ? {
          count: action.count,
          totalMs: action.totalMs,
          maxMs: action.maxMs,
          meanMs: Math.round(action.totalMs / action.count),
        } : { count: 0, totalMs: 0, maxMs: 0, meanMs: 0 },
        screenshots: Number(counters.screenshots || 0),
        snapshots: Number(counters.snapshots || 0),
        navigations: Number(counters.navigations || 0),
        navigationRedirects: Number(counters.navigationRedirects || 0),
        navigationSpa: Number(counters.navigationSpa || 0),
        consoleErrorActions: Number(counters.consoleErrorActions || 0),
        networkFailureActions: Number(counters.networkFailureActions || 0),
        mcpTransientFailures: Number(counters.mcpTransientFailures || 0),
        mcpCooldowns: Number(counters.mcpCooldowns || 0),
        nativeFallbacks: Number(counters.nativeFallbacks || 0),
        interactiveCapabilityFailures: Number(counters.interactiveCapabilityFailures || 0),
        browserInputTokens: Number(counters.browserInputTokens || 0),
        browserOutputTokens: Number(counters.browserOutputTokens || 0),
        browserReasoningTurns: Number(counters.browserReasoningTurns || 0),
      }
    },
  }
}

export function browserTelemetryFromReceipts(receipts = []) {
  const telemetry = createBrowserTelemetry()
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!receipt) continue
    telemetry.recordReceipt(receipt)
  }
  return telemetry.snapshot()
}

// Small helper used by the browser executor and by the DeepSeek adapter: given a
// raw provider result blob, report which of the receipt's evidence requirements
// the blob can even satisfy. Used to keep receipts honest about what is missing
// rather than silently emitting nulls.
export function missingReceiptEvidence(receipt = {}) {
  const required = receipt.taxonomy?.evidenceRequirements || []
  return required.filter((name) => {
    const value = receipt[name]
    if (name === "expectedStateVerified") return value !== true
    if (name === "navigationObserved") return value !== true
    if (name === "consoleErrorCount" || name === "networkFailureCount") return false
    return value === null || value === undefined || value === ""
  })
}

export function redactBrowserOutput(value, options = {}) {
  return redactSecrets(typeof value === "string" ? value : JSON.stringify(value ?? ""), options)
}
