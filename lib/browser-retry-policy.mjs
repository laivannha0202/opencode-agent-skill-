// V16.3 Phase A, step 3: bounded safe retry.
//
// Retry is where browser automation quietly turns into an incident. Two rules
// make this module the only place allowed to say "run it again":
//
//   1. The budget comes from the taxonomy, never from the caller.
//   2. A retry is only ever a *re-resolution* of the same intent against fresh
//      evidence. There is no blind replay path here at all -- `replay` is not a
//      field this function can emit for external side effects because the whole
//      code path is unreachable for them.

import { isTransientMcpFailure } from "./mcp-health.mjs"
import { BROWSER_ACTION_CLASS, BROWSER_SIDE_EFFECT_RISK } from "./browser-action-taxonomy.mjs"

// Bounded, explicit budgets. These are the numbers the V16.3 contract promises:
// one stale-locator retry, one transient retry for a safe action, zero for a
// side effect.
export const BROWSER_RETRY_LIMITS = Object.freeze({
  staleLocatorMax: 1,
  transientSafeMax: 2,
  sideEffectMax: 0,
})

export const BROWSER_RETRY_REASON = Object.freeze({
  ALLOWED: "bounded-retry-allowed",
  FIRST_ATTEMPT: "first-attempt",
  SIDE_EFFECT_NEVER_REPLAYED: "external-side-effect-never-replayed",
  UNKNOWN_ACTION: "unknown-action-never-replayed",
  RETRY_BUDGET_EXHAUSTED: "retry-budget-exhausted",
  NON_RETRYABLE_FAILURE: "non-retryable-failure",
  RETRY_KIND_NOT_ALLOWED: "retry-kind-not-allowed-for-action",
  NOT_IDEMPOTENT: "interactive-action-without-idempotency-proof",
  ABORTED: "aborted",
})

const STALE_LOCATOR =
  /(stale element|no longer attached|not attached to the dom|element is not (?:visible|enabled|attached)|waiting for (?:locator|selector)|locator resolved to \d+ elements?|resolved to (?:zero|0) elements?|target (?:closed|detached)|element was detached|selector resolved to nothing|intercepts pointer events)/i

const AUTH_REQUIRED = /(?:login|log in|sign in|signin|unauthorized|401|authentication required|sign in to continue|please log in)/i

export function isStaleLocatorFailure(value = "") {
  return STALE_LOCATOR.test(String(value || ""))
}

export function isAuthRequiredFailure(value = "") {
  return AUTH_REQUIRED.test(String(value || ""))
}

export function classifyBrowserFailure(input = {}) {
  const message = String(input.message || input.error || input.text || "")
  const stale = input.kind === "stale-locator" || isStaleLocatorFailure(message)
  if (stale) {
    return { schemaVersion: 1, kind: "stale-locator", transient: false, authRequired: false }
  }
  if (input.kind === "auth-required" || isAuthRequiredFailure(message)) {
    return { schemaVersion: 1, kind: "auth-required", transient: false, authRequired: true }
  }
  const transient = input.kind === "transient" || isTransientMcpFailure(message)
  return {
    schemaVersion: 1,
    kind: transient ? "transient" : "deterministic",
    transient,
    authRequired: false,
  }
}

function boundedDelay(attempt) {
  return Math.min(2_000, 150 * (2 ** Math.max(0, attempt - 1)))
}

// `taxonomy` must be the object produced by classifyBrowserAction(). This
// function refuses to invent a policy for a missing taxonomy, because a
// taxonomy-less retry decision is exactly the bug class this phase removes.
export function browserRetryDecision(input = {}) {
  const taxonomy = input.taxonomy || input.action
  if (!taxonomy || typeof taxonomy !== "object") {
    return {
      schemaVersion: 1,
      retry: false,
      kind: "none",
      reason: BROWSER_RETRY_REASON.RETRY_KIND_NOT_ALLOWED,
      attempt: Math.max(1, Number(input.attempt) || 1),
      nextAttempt: Math.max(1, Number(input.attempt) || 1),
      maxAttempts: 1,
      delayMs: 0,
      replay: false,
    }
  }

  const attempt = Math.max(1, Math.trunc(Number(input.attempt) || 1))
  const failure = classifyBrowserFailure({
    kind: input.failureKind,
    message: input.message || input.error,
  })
  const requestedKind = String(input.retryKind || failure.kind || "transient")

  const base = {
    schemaVersion: 1,
    kind: requestedKind,
    reason: "",
    attempt,
    delayMs: 0,
    replay: false,
    failureKind: failure.kind,
  }

  if (taxonomy.unknownAction === true) {
    return {
      ...base,
      retry: false,
      reason: BROWSER_RETRY_REASON.UNKNOWN_ACTION,
      nextAttempt: attempt,
      maxAttempts: attempt,
    }
  }

  if (taxonomy.actionClass === BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT ||
      taxonomy.sideEffectRisk === BROWSER_SIDE_EFFECT_RISK.UNKNOWN) {
    return {
      ...base,
      retry: false,
      reason: BROWSER_RETRY_REASON.SIDE_EFFECT_NEVER_REPLAYED,
      nextAttempt: attempt,
      maxAttempts: attempt,
    }
  }

  if (input.aborted === true) {
    return {
      ...base,
      retry: false,
      reason: BROWSER_RETRY_REASON.ABORTED,
      nextAttempt: attempt,
      maxAttempts: attempt,
    }
  }

  const allowedKinds = Array.isArray(taxonomy.retryKinds) ? taxonomy.retryKinds : []
  if (!allowedKinds.includes(requestedKind)) {
    const deterministicFailure = requestedKind !== "stale-locator" && failure.kind !== "transient"
    return {
      ...base,
      retry: false,
      reason: deterministicFailure
        ? BROWSER_RETRY_REASON.NON_RETRYABLE_FAILURE
        : BROWSER_RETRY_REASON.RETRY_KIND_NOT_ALLOWED,
      nextAttempt: attempt,
      maxAttempts: attempt,
    }
  }

  // A transient replay of an interactive action needs an explicit proof that the
  // action cannot commit an external side effect. Without it, only stale-locator
  // re-resolution stays on the table.
  if (requestedKind === "transient" && taxonomy.idempotencyProofRequired === true && taxonomy.idempotencyProof !== true) {
    return {
      ...base,
      retry: false,
      reason: BROWSER_RETRY_REASON.NOT_IDEMPOTENT,
      nextAttempt: attempt,
      maxAttempts: attempt,
    }
  }

  const staleRetries = Number(input.staleRetries || 0)
  const transientRetries = Number(input.transientRetries || 0)
  const maxForKind = requestedKind === "stale-locator"
    ? BROWSER_RETRY_LIMITS.staleLocatorMax
    : BROWSER_RETRY_LIMITS.transientSafeMax
  const usedForKind = requestedKind === "stale-locator" ? staleRetries : transientRetries

  if (usedForKind >= maxForKind || taxonomy.maxRetries < 1) {
    return {
      ...base,
      retry: false,
      reason: BROWSER_RETRY_REASON.RETRY_BUDGET_EXHAUSTED,
      nextAttempt: attempt,
      maxAttempts: attempt,
    }
  }

  return {
    ...base,
    retry: true,
    reason: BROWSER_RETRY_REASON.ALLOWED,
    nextAttempt: attempt + 1,
    maxAttempts: maxForKind + 1,
    delayMs: boundedDelay(attempt),
    // Only navigation/read-only may be re-executed verbatim. Everything else is
    // re-resolved against a fresh snapshot before it runs again.
    replay: requestedKind === "stale-locator" ? false : taxonomy.replaySafe === true,
  }
}