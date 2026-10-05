// V16.7 DeepSeek account authentication lifecycle.
//
// This module owns the STATE MACHINE and the SAFETY RULES for authenticating a
// DeepSeek Web profile. It is deliberately upstream of the browser: it decides
// what the runtime is allowed to do next and what the user must do, and it never
// reads a credential, a cookie, a token, a storageState file or a browser
// profile's contents.
//
// The lifecycle it models:
//
//   IDLE  ──probe──▶ READY            (a logged-in session; continue the task)
//         ──probe──▶ NEEDS_AUTH       (login required; HUMAN_ACTION_REQUIRED)
//         ──probe──▶ INDETERMINATE    (drift/timeout/closed; fail closed)
//
// Invariants:
//
//   * A probe is READ-ONLY. It observes the page and returns a classification.
//     It never clicks "Sign in", never types a password, never solves a CAPTCHA
//     and never injects an OTP.
//   * The auth signal is a BOOLEAN derived from page evidence (the existing
//     `classifyAuthState` / `AUTH_PROBE_STATE` contract). There is no
//     `authenticated = true` shortcut and no remembered state.
//   * Only an explicit recognized READY observation is READY. A missing or
//     unrecognized state, a login wall, or a drift/timeout/closed page stops
//     the run rather than being reported as a live conversation.
//   * Manual login is BOUNDED: a human gets a real chance, and the wait is
//     capped by BOTH probe count and wall clock (reusing the V16.3 waiter).
//   * A mid-task expiry produces a RESUME CAPSULE so the task continues without
//     losing state, and never refills the turn budget.
//
// Everything here is pure logic over classifications plus one thin adapter that
// maps the existing worker auth-probe state onto the lifecycle states.

import { AUTH_PROBE_STATE, classifyAuthState as classifyProbeState } from "./browser-profile.mjs"

export const DEEPSEEK_AUTH_SCHEMA_VERSION = 1
export const DEEPSEEK_AUTH_POLICY = "deepseek-auth-lifecycle-v16-7"

/**
 * Canonical authentication states. These are the ONLY values a caller may
 * branch on. They are intentionally distinct from the worker's raw probe states
 * so the lifecycle can add `not-probed` and `expired` without overloading them.
 */
export const AUTH_STATE = Object.freeze({
  // No probe has run in this context. Never assumed ready.
  NOT_PROBED: "not-probed",
  // A read-only probe positively observed a logged-in session.
  READY: "ready",
  // A read-only probe observed a login wall. A human must log in.
  NEEDS_AUTH: "needs-auth",
  // The page could not be classified (drift / timeout / closed / unknown).
  INDETERMINATE: "indeterminate",
  // A session was READY and later observed to be logged out. Mid-task expiry.
  EXPIRED: "expired",
})

/** Human-facing next action. Every non-READY/IDLE state names exactly one. */
export const AUTH_NEXT_ACTION = Object.freeze({
  NONE: "none",
  LOG_IN: "run 'ues deepseek login --profile <name>' to sign in with a real browser window",
  RE_PROBE: "re-run the probe once the third-party UI settles",
  RESUME: "resume the task; the session was re-authenticated",
  LOG_IN_MID_TASK: "sign in again, then resume the saved task state",
})

/** Which states require the human to do something outside the runtime. */
export const HUMAN_ACTION_REQUIRED = Object.freeze({
  [AUTH_STATE.NEEDS_AUTH]: true,
  [AUTH_STATE.EXPIRED]: true,
})

/**
 * Classify a raw worker probe result into a canonical auth state.
 *
 * The mapping is FAIL-CLOSED: only an explicit recognized probe state maps to
 * READY. Anything unrecognized is INDETERMINATE. `previousState` lets an
 * expired-but-once-ready session be reported as EXPIRED rather than a plain
 * NEEDS_AUTH, which changes the recovery path (mid-task capsule vs first login).
 */
export function classifyLifecycleAuthState(observation = /** @type {any} */ ({}), options = /** @type {any} */ ({})) {
  const raw = String(observation?.state ?? "").toUpperCase()
  const previousState = options.previousState ?? AUTH_STATE.NOT_PROBED
  const wasReady = previousState === AUTH_STATE.READY || previousState === AUTH_STATE.EXPIRED

  if (raw === AUTH_PROBE_STATE.READY) {
    return {
      state: AUTH_STATE.READY,
      reason: String(observation?.reason || "composer-and-session-signal-present").slice(0, 160),
      url: observation?.url ?? null,
      humanActionRequired: false,
      nextAction: wasReady ? AUTH_NEXT_ACTION.RESUME : AUTH_NEXT_ACTION.NONE,
    }
  }
  if (raw === AUTH_PROBE_STATE.NEEDS_AUTH) {
    return {
      state: wasReady ? AUTH_STATE.EXPIRED : AUTH_STATE.NEEDS_AUTH,
      reason: String(observation?.reason || "login-wall-detected").slice(0, 160),
      url: observation?.url ?? null,
      humanActionRequired: true,
      nextAction: wasReady ? AUTH_NEXT_ACTION.LOG_IN_MID_TASK : AUTH_NEXT_ACTION.LOG_IN,
    }
  }
  // UI_CHANGED / TIMEOUT / UNKNOWN / anything unrecognized is INDETERMINATE.
  // A `tightened` option lets the caller opt into treating UNKNOWN as
  // NEEDS_AUTH for a fresh profile with no prior login, but the default is the
  // safe INDETERMINATE (never guess "logged in", never guess "log in").
  if (options.treatUnknownAsNeedsAuth === true && (raw === AUTH_PROBE_STATE.UNKNOWN || raw === AUTH_PROBE_STATE.UI_CHANGED)) {
    return {
      state: wasReady ? AUTH_STATE.EXPIRED : AUTH_STATE.NEEDS_AUTH,
      reason: `unknown-treated-as-needs-auth:${String(observation?.reason || "unknown").slice(0, 120)}`,
      url: observation?.url ?? null,
      humanActionRequired: true,
      nextAction: wasReady ? AUTH_NEXT_ACTION.LOG_IN_MID_TASK : AUTH_NEXT_ACTION.LOG_IN,
    }
  }
  return {
    state: AUTH_STATE.INDETERMINATE,
    reason: String(observation?.reason || "auth-probe-indeterminate").slice(0, 160),
    url: observation?.url ?? null,
    humanActionRequired: false,
    nextAction: AUTH_NEXT_ACTION.RE_PROBE,
  }
}

/**
 * Whether a run may CONTINUE using this auth state.
 *
 * Only READY continues. NEEDS_AUTH and EXPIRED stop and ask the human;
 * INDETERMINATE and NOT_PROBED stop and require a fresh probe. This is the
 * single gate the reasoner consults before it consults a provider.
 */
export function canContinueWithState(state) {
  if (state === AUTH_STATE.READY) return { continue: true, reason: "authenticated-session-ready" }
  if (state === AUTH_STATE.EXPIRED) return { continue: false, reason: "session-expired-mid-task", resumeRequired: true }
  if (state === AUTH_STATE.NEEDS_AUTH) return { continue: false, reason: "authentication-required" }
  if (state === AUTH_STATE.NOT_PROBED) return { continue: false, reason: "auth-not-probed" }
  return { continue: false, reason: "auth-indeterminate" }
}

/**
 * Decide what a run should do given a NOT-READY auth state and whether a task is
 * already in progress.
 *
 * Returns a bounded plan: a machine reason, the human action (if any), and a
 * boolean telling the caller whether to build a Resume Capsule. It NEVER
 * substitutes another account, and it NEVER falls back to a different profile.
 */
export function authRecoveryPlan(input = /** @type {any} */ ({})) {
  const state = String(input.state || AUTH_STATE.NOT_PROBED)
  const midTask = input.midTask === true
  const profile = String(input.profile ?? "").trim() || null
  const gate = canContinueWithState(state)
  if (gate.continue) {
    return {
      state,
      action: AUTH_NEXT_ACTION.NONE,
      humanActionRequired: false,
      needsResumeCapsule: false,
      substituteAccount: false,
      profile,
      reason: gate.reason,
    }
  }
  const needsHuman = HUMAN_ACTION_REQUIRED[state] === true
  const needsResumeCapsule = midTask && (state === AUTH_STATE.EXPIRED || state === AUTH_STATE.NEEDS_AUTH)
  return {
    state,
    action: needsHuman
      ? (midTask ? AUTH_NEXT_ACTION.LOG_IN_MID_TASK : AUTH_NEXT_ACTION.LOG_IN)
      : AUTH_NEXT_ACTION.RE_PROBE,
    humanActionRequired: needsHuman,
    needsResumeCapsule,
    // Explicit and false: the runtime must NEVER switch accounts to keep going.
    substituteAccount: false,
    profile,
    reason: gate.reason,
  }
}

// ---------------------------------------------------------------------------
// Bounded manual-auth wait (a PURE state machine over probe classifications).
//
// This composes with the existing V16.3 `waitForAuthenticatedPage` helper: that
// helper drives the browser probes, this function decides the policy over their
// results. Keeping the policy pure makes the whole login bound testable without
// a browser.
// ---------------------------------------------------------------------------

export const MANUAL_AUTH_WAIT_LIMIT = Object.freeze({
  minIntervalMs: 1_500,
  maxIntervalMs: 2_500,
  maxAttempts: 90,
  overallTimeoutMs: 180_000,
})

/**
 * Advance the manual-login wait by one probe.
 *
 * @returns {{state: string, terminal: boolean, humanActionRequired: boolean, action: string, reason: string}}
 */
export function nextManualAuthWait(input = /** @type {any} */ ({})) {
  const attempt = Math.max(1, Number(input.attempt) || 1)
  const elapsedMs = Math.max(0, Number(input.elapsedMs) || 0)
  const maxAttempts = Math.max(1, Number(input.maxAttempts) || MANUAL_AUTH_WAIT_LIMIT.maxAttempts)
  const overallTimeoutMs = Math.max(1_000, Number(input.overallTimeoutMs) || MANUAL_AUTH_WAIT_LIMIT.overallTimeoutMs)
  const observed = classifyLifecycleAuthState(input.observation || {}, { previousState: input.previousState || AUTH_STATE.NEEDS_AUTH })
  const base = { attempt, elapsedMs, state: observed.state, humanActionRequired: false, action: AUTH_NEXT_ACTION.LOG_IN, reason: observed.reason }

  // Infrastructure failures are terminal immediately: waiting longer on a dead
  // browser burns the whole allowance for nothing.
  if (input.navigationOk === false) {
    return { ...base, terminal: true, state: AUTH_STATE.INDETERMINATE, reason: "entry-navigation-failed" }
  }
  if (input.transportAlive === false || input.closed === true) {
    return { ...base, terminal: true, state: AUTH_STATE.INDETERMINATE, reason: "browser-closed-by-user-or-exit" }
  }

  if (observed.state === AUTH_STATE.READY) {
    return { ...base, terminal: true, humanActionRequired: false, action: AUTH_NEXT_ACTION.NONE, reason: "composer-positively-observed" }
  }
  if (observed.state === AUTH_STATE.EXPIRED || observed.state === AUTH_STATE.NEEDS_AUTH) {
    // Still not logged in yet. Keep waiting, bounded by both limits.
    if (attempt >= maxAttempts) {
      return { ...base, terminal: true, humanActionRequired: true, state: AUTH_STATE.NEEDS_AUTH, reason: "max-probes-reached" }
    }
    if (elapsedMs >= overallTimeoutMs) {
      return { ...base, terminal: true, humanActionRequired: true, state: AUTH_STATE.NEEDS_AUTH, reason: "wall-clock-bound-reached" }
    }
    return { ...base, terminal: false, humanActionRequired: true, state: AUTH_STATE.NEEDS_AUTH, reason: "waiting-for-login" }
  }
  // INDETERMINATE: the page is hydrating or drifting. Retry within the bound,
  // then report the honest indeterminate classification. Never convert to READY.
  if (attempt >= maxAttempts || elapsedMs >= overallTimeoutMs) {
    return { ...base, terminal: true, humanActionRequired: false, state: AUTH_STATE.INDETERMINATE, action: AUTH_NEXT_ACTION.RE_PROBE, reason: observed.reason }
  }
  return { ...base, terminal: false, humanActionRequired: false, action: AUTH_NEXT_ACTION.RE_PROBE, reason: observed.reason }
}

/** A bounded, content-free progress label for the manual-login wait. */
export function manualAuthProgressLabel(state, attempt, maxAttempts) {
  const total = Math.max(1, Number(maxAttempts) || MANUAL_AUTH_WAIT_LIMIT.maxAttempts)
  const n = String(Math.max(1, Number(attempt) || 1)).padStart(String(total).length, " ")
  if (state === AUTH_STATE.READY) return `probe ${n}/${total}: READY`
  if (state === AUTH_STATE.INDETERMINATE) return `probe ${n}/${total}: INDETERMINATE`
  return `probe ${n}/${total}: waiting-for-login`
}

/**
 * Map a session-expiry observation to a Resume-Capsule request.
 *
 * This is the MID-TASK path: the run was consulting, the session expired, and
 * the task must continue without losing state. The function returns a
 * deterministic, secret-free request the caller passes to the existing
 * `buildResumeCapsule`. It carries no credential and no transcript.
 */
export function expiryResumeRequest(input = /** @type {any} */ ({})) {
  const state = String(input.state || AUTH_STATE.EXPIRED)
  return {
    schemaVersion: DEEPSEEK_AUTH_SCHEMA_VERSION,
    policy: DEEPSEEK_AUTH_POLICY,
    kind: "deepseek-auth-expiry-resume",
    state,
    profile: String(input.profile ?? "").trim() || null,
    taskFingerprint: String(input.taskFingerprint ?? "").slice(0, 128),
    reason: String(input.reason || "session-expired-mid-task").slice(0, 160),
    resumeRequired: state === AUTH_STATE.EXPIRED || state === AUTH_STATE.NEEDS_AUTH,
    humanActionRequired: state === AUTH_STATE.EXPIRED || state === AUTH_STATE.NEEDS_AUTH,
    // Never carries a credential, a cookie, a token or a transcript.
    credentialFree: true,
  }
}

/**
 * The full, secret-free auth report for `ues deepseek status / doctor`. It
 * carries classifications and booleans only.
 */
export function buildAuthReport(input = /** @type {any} */ ({})) {
  const state = Object.values(AUTH_STATE).includes(input.state) ? input.state : AUTH_STATE.NOT_PROBED
  const gate = canContinueWithState(state)
  return {
    schemaVersion: DEEPSEEK_AUTH_SCHEMA_VERSION,
    policy: DEEPSEEK_AUTH_POLICY,
    readOnly: true,
    profile: String(input.profile ?? "").trim() || null,
    profileId: String(input.profileId ?? "").trim() || null,
    state,
    canContinue: gate.continue,
    reason: gate.reason,
    humanActionRequired: HUMAN_ACTION_REQUIRED[state] === true,
    nextAction: HUMAN_ACTION_REQUIRED[state] === true
      ? (input.midTask === true ? AUTH_NEXT_ACTION.LOG_IN_MID_TASK : AUTH_NEXT_ACTION.LOG_IN)
      : (state === AUTH_STATE.INDETERMINATE ? AUTH_NEXT_ACTION.RE_PROBE : AUTH_NEXT_ACTION.NONE),
    probe: input.probe
      ? {
          observedState: String(input.probe.state ?? "").slice(0, 40) || null,
          reason: String(input.probe.reason ?? "").slice(0, 160) || null,
          attempts: Number.isFinite(Number(input.probe.attempts)) ? Number(input.probe.attempts) : null,
        }
      : null,
    // Safety contract, asserted by tests and by the doctor.
    safety: {
      credentialRead: false,
      cookieOrStorageRead: false,
      credentialOutput: false,
      autofilledCredentials: false,
      solvedCaptcha: false,
      injectedOtp: false,
      substitutedAccount: false,
      promptSubmitted: false,
    },
  }
}

export const DEEPSEEK_AUTH_LIFECYCLE_EXPORTS = Object.freeze([
  "classifyLifecycleAuthState",
  "canContinueWithState",
  "authRecoveryPlan",
  "nextManualAuthWait",
  "manualAuthProgressLabel",
  "expiryResumeRequest",
  "buildAuthReport",
])
