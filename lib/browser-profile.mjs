// V16.3 LIVE DeepSeek: the managed browser profile.
//
// A live consultation against a third-party web UI needs a browser that stays
// logged in between runs, which means a PERSISTENT PROFILE. Three properties
// make that acceptable to ship:
//
//   1. The profile lives OUTSIDE the repository, in the UES config dir
//      (`~/.config/ues/browser-profiles/<name>`). It is never inside the project,
//      so it can never be committed, diffed, or swept into a workspace snapshot.
//   2. Nothing is ever READ OUT of it. This module resolves a directory and
//      reports metadata about it. There is no code path here that opens a
//      cookie jar, a storage state file, or a token store, because reading one
//      would turn "the user's browser is logged in" into "the runtime holds the
//      user's credentials".
//   3. Normal CI never touches it. `profileForMode` returns `null` unless a live
//      mode was explicitly requested AND a profile name was supplied, so the
//      deterministic tests and the default smoke run use an ephemeral context.

import { existsSync, statSync } from "node:fs"
import path from "node:path"

import { getUesConfigDir } from "./runtime-config.mjs"

export const BROWSER_PROFILE_MODES = Object.freeze({
  EPHEMERAL: "ephemeral",
  PERSISTENT: "persistent",
})

export const BROWSER_PROFILE_REASON = Object.freeze({
  NOT_LIVE: "not-a-live-mode",
  NO_NAME: "no-profile-name-supplied",
  DISABLED: "persistent-profile-disabled",
  RESOLVED: "persistent-profile-resolved",
})

/** Default profile name for the DeepSeek Web lane. */
export const DEEPSEEK_PROFILE_NAME = "deepseek-web"

export function browserProfilesRoot(configDir = getUesConfigDir()) {
  return path.join(path.resolve(String(configDir || "")), "browser-profiles")
}

/**
/**
 * Resolves the profile directory for a mode.
 *
 * Returns `{ mode, userDataDir, reason }`. `userDataDir` is null for an
 * ephemeral context, which is the ONLY kind CI ever creates.
*/
export function profileForMode(options = {}) {
  const live = options.live === true
  const name = String(options.profile || "").trim()
  const disabled = options.persistent === false || String(process.env.UES_BROWSER_PERSISTENT_PROFILE || "1") === "0"

  if (!live) {
    return { mode: BROWSER_PROFILE_MODES.EPHEMERAL, userDataDir: null, reason: BROWSER_PROFILE_REASON.NOT_LIVE }
  }
  if (!name) {
    return { mode: BROWSER_PROFILE_MODES.EPHEMERAL, userDataDir: null, reason: BROWSER_PROFILE_REASON.NO_NAME }
  }
  if (disabled) {
    return { mode: BROWSER_PROFILE_MODES.EPHEMERAL, userDataDir: null, reason: BROWSER_PROFILE_REASON.DISABLED }
  }
  const root = browserProfilesRoot(options.configDir)
  const userDataDir = path.join(root, safeProfileName(name))
  return {
    mode: BROWSER_PROFILE_MODES.PERSISTENT,
    userDataDir,
    root,
    reason: BROWSER_PROFILE_REASON.RESOLVED,
    // Metadata only. The directory's contents are never opened here.
    exists: safeIsDirectory(userDataDir),
  }
}

/**
 * Profile names become directory names, so they are restricted to a
 * conservative character set. A traversal attempt degrades to a hashed name
 * instead of escaping the profiles root.
 */
export function safeProfileName(name) {
  const raw = String(name || "").trim()
  if (!raw) return "default"
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw) && !raw.includes("..")) return raw
  return `p-${createHashFallback(raw)}`
}

function createHashFallback(value) {
  // Local, dependency-free and deterministic. Deliberately not `node:crypto`:
  // this module is imported by the worker entry point, which must stay
  // importable in a browserless environment.
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function safeIsDirectory(target) {
  try {
    return existsSync(target) && statSync(target).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Auth probe (DOM / URL evidence only)
// ---------------------------------------------------------------------------

export const AUTH_PROBE_STATE = Object.freeze({
  READY: "READY",
  NEEDS_AUTH: "NEEDS_AUTH",
  UI_CHANGED: "UI_CHANGED",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN",
})

// Signals are evaluated in this order. A login wall is the strongest negative:
// if the URL or the page says "sign in", nothing else can make the session ready.
const LOGIN_URL = /(?:^|\/)(?:login|signin|sign-in|auth|passport)(?:[/?#]|$)/i;
const LOGIN_PATH = /\/login|\/signin|\/sign_in|\/passport\/|\/account\/login/i;
const CHALLENGE_MARKERS =
  /(?:sign in|log in|login to continue|please (?:log|sign) ?in|unauthorized|401|session expired|verification code|captcha|完成验证|请登录|登录后)/i;

/**
 * Classifies auth state from observed page evidence.
 *
 * This is a PURE function over observations so it is exhaustively testable and
 * can never "remember" that it was told the user is logged in. There is no
 * `authenticated: true` shortcut anywhere: the answer comes from the URL and
 * from page text the worker actually read.
 */
export function classifyAuthState(observations = {}) {
  const url = String(observations.url || "");
  const text = String(observations.text || "");
  const composerVisible = observations.composerVisible === true;
  const answerRegions = Number(observations.answerRegions || 0);
  // Read-only account affordance: avatar, user menu, settings/account entry.
  const accountSignal = observations.accountSignal === true;

  if (observations.timedOut === true) {
    return { state: AUTH_PROBE_STATE.TIMEOUT, reason: "auth-probe-timed-out", url: url || null }
  }

  const loginEvidence =
    LOGIN_PATH.test(url) ||
    LOGIN_URL.test(url) ||
    (!composerVisible && CHALLENGE_MARKERS.test(text));
  if (loginEvidence) {
    return {
      state: AUTH_PROBE_STATE.NEEDS_AUTH,
      reason: !composerVisible && CHALLENGE_MARKERS.test(text)
        ? "login-wall-detected-in-page-text"
        : "login-url-detected",
      url: url || null,
    }
  }

  if (composerVisible) {
    // A composer alone is NOT proof of an authenticated session. Observed live:
    // the logged-out landing page renders a full prompt box ("Whenever you're
    // ready") with zero assistant answer regions, which the previous rule
    // reported as READY on probe 1. Submitting there lands on a login wall.
    //
    // READY therefore requires POSITIVE session evidence: an existing
    // conversation with assistant answers, or an account affordance on the page.
    const sessionSignal = accountSignal === true || answerRegions > 0;
    if (!sessionSignal) {
      return {
        state: AUTH_PROBE_STATE.UNKNOWN,
        reason: "composer-visible-but-no-session-signal",
        url: url || null,
        answerRegions,
      };
    }
    return {
      state: AUTH_PROBE_STATE.READY,
      reason: answerRegions > 0 ? "composer-and-answer-region-present" : "composer-and-account-signal-present",
      url: url || null,
      answerRegions,
    };
  }

  if (!url) {
    return { state: AUTH_PROBE_STATE.UNKNOWN, reason: "no-url-observed", url: null }
  }
  return {
    state: AUTH_PROBE_STATE.UI_CHANGED,
    reason: "page-loaded-but-no-known-composer-found",
    url: url || null,
    answerRegions,
  }
}

// ---------------------------------------------------------------------------
// Manual-auth wait state machine (V16.3 live hardening)
//
// This is the bug that motivated the section. In MANUAL AUTH MODE the browser is
// headed and a HUMAN is driving: the page legitimately has no prompt composer
// until they have finished logging in. Treating "composer absent" as a terminal
// UI_CHANGED therefore killed the wait on probe 1, before the user had time to
// type anything.
//
// The rule the state machine encodes:
//
//   - A missing composer alone is PENDING_AUTH, never terminal. There is no
//     positive evidence of breakage in that condition.
//   - UI_CHANGED becomes terminal only AFTER a READY has been observed. "The page
//     loaded, you were logged in, and now the expected UI cannot be resolved" is
//     positive evidence of breakage; "the page loaded and you have not logged in
//     yet" is not.
//   - Every exit is bounded by BOTH probe count and wall clock.
//
// It is a pure function so the whole machine is testable without a browser.
// ---------------------------------------------------------------------------

export const AUTH_WAIT_STATE = Object.freeze({
  PENDING: "PENDING_AUTH",
  READY: "READY",
  TIMEOUT: "TIMEOUT",
  BROWSER_CLOSED: "BROWSER_CLOSED",
  HARD_NAVIGATION_FAILURE: "HARD_NAVIGATION_FAILURE",
  UI_CHANGED: "UI_CHANGED",
})

export const AUTH_WAIT_REASON = Object.freeze({
  WAITING: "waiting-for-login",
  READY_COMPOSER: "composer-positively-observed",
  READY_AFTER_PENDING: "composer-observed-after-pending",
  BROWSER_CLOSED: "browser-closed-by-user-or-exit",
  NAVIGATION_FAILED: "entry-navigation-failed",
  PROBE_UNAVAILABLE: "auth-probe-unavailable",
  MAX_PROBES: "max-probes-reached",
  WALL_CLOCK: "wall-clock-bound-reached",
  UI_CHANGED_AFTER_READY: "authenticated-page-loaded-but-ui-unresolvable",
})

export const AUTH_WAIT_LIMIT = Object.freeze({
  intervalMs: 2_000,
  minIntervalMs: 1_500,
  maxIntervalMs: 2_500,
  maxAttempts: 90,
  overallTimeoutMs: 180_000,
  probeTimeoutMs: 20_000,
})

export function terminalAuthWaitState(state) {
  return state !== AUTH_WAIT_STATE.PENDING;
}

/**
 * Advance the wait state machine by exactly one probe.
 *
 * @param {Record<string, any>} input one probe's worth of evidence plus bounds
 * @returns {{state: string, terminal: boolean, reason: string, next: string|null}}
 */
export function nextAuthWaitState(input = /** @type {any} */ ({})) {
  const opts = /** @type {any} */ (input);
  const observation = opts.observation ? String(opts.observation) : null;
  const attempt = Math.max(1, Number(opts.attempt) || 1);
  const elapsedMs = Math.max(0, Number(opts.elapsedMs) || 0);
  const maxAttempts = Math.max(1, Number(opts.maxAttempts) || AUTH_WAIT_LIMIT.maxAttempts);
  const overallTimeoutMs = Math.max(1_000, Number(opts.overallTimeoutMs) || AUTH_WAIT_LIMIT.overallTimeoutMs);
  const seenReady = opts.seenReady === true;

  const base = { attempt, elapsedMs, state: AUTH_WAIT_STATE.PENDING, terminal: false, reason: AUTH_WAIT_REASON.WAITING, next: null };

  // Terminal-infrastructure states are checked FIRST: they are unambiguous, and
  // answering "waiting" to a dead browser would burn the whole budget for nothing.
  if (opts.navigationOk === false) {
    return { ...base, state: AUTH_WAIT_STATE.HARD_NAVIGATION_FAILURE, terminal: true, reason: AUTH_WAIT_REASON.NAVIGATION_FAILED };
  }
  if (opts.transportAlive === false) {
    return { ...base, state: AUTH_WAIT_STATE.BROWSER_CLOSED, terminal: true, reason: opts.closeReason || AUTH_WAIT_REASON.BROWSER_CLOSED };
  }
  if (!observation) {
    return { ...base, terminal: true, state: AUTH_WAIT_STATE.BROWSER_CLOSED, reason: AUTH_WAIT_REASON.PROBE_UNAVAILABLE };
  }

  if (observation === AUTH_PROBE_STATE.READY) {
    return {
      ...base,
      state: AUTH_WAIT_STATE.READY,
      terminal: true,
      // Distinguishes "the profile was already logged in" (READY on probe 1)
      // from "the user logged in during this run" (READY after a pending wait),
      // which is the difference between a working profile and a fresh login.
      reason: seenReady || attempt === 1
        ? AUTH_WAIT_REASON.READY_COMPOSER
        : AUTH_WAIT_REASON.READY_AFTER_PENDING,
    };
  }

  // A composer is absent. That is the expected condition for the whole manual
  // login, so it stays PENDING -- unless we have already proven the session is
  // authenticated, in which case the missing UI is real drift.
  if (observation === AUTH_PROBE_STATE.UI_CHANGED) {
    if (seenReady) {
      return { ...base, state: AUTH_WAIT_STATE.UI_CHANGED, terminal: true, reason: AUTH_WAIT_REASON.UI_CHANGED_AFTER_READY };
    }
    return { ...base, state: AUTH_WAIT_STATE.PENDING, reason: AUTH_WAIT_REASON.WAITING };
  }

  // NEEDS_AUTH, TIMEOUT and UNKNOWN are all "not logged in yet".
  if (attempt >= maxAttempts) {
    return { ...base, state: AUTH_WAIT_STATE.TIMEOUT, terminal: true, reason: AUTH_WAIT_REASON.MAX_PROBES };
  }
  if (elapsedMs >= overallTimeoutMs) {
    return { ...base, state: AUTH_WAIT_STATE.TIMEOUT, terminal: true, reason: AUTH_WAIT_REASON.WALL_CLOCK };
  }
  return { ...base };
}

/**
 * Human-readable progress label. It carries NO page content: the operator already
 * has the window in front of them, and echoing page text into CI logs would leak
 * whatever the third-party page happened to contain.
 */
export function authWaitProgressLabel(state, attempt, maxAttempts) {
  const total = Math.max(1, Number(maxAttempts) || AUTH_WAIT_LIMIT.maxAttempts);
  const n = String(Math.max(1, Number(attempt) || 1)).padStart(String(total).length, " ");
  switch (state) {
    case AUTH_WAIT_STATE.READY: return `probe ${n}/${total}: READY`;
    case AUTH_WAIT_STATE.TIMEOUT: return `probe ${n}/${total}: TIMEOUT`;
    case AUTH_WAIT_STATE.BROWSER_CLOSED: return `probe ${n}/${total}: BROWSER_CLOSED`;
    case AUTH_WAIT_STATE.HARD_NAVIGATION_FAILURE: return `probe ${n}/${total}: HARD_NAVIGATION_FAILURE`;
    case AUTH_WAIT_STATE.UI_CHANGED: return `probe ${n}/${total}: UI_CHANGED`;
    default: return `probe ${n}/${total}: waiting-for-login`;
  }
}

// The read-only probe script. It is a fixed function evaluated IN the page: it
// reads a DOM snapshot and returns. It performs no action, clicks nothing, and
// returns no cookie, token, storage or header value.
export function authProbeScript(options = {}) {
  const selectors = Array.isArray(options.answerSelectors) ? options.answerSelectors : [];
  const composerSelector = String(options.composerSelector || "");
  return `(() => {
    const visible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };
    const composerSelectors = ${JSON.stringify([composerSelector, 'textarea', '[contenteditable="true"]', 'input[type="text"]'].filter(Boolean))};
    let composerVisible = false;
    for (const selector of composerSelectors) {
      try {
        const nodes = Array.from(document.querySelectorAll(selector));
        if (nodes.some(visible)) { composerVisible = true; break; }
      } catch {}
    }
    const answerSelectors = ${JSON.stringify(selectors)};
    let answerRegions = 0;
    for (const selector of answerSelectors) {
      try { answerRegions += document.querySelectorAll(selector).length; } catch {}
    }
    // Account affordances. Read-only: the script checks for PRESENCE of a
    // visible element and never reads its contents.
    const accountSelectors = [
      "[data-testid*='avatar' i]",
      "[class*='avatar' i]",
      "[aria-label*='profile' i]",
      "[aria-label*='account' i]",
      "[data-testid*='user' i]",
      "[class*='user-menu' i]",
      "[class*='userMenu' i]",
      "button[aria-haspopup='menu']",
    ];
    let accountSignal = false;
    for (const selector of accountSelectors) {
      try { if (Array.from(document.querySelectorAll(selector)).some(visible)) { accountSignal = true; break; } } catch {}
    }
    return {
      url: String(location.href || ""),
      title: String(document.title || ""),
      // Body text only, and only the first slice. No input values, no storage.
      text: String(document.body && document.body.innerText || "").slice(0, 3000),
      composerVisible,
      answerRegions,
      accountSignal,
    };
  })()`;
}