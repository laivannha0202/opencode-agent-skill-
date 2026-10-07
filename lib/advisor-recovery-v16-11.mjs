// V16.11 advisor recovery coordinator.
//
// WHY THIS MODULE EXISTS
//
// A DeepSeek web consult can fail in ways the V16.9 adapter did not own as a
// single decision:
//
//   * the browser worker crashes (the page or the process dies);
//   * the authenticated session expires mid-run (auth.expired / login-required);
//   * the page redirects away from the conversation (navigation.redirect);
//   * the conversation the run was typing into is stale (rotated, closed, or
//     bound to a dead worker epoch).
//
// The V16.9 path could retry, but nothing bounded the retries across ALL of
// these, and nothing prevented the same prompt from being SUBMITTED TWICE after a
// recovery -- a duplicate consult that silently doubles latency and cost.
//
// This module owns exactly two decisions:
//
//   1. `planRecovery()`  -- given a classified failure and the current attempt
//      budget, decide whether/how to recover, or give up fail-closed.
//   2. `submitGuard()`   -- a single-flight, idempotency-keyed gate that makes a
//      re-submit of the SAME prompt after a recovery a no-op, so a recovery loop
//      can never double-submit.
//
// It owns NO browser, NO transport and NO lifecycle. It reads the current worker
// epoch/conversation from the caller and never mutates them.

import { classifyStaleness } from "./advisor-lifecycle-v16-11.mjs"

export const ADVISOR_RECOVERY_SCHEMA_VERSION = 1
export const ADVISOR_RECOVERY_POLICY = "advisor-recovery-v16-11"

// The failure taxonomy the coordinator understands. Anything unknown is treated
// as NON-recoverable (fail-closed) rather than guessed at.
export const RECOVERY_FAILURE = Object.freeze({
  WORKER_CRASH: "worker-crash",
  PAGE_CRASH: "page-crash",
  AUTH_EXPIRED: "auth-expired",
  AUTH_LOGIN_REQUIRED: "auth-login-required",
  NAVIGATION_REDIRECT: "navigation-redirect",
  STALE_CONVERSATION: "stale-conversation",
  WORKER_DISCONNECTED: "worker-disconnected",
  READ_FAILURE: "read-failure",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
})

// What the caller should DO about the failure.
export const RECOVERY_ACTION = Object.freeze({
  RETRY_SAME_WORKER: "retry-same-worker",
  RECYCLE_WORKER: "recycle-worker",
  REAUTH: "reauth",
  REOPEN_CONVERSATION: "reopen-conversation",
  FAIL: "fail",
})

// Total recovery attempts allowed across the WHOLE run, regardless of failure
// kind. This is the loop guard: without it a worker that crashes on every
// acquire would retry forever.
export const RECOVERY_MAX_TOTAL_ATTEMPTS = 3
// Per-kind ceiling, so a persistent auth failure cannot spend the whole budget
// and starve a later recoverable crash.
export const RECOVERY_MAX_PER_KIND = 2

const KIND_POLICY = Object.freeze({
  [RECOVERY_FAILURE.WORKER_CRASH]: { action: RECOVERY_ACTION.RECYCLE_WORKER, retryable: true, needsFreshWorker: true },
  [RECOVERY_FAILURE.PAGE_CRASH]: { action: RECOVERY_ACTION.RECYCLE_WORKER, retryable: true, needsFreshWorker: true },
  [RECOVERY_FAILURE.WORKER_DISCONNECTED]: { action: RECOVERY_ACTION.RECYCLE_WORKER, retryable: true, needsFreshWorker: true },
  [RECOVERY_FAILURE.AUTH_EXPIRED]: { action: RECOVERY_ACTION.REAUTH, retryable: true, needsFreshWorker: false, needsAuth: true },
  [RECOVERY_FAILURE.AUTH_LOGIN_REQUIRED]: { action: RECOVERY_ACTION.REAUTH, retryable: true, needsFreshWorker: false, needsAuth: true },
  [RECOVERY_FAILURE.NAVIGATION_REDIRECT]: { action: RECOVERY_ACTION.REOPEN_CONVERSATION, retryable: true, needsFreshWorker: false },
  [RECOVERY_FAILURE.STALE_CONVERSATION]: { action: RECOVERY_ACTION.REOPEN_CONVERSATION, retryable: true, needsFreshWorker: false },
  [RECOVERY_FAILURE.READ_FAILURE]: { action: RECOVERY_ACTION.RETRY_SAME_WORKER, retryable: true, needsFreshWorker: false },
  [RECOVERY_FAILURE.TIMEOUT]: { action: RECOVERY_ACTION.RETRY_SAME_WORKER, retryable: true, needsFreshWorker: false },
  [RECOVERY_FAILURE.UNKNOWN]: { action: RECOVERY_ACTION.FAIL, retryable: false },
})

/** Map a transport event name to a recovery failure kind. */
export function classifyFailureKind(input = {}) {
  const event = String(input.event || "")
  const reason = String(input.reason || input.error || "")
  const haystack = `${event} ${reason}`.toLowerCase()
  if (haystack.includes("auth.expired") || haystack.includes("auth-expired")) return RECOVERY_FAILURE.AUTH_EXPIRED
  if (haystack.includes("login-required") || haystack.includes("login_required")) return RECOVERY_FAILURE.AUTH_LOGIN_REQUIRED
  if (haystack.includes("page.crashed") || haystack.includes("page-crashed") || haystack.includes("target crashed")) return RECOVERY_FAILURE.PAGE_CRASH
  if (haystack.includes("worker.exited") || haystack.includes("worker exited") || haystack.includes("worker-crash") || haystack.includes("spawn")) return RECOVERY_FAILURE.WORKER_CRASH
  if (haystack.includes("browser.disconnected") || haystack.includes("disconnected")) return RECOVERY_FAILURE.WORKER_DISCONNECTED
  if (haystack.includes("redirect") || haystack.includes("navigation")) return RECOVERY_FAILURE.NAVIGATION_REDIRECT
  if (haystack.includes("stale-conversation") || haystack.includes("conversation-closed") || haystack.includes("worker-epoch-changed")) return RECOVERY_FAILURE.STALE_CONVERSATION
  if (haystack.includes("read") && haystack.includes("fail")) return RECOVERY_FAILURE.READ_FAILURE
  if (haystack.includes("timeout") || haystack.includes("timed out")) return RECOVERY_FAILURE.TIMEOUT
  if (input.failureKind && KIND_POLICY[input.failureKind]) return input.failureKind
  return RECOVERY_FAILURE.UNKNOWN
}

/**
 * Decide how to recover from a failure.
 *
 * @param {object} input
 * @param {string} [input.failureKind] explicit kind, or classified from event/reason
 * @param {string} [input.event] a transport event name
 * @param {string} [input.reason]
 * @param {object} [input.attempts] { total, byKind: { [kind]: n } }
 * @param {boolean} [input.duplicateSubmitSuspected] a prior submit may have applied
 * @param {boolean} [input.authAvailable] whether a reauth path exists
 * @param {boolean} [input.canReopenConversation] whether a fresh conversation is possible
 * @param {object} [input.lateEvent] a late event, checked for staleness before acting
 * @param {object} [input.current] the current lifecycle identity
 * @returns {object} `{ recover, action, reason, needsFreshWorker, needsAuth, budgetRemaining }`
 */
export function planRecovery(input = {}) {
  const kind = input.failureKind && KIND_POLICY[input.failureKind]
    ? input.failureKind
    : classifyFailureKind(input)
  const policy = KIND_POLICY[kind] || KIND_POLICY[RECOVERY_FAILURE.UNKNOWN]
  const attempts = input.attempts || {}
  const total = Number(attempts.total || 0)
  const byKind = Number((attempts.byKind || {})[kind] || 0)
  const base = {
    schemaVersion: ADVISOR_RECOVERY_SCHEMA_VERSION,
    policy: ADVISOR_RECOVERY_POLICY,
    failureKind: kind,
    recover: false,
    action: RECOVERY_ACTION.FAIL,
    needsFreshWorker: false,
    needsAuth: false,
    reason: null,
    budgetRemaining: Math.max(0, RECOVERY_MAX_TOTAL_ATTEMPTS - total),
  }

  if (policy.retryable !== true) {
    return { ...base, reason: "non-recoverable-failure" }
  }
  // A late event that is NOT owned by the current lifecycle must never drive a
  // recovery: recovering for a dead epoch is exactly the loop the directive
  // forbids. (Only checked when the caller supplies both.)
  if (input.lateEvent && input.current) {
    const staleness = classifyStaleness(input.lateEvent, input.current)
    if (staleness.stale === true) {
      return { ...base, reason: `stale-event:${staleness.reason}` }
    }
  }
  if (total >= RECOVERY_MAX_TOTAL_ATTEMPTS) {
    return { ...base, reason: "total-recovery-budget-exhausted" }
  }
  if (byKind >= RECOVERY_MAX_PER_KIND) {
    return { ...base, reason: `per-kind-recovery-budget-exhausted:${kind}` }
  }
  if (policy.needsAuth && input.authAvailable === false) {
    return { ...base, reason: "reauth-unavailable" }
  }
  if (policy.action === RECOVERY_ACTION.REOPEN_CONVERSATION && input.canReopenConversation === false) {
    return { ...base, reason: "conversation-reopen-unavailable" }
  }
  // If a prior submit may have applied, a same-worker retry is refused: the safe
  // action is to recycle the worker so the retry cannot land in the same, now
  // half-consumed conversation.
  let action = policy.action
  if (input.duplicateSubmitSuspected === true && action === RECOVERY_ACTION.RETRY_SAME_WORKER) {
    action = RECOVERY_ACTION.RECYCLE_WORKER
  }
  return {
    ...base,
    recover: true,
    action,
    needsFreshWorker: action === RECOVERY_ACTION.RECYCLE_WORKER || policy.needsFreshWorker === true,
    needsAuth: policy.needsAuth === true,
    reason: "recoverable",
    steps: recoverySteps(kind, action),
  }
}

function recoverySteps(kind, action) {
  const common = ["classify-failure", "check-attempt-budget", "check-duplicate-submit"]
  if (action === RECOVERY_ACTION.RECYCLE_WORKER) return [...common, "release-worker-lease", "advance-worker-epoch", "acquire-fresh-worker", "reopen-conversation", "resubmit-once"]
  if (action === RECOVERY_ACTION.REAUTH) return [...common, "preserve-conversation", "run-reauth", "verify-auth", "resume-conversation", "resubmit-once"]
  if (action === RECOVERY_ACTION.REOPEN_CONVERSATION) return [...common, "invalidate-conversation", "open-fresh-conversation", "resubmit-once"]
  return [...common, "retry-read-or-wait", "resubmit-once"]
}

/**
 * A single-flight, idempotency-keyed submit guard.
 *
 * It answers ONE question: may this prompt be submitted NOW? A prompt whose
 * idempotency key is already in-flight or already COMPLETED is refused, so a
 * recovery that re-runs the submit step is a no-op instead of a second consult.
 *
 * Keys are scoped by (workerEpoch, conversationEpoch, generation) so that a
 * legitimate retry on a FRESH worker/conversation is a new key and IS allowed.
 */
export function createSubmitGuard(options = {}) {
  const completed = new Map() // key -> { at, workerEpoch, conversationEpoch, generation }
  const inFlight = new Map()
  const maxEntries = Number.isFinite(Number(options.maxEntries)) ? Math.max(1, Math.trunc(Number(options.maxEntries))) : 512

  function keyFor(input = {}) {
    const identity = input.identity || {}
    const prompt = String(input.promptId || input.idempotencyKey || input.prompt || "").slice(0, 200)
    const scope = [
      Number(identity.workerEpoch || 0),
      Number(identity.conversationEpoch || 0),
      Number(identity.runGeneration || 0),
    ].join(".")
    return `${scope}::${prompt}`
  }

  function prune() {
    if (completed.size <= maxEntries) return
    const overflow = completed.size - maxEntries
    let i = 0
    for (const k of completed.keys()) {
      completed.delete(k)
      i += 1
      if (i >= overflow) break
    }
  }

  return {
    policy: ADVISOR_RECOVERY_POLICY,
    /**
     * Try to claim the right to submit. Returns `{ allowed, reason, key }`.
     * `allowed:false` means a submit for this key is already in flight or done.
     */
    claim(input = {}) {
      const key = keyFor(input)
      if (inFlight.has(key)) return { allowed: false, reason: "submit-in-flight", key }
      if (completed.has(key)) return { allowed: false, reason: "already-submitted", key, prior: completed.get(key) }
      inFlight.set(key, { at: Date.now(), workerEpoch: Number(input.identity?.workerEpoch || 0) })
      return { allowed: true, reason: null, key }
    },
    /** Mark a claimed key as completed. */
    complete(input = {}) {
      const key = keyFor(input)
      inFlight.delete(key)
      completed.set(key, {
        at: Date.now(),
        workerEpoch: Number(input.identity?.workerEpoch || 0),
        conversationEpoch: Number(input.identity?.conversationEpoch || 0),
        generation: Number(input.identity?.runGeneration || 0),
      })
      prune()
      return { completed: true, key }
    },
    /** Release an in-flight claim WITHOUT completing it (a recoverable failure). */
    release(input = {}) {
      const key = keyFor(input)
      return { released: inFlight.delete(key), key }
    },
    has(key) {
      return inFlight.has(key) || completed.has(key)
    },
    state() {
      return { inFlight: inFlight.size, completed: completed.size, maxEntries }
    },
  }
}
