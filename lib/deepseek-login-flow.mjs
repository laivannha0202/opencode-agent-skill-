// V16.7.1 Part 5: the REAL manual DeepSeek login flow.
//
// `ues deepseek login --profile <name>` opens a HEADED, PERSISTENT browser and
// waits, bounded, for the human to sign in. This module owns the flow policy so
// the CLI and the tests exercise the SAME logic; the CLI only spawns the worker
// and prints the report.
//
// Absolute safety contract (enforced here and asserted by tests):
//
//   * The flow NEVER reads, fills, types, stores, prints or transmits a
//     password, a cookie, a token, an OTP, a CAPTCHA answer or a storageState.
//   * The flow NEVER clicks "Sign in", NEVER submits a form and NEVER switches
//     the active profile.
//   * The ONLY page evidence it consumes is the READ-ONLY `authProbe`
//     classification (a state + a reason). No page text, account name, input
//     value or DOM content is read by this module.
//   * The wait is BOUNDED in both probe count and wall clock. An incomplete
//     login is reported as HUMAN_ACTION_REQUIRED, never as success.
//   * The persistent profile is closed cleanly so the session it established
//     survives on disk for the next live run.

import {
  AUTH_STATE,
  MANUAL_AUTH_WAIT_LIMIT,
  manualAuthProgressLabel,
  nextManualAuthWait,
} from "./deepseek-auth-lifecycle.mjs"

export const DEEPSEEK_LOGIN_SCHEMA_VERSION = 1
export const DEEPSEEK_LOGIN_POLICY = "deepseek-manual-login-v16-7-1"

// Default per-probe timeout. Bounded and independent of the wait loop so one
// slow probe cannot consume the whole manual-login allowance.
const DEFAULT_PROBE_TIMEOUT_MS = 20_000

/** The only outcomes the CLI may branch on. */
export const LOGIN_OUTCOME = Object.freeze({
  // The human signed in and a real READ-ONLY probe positively observed it.
  AUTH_READY: "AUTH_READY",
  // The login did not complete within the bound; the human must act.
  HUMAN_ACTION_REQUIRED: "HUMAN_ACTION_REQUIRED",
  // Playwright / the managed worker could not start.
  BROWSER_UNAVAILABLE: "BROWSER_UNAVAILABLE",
  // The human closed the headed window before signing in.
  BROWSER_CLOSED: "BROWSER_CLOSED",
  // The session was READY and the chat UI then stopped resolving (drift).
  UI_CHANGED: "UI_CHANGED",
  // The entry page could not be opened at all.
  NAVIGATION_FAILED: "NAVIGATION_FAILED",
})

/**
 * The one secret-free safety block every login report carries. Tests assert
 * every flag is false: the flow has no code path that could set one true.
 */
export function loginSafetyContract() {
  return Object.freeze({
    passwordRead: false,
    passwordFilled: false,
    passwordLogged: false,
    cookieRead: false,
    tokenRead: false,
    otpRead: false,
    captchaSolved: false,
    storageStateRead: false,
    storageStateWritten: false,
    formSubmitted: false,
    signInClicked: false,
    profileSwitched: false,
    pageTextRead: false,
    accountTextRead: false,
  })
}

/**
 * Run the bounded manual login over an ALREADY-STARTED worker.
 *
 * The caller owns the worker lifecycle (spawn + close) so a test can drive this
 * with a fake worker and the CLI can drive it with the real managed browser.
 *
 * @param {Record<string, any>} input
 *   worker        - a browser-worker client (capability/invoke/authProbe/close)
 *   entryUrl      - the page to open (default the DeepSeek chat entry)
 *   limits        - { maxAttempts, overallTimeoutMs, intervalMs, probeTimeoutMs }
 *   sleep         - injectable sleep (defaults to setTimeout)
 *   now           - injectable clock
 *   onLog         - progress callback receiving a bounded, content-free label
 * @returns {Promise<Record<string, any>>} a secret-free report
 */
export async function runManualLogin(input = /** @type {any} */ ({})) {
  const worker = input.worker
  const entryUrl = String(input.entryUrl || "https://chat.deepseek.com/")
  const limits = {
    maxAttempts: boundedInt(input.limits?.maxAttempts, MANUAL_AUTH_WAIT_LIMIT.maxAttempts, 1, 300),
    overallTimeoutMs: boundedInt(input.limits?.overallTimeoutMs, MANUAL_AUTH_WAIT_LIMIT.overallTimeoutMs, 1_000, 30 * 60 * 1000),
    intervalMs: boundedInt(input.limits?.intervalMs, MANUAL_AUTH_WAIT_LIMIT.minIntervalMs, 0, 10_000),
    probeTimeoutMs: boundedInt(input.limits?.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 500, 60_000),
  }
  const sleepImpl = typeof input.sleep === "function" ? input.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const nowImpl = typeof input.now === "function" ? input.now : Date.now
  const onLog = typeof input.onLog === "function" ? input.onLog : null
  const profile = String(input.profile || "").trim() || null

  const base = () => ({
    schemaVersion: DEEPSEEK_LOGIN_SCHEMA_VERSION,
    policy: DEEPSEEK_LOGIN_POLICY,
    profile,
    entryUrl,
    credentialFree: true,
    safety: loginSafetyContract(),
  })
  // Every outcome is a secret-free report. `humanActionRequired` is TRUE for
  // anything that is not a positively observed READY session: an incomplete
  // login must never be reported as success.
  const emit = (outcome, extra = {}) => ({
    ...base(),
    ...extra,
    outcome,
    humanActionRequired: outcome !== LOGIN_OUTCOME.AUTH_READY,
  })
  if (!worker || typeof worker.capability !== "function") {
    return emit(LOGIN_OUTCOME.BROWSER_UNAVAILABLE, { reason: "no-managed-browser-worker", attempts: 0, elapsedMs: 0 })
  }

  // 1. Capability gate: the browser must be interactive, or the human has
  //    nothing to sign in with. A non-interactive lane is reported honestly.
  let capability = null
  try {
    capability = await worker.capability()
  } catch (error) {
    return emit(LOGIN_OUTCOME.BROWSER_UNAVAILABLE, { reason: `capability-threw:${short(error)}`, attempts: 0, elapsedMs: 0 })
  }
  if (capability?.state !== "ready" || capability?.interactive !== true) {
    return emit(LOGIN_OUTCOME.BROWSER_UNAVAILABLE, {
      reason: capability?.reason || "managed-browser-not-interactive",
      playwright: capability?.playwright ?? null,
      attempts: 0,
      elapsedMs: 0,
    })
  }

  // 2. Open the entry page ONCE. A real navigation failure is a hard failure,
  //    distinct from "you did not log in yet".
  let opened = null
  try {
    opened = await worker.invoke("navigate", { url: entryUrl, waitUntil: "domcontentloaded" })
  } catch (error) {
    return emit(LOGIN_OUTCOME.NAVIGATION_FAILED, { reason: `navigate-threw:${short(error)}`, attempts: 0, elapsedMs: 0 })
  }
  if (!opened?.ok) {
    return emit(LOGIN_OUTCOME.NAVIGATION_FAILED, { reason: opened?.error || "entry-navigation-failed", attempts: 0, elapsedMs: 0 })
  }

  // 3. Bounded manual-login observation. Each probe is READ-ONLY; the loop is
  //    capped by BOTH probe count and wall clock (the pure policy lives in the
  //    auth lifecycle so the bound is testable without a browser).
  const startedAt = Number(nowImpl()) || 0
  let attempt = 0
  let sawReady = false
  /** @type {any} */
  let closeEvent = null
  const offClose = typeof worker.onClose === "function"
    ? worker.onClose((event) => { closeEvent = event })
    : () => null

  try {
    while (true) {
      attempt += 1
      // Liveness: a window the human closed is terminal, not "still waiting".
      if (closeEvent !== null || (typeof worker.isAlive === "function" && worker.isAlive() === false)) {
        return emit(LOGIN_OUTCOME.BROWSER_CLOSED, {
          reason: closeEvent?.reason || "browser-closed-by-user-or-exit",
          attempts: attempt,
          elapsedMs: Math.max(0, Number(nowImpl() - startedAt) || 0),
        })
      }

      /** @type {any} */
      let observation = null
      try {
        observation = await worker.authProbe({ timeoutMs: limits.probeTimeoutMs })
      } catch (error) {
        observation = { state: "UNKNOWN", reason: `auth-probe-threw:${short(error)}` }
      }

      const elapsedMs = Math.max(0, Number(nowImpl() - startedAt) || 0)
      const step = nextManualAuthWait({
        attempt,
        elapsedMs,
        maxAttempts: limits.maxAttempts,
        overallTimeoutMs: limits.overallTimeoutMs,
        observation,
        previousState: sawReady ? AUTH_STATE.READY : AUTH_STATE.NEEDS_AUTH,
        navigationOk: true,
        transportAlive: typeof worker.isAlive === "function" ? worker.isAlive() !== false : true,
        closed: closeEvent !== null,
      })
      if (onLog) onLog(manualAuthProgressLabel(step.state, attempt, limits.maxAttempts))

      if (step.state === AUTH_STATE.READY) {
        sawReady = true
        return emit(LOGIN_OUTCOME.AUTH_READY, {
          authState: AUTH_STATE.READY,
          reason: step.reason,
          attempts: attempt,
          elapsedMs,
          bound: `${limits.maxAttempts} probes / ${limits.overallTimeoutMs}ms`,
        })
      }

      if (step.terminal === true) {
        // Terminal non-READY. If the session was ever READY this is UI drift,
        // otherwise the human simply did not finish signing in.
        const outcome = sawReady ? LOGIN_OUTCOME.UI_CHANGED : LOGIN_OUTCOME.HUMAN_ACTION_REQUIRED
        return emit(outcome, {
          authState: step.state,
          reason: step.reason,
          attempts: attempt,
          elapsedMs,
          bound: `${limits.maxAttempts} probes / ${limits.overallTimeoutMs}ms`,
        })
      }

      await sleepImpl(limits.intervalMs)
    }
  } finally {
    try { offClose() } catch {}
  }
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function short(error) {
  return String(error?.message || error || "").slice(0, 160)
}

export const DEEPSEEK_LOGIN_FLOW_EXPORTS = Object.freeze([
  "runManualLogin",
  "loginSafetyContract",
  "LOGIN_OUTCOME",
])
