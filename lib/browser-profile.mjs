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
    return {
      state: AUTH_PROBE_STATE.READY,
      reason: answerRegions > 0 ? "composer-and-answer-region-present" : "composer-present",
      url: url || null,
      answerRegions,
    }
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

/**
 * The read-only probe script. It is a fixed function evaluated IN the page: it
 * reads a DOM snapshot and returns. It performs no action, clicks nothing, and
 * returns no cookie, token, storage or header value.
 */
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
    return {
      url: String(location.href || ""),
      title: String(document.title || ""),
      // Body text only, and only the first slice. No input values, no storage.
      text: String(document.body && document.body.innerText || "").slice(0, 3000),
      composerVisible,
      answerRegions,
    };
  })()`;
}