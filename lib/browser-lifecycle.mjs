// V16.3 Phase A, steps 6 and 11: navigation lifecycle and session hygiene.
//
// Two failure modes this file exists to remove:
//
//   1. One timeout for everything. A 45s tool timeout that doubles as the
//      navigation timeout and the session ceiling kills a legitimately slow page
//      load while a fast failing click is allowed to hang. So the five timeouts
//      are separate, clamped, and each is derived from the action class rather
//      than from a caller's guess.
//   2. Zombie browsers. A session that leaked on timeout, abort, or thrown error
//      leaves Chromium processes behind on every platform and a full tree on
//      Windows. `closeBrowserSession` is therefore idempotent, best-effort at
//      each step, and is designed to be called from a `finally`.

import { createAdaptiveDeadline } from "./activity-deadline.mjs"
import { readdir } from "node:fs/promises"
import { safeRemovePath } from "./fs-cleanup.mjs"
import { BROWSER_NAVIGATION_WAIT_UNTIL, classifyBrowserAction } from "./browser-action-taxonomy.mjs"
import { terminateProcessTree } from "./process-supervisor.mjs"

export const BROWSER_NAVIGATION_KIND = Object.freeze({
  REDIRECT: "redirect",
  DOCUMENT: "document-load",
  SPA: "spa-navigation",
  NONE: "no-navigation",
})

export const BROWSER_WAIT_UNTIL = BROWSER_NAVIGATION_WAIT_UNTIL

export const BROWSER_TIMEOUTS = Object.freeze({
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  waitTimeoutMs: 5_000,
  browserToolTimeoutMs: 45_000,
  sessionTimeoutMs: 300_000,
})

export const BROWSER_TIMEOUT_BOUND = Object.freeze({
  navigationTimeoutMs: [1_000, 180_000],
  actionTimeoutMs: [500, 120_000],
  waitTimeoutMs: [100, 60_000],
  browserToolTimeoutMs: [1_000, 600_000],
  sessionTimeoutMs: [5_000, 7_200_000],
})

function clamp(name, value) {
  const [min, max] = BROWSER_TIMEOUT_BOUND[name]
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return BROWSER_TIMEOUTS[name]
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

// `browserToolTimeoutMs` is an outer envelope, not a knob for the others: it must
// always be able to contain one action plus its navigation budget, otherwise the
// tool-level kill would fire before the more specific timeout the action was
// given. Raising one timeout therefore raises the envelope automatically.
export function resolveBrowserTimeouts(input = {}) {
  const navigationTimeoutMs = clamp("navigationTimeoutMs", input.navigationTimeoutMs ?? BROWSER_TIMEOUTS.navigationTimeoutMs)
  const actionTimeoutMs = clamp("actionTimeoutMs", input.actionTimeoutMs ?? BROWSER_TIMEOUTS.actionTimeoutMs)
  const waitTimeoutMs = clamp("waitTimeoutMs", input.waitTimeoutMs ?? BROWSER_TIMEOUTS.waitTimeoutMs)
  const sessionTimeoutMs = clamp("sessionTimeoutMs", input.sessionTimeoutMs ?? BROWSER_TIMEOUTS.sessionTimeoutMs)
  const requestedTool = clamp("browserToolTimeoutMs", input.browserToolTimeoutMs ?? BROWSER_TIMEOUTS.browserToolTimeoutMs)
  const floor = navigationTimeoutMs + actionTimeoutMs + 1_000
  const browserToolTimeoutMs = Math.max(requestedTool, Math.min(floor, BROWSER_TIMEOUT_BOUND.browserToolTimeoutMs[1]))
  return {
    navigationTimeoutMs,
    actionTimeoutMs,
    waitTimeoutMs,
    browserToolTimeoutMs,
    sessionTimeoutMs,
    source: "browser-action-lifecycle",
  }
}

export function resolveWaitUntil(input = {}) {
  const explicit = String(input.waitUntil || "").trim()
  if (explicit && Object.hasOwn(BROWSER_NAVIGATION_WAIT_UNTIL, explicit.toUpperCase())) {
    const key = explicit.toUpperCase().replace(/-/g, "_")
    if (Object.hasOwn(BROWSER_NAVIGATION_WAIT_UNTIL, key)) return BROWSER_NAVIGATION_WAIT_UNTIL[key]
  }
  const taxonomy = input.taxonomy || classifyBrowserAction({ action: input.action })
  return taxonomy.waitUntil || BROWSER_NAVIGATION_WAIT_UNTIL.NONE
}

function normalizeUrl(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  try {
    return new URL(raw).toString()
  } catch {
    return null
  }
}

// Redirect, document load, SPA transition and no-navigation are four different
// observations. Collapsing them into `navigated: true` is what lets a "no
// navigation expected" action look like a successful one.
export function classifyNavigationEvent(input = {}) {
  const beforeUrl = normalizeUrl(input.beforeUrl)
  const afterUrl = normalizeUrl(input.afterUrl)
  const waitUntil = String(input.waitUntil || BROWSER_NAVIGATION_WAIT_UNTIL.NONE)
  const loadState = String(input.loadState || "").trim().toLowerCase()
  const documentChanged = input.documentChanged === true
  const urlChanged = Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl)
  const durationMs = Math.max(0, Math.round(Number(input.durationMs) || 0))

  if (waitUntil === BROWSER_NAVIGATION_WAIT_UNTIL.NONE) {
    return {
      schemaVersion: 1,
      kind: BROWSER_NAVIGATION_KIND.NONE,
      observed: documentChanged,
      navigated: false,
      urlChanged,
      redirected: false,
      beforeUrl,
      afterUrl,
      loadState: loadState || null,
      durationMs,
      reason: "no-navigation-expected-for-action",
    }
  }

  if (urlChanged) {
    return {
      schemaVersion: 1,
      kind: BROWSER_NAVIGATION_KIND.DOCUMENT,
      observed: true,
      navigated: true,
      urlChanged: true,
      redirected: input.redirected === true,
      beforeUrl,
      afterUrl,
      loadState: loadState || null,
      durationMs,
      reason: input.redirected === true ? "redirect-then-document-load" : "document-load",
    }
  }

  if (waitUntil === BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION) {
    return {
      schemaVersion: 1,
      kind: BROWSER_NAVIGATION_KIND.SPA,
      observed: input.spaSignal === true || documentChanged,
      navigated: true,
      urlChanged,
      redirected: false,
      beforeUrl,
      afterUrl,
      loadState: loadState || null,
      durationMs,
      reason: "spa-navigation-signal",
    }
  }

  return {
    schemaVersion: 1,
    kind: BROWSER_NAVIGATION_KIND.DOCUMENT,
    observed: documentChanged || loadState.length > 0,
    navigated: false,
    urlChanged: false,
    redirected: false,
    beforeUrl,
    afterUrl,
    loadState: loadState || null,
    durationMs,
    reason: "lifecycle-reached-without-url-change",
  }
}

export const BROWSER_SESSION_LIMIT = Object.freeze({
  maxActionsPerSession: 200,
  maxSessionMs: 300_000,
  maxReusedSessions: 1,
})

// A bounded session. `reuseCount` is what stops a long task from quietly opening
// a fresh browser per step, and the absolute deadline is what stops a session
// from living forever even when it is being actively used.
export function createBrowserSession(options = {}, startedAt = Date.now()) {
  const timeouts = resolveBrowserTimeouts(options)
  const maxActions = Math.max(1, Math.min(2_000, Number(options.maxActionsPerSession) || BROWSER_SESSION_LIMIT.maxActionsPerSession))
  const maxSessionMs = Math.max(1_000, Math.min(3_600_000, Number(options.maxSessionMs) || timeouts.sessionTimeoutMs))
  const deadline = createAdaptiveDeadline(
    {
      hardTimeoutMs: maxSessionMs,
      absoluteHardTimeoutMs: maxSessionMs,
      activityExtensionMs: 0,
    },
    startedAt,
  )
  const state = {
    schemaVersion: 1,
    kind: "ues-browser-session",
    id: String(options.sessionId || `bs-${startedAt.toString(36)}`),
    startedAt,
    lastActivityAt: startedAt,
    actions: 0,
    reused: 0,
    closed: false,
    maxActionsPerSession: maxActions,
    maxSessionMs,
    timeouts,
  }
  return {
    ...state,
    // Exposed so `shouldAbortBrowserSession(session)` sees the same absolute
    // ceiling the session was built with, rather than falling back to a
    // re-derived approximation.
    deadline,
    get actions() { return state.actions },
    get reused() { return state.reused },
    get closed() { return state.closed },
    beginAction(now = Date.now()) {
      const gate = shouldAbortBrowserSession(this, now)
      if (gate.abort) {
        return { ok: false, abort: true, reason: gate.reason, action: Number(gate.action) || 0 }
      }
      state.actions += 1
      state.lastActivityAt = now
      return { ok: true, abort: false, reason: null, action: state.actions, sessionTimeoutMs: state.maxSessionMs }
    },
    markReused() {
      state.reused += 1
      return state.reused
    },
    close() {
      state.closed = true
      return state.closed
    },
  }
}

export function shouldAbortBrowserSession(session, now = Date.now()) {
  const row = session && typeof session === "object" ? session : {}
  if (row.closed === true) {
    return { abort: true, reason: "session-closed", action: Number(row.actions) || 0 }
  }
  if (Number(row.actions || 0) >= Number(row.maxActionsPerSession || 0)) {
    return { abort: true, reason: "session-action-budget-exhausted", action: Number(row.actions) || 0 }
  }
  const deadline = row.deadline
  if (deadline && typeof deadline.shouldAbort === "function") {
    return deadline.shouldAbort(now, row.lastActivityAt || now)
  }
  if (row.startedAt && now - Number(row.startedAt) > Number(row.maxSessionMs || 0)) {
    return { abort: true, reason: "absolute-hard-timeout", action: Number(row.actions) || 0 }
  }
  return { abort: false, action: Number(row.actions) || 0 }
}

export const BROWSER_CLEANUP = Object.freeze({
  pagesClosed: "pages-closed",
  browserClosed: "browser-closed",
  processTreeTerminated: "process-tree-terminated",
  artifactsRemoved: "artifacts-removed",
})

// Every step is independent and best-effort: a browser that refuses to close must
// not prevent the process tree from being killed, and a kill failure must not
// prevent screenshot cleanup. The returned record is what the receipt and the
// final report read, so partial cleanup is visible rather than implied.
export async function closeBrowserSession(session = {}, options = {}) {
  const deps = {
    closePage: typeof options.closePage === "function" ? options.closePage : null,
    closeBrowser: typeof options.closeBrowser === "function" ? options.closeBrowser : null,
    killTree: typeof options.killTree === "function" ? options.killTree : terminateProcessTree,
    removeArtifacts: typeof options.removeArtifacts === "function" ? options.removeArtifacts : null,
  }
  const record = {
    schemaVersion: 1,
    kind: "ues-browser-session-cleanup",
    sessionId: session.id || null,
    pagesClosed: 0,
    pagesFailed: 0,
    browserClosed: false,
    processTreeTerminated: false,
    artifactsRemoved: 0,
    errors: [],
    ranAfterAbort: session.aborted === true,
  }

  for (const page of Array.isArray(session.pages) ? session.pages : []) {
    if (!deps.closePage) break
    try {
      await deps.closePage(page)
      record.pagesClosed += 1
    } catch (error) {
      record.pagesFailed += 1
      record.errors.push(`page-close:${error?.message || error}`)
    }
  }

  if (session.browser && deps.closeBrowser) {
    try {
      await deps.closeBrowser(session.browser)
      record.browserClosed = true
    } catch (error) {
      record.errors.push(`browser-close:${error?.message || error}`)
    }
  }

  if (session.process) {
    try {
      record.processTreeTerminated = deps.killTree(session.process, { graceMs: Number(options.graceMs) || 1_000 }) !== false
    } catch (error) {
      record.errors.push(`process-tree:${error?.message || error}`)
    }
  }

  if (session.artifacts && deps.removeArtifacts) {
    try {
      record.artifactsRemoved = Math.max(0, Number(await deps.removeArtifacts(session.artifacts, options)) || 0)
    } catch (error) {
      record.errors.push(`artifacts:${error?.message || error}`)
    }
  }

  if (typeof session.close === "function") session.close()
  record.steps = [
    record.pagesClosed > 0 ? BROWSER_CLEANUP.pagesClosed : null,
    record.browserClosed ? BROWSER_CLEANUP.browserClosed : null,
    record.processTreeTerminated ? BROWSER_CLEANUP.processTreeTerminated : null,
    record.artifactsRemoved > 0 ? BROWSER_CLEANUP.artifactsRemoved : null,
  ].filter(Boolean)
  record.complete = record.errors.length === 0
  return record
}

// Transient screenshots are the bulk of what a browser lane leaves behind. The
// walk is anchored on the caller's declared cache directory and only ever removes
// files it can prove sit inside it, so a misconfigured `dir` cannot turn cleanup
// into a recursive delete.
export async function cleanupBrowserArtifacts(root, options = {}) {
  const resolvedRoot = String(root || ".")
  const relativeDir = String(options.dir || ".ues-cache/browser-v1")
  const maxFiles = Math.max(0, Math.min(500, Number(options.maxFiles ?? 50)))
  if (maxFiles === 0) return { removed: 0, skipped: true, reason: "cleanup-disabled" }
  const listImpl = typeof options.listImpl === "function" ? options.listImpl : readdir
  const rmImpl = typeof options.rmImpl === "function" ? options.rmImpl : undefined

  const segments = relativeDir.split("/").filter(Boolean)
  if (!segments.length) return { removed: 0, skipped: true, reason: "no-cache-dir-declared" }

  let current = resolvedRoot
  let entries = null
  for (const segment of segments) {
    try {
      entries = await listImpl(current, { withFileTypes: true })
    } catch {
      return { removed: 0, skipped: true, reason: "cache-dir-absent" }
    }
    const directory = (entries || []).find((entry) => entry.isDirectory?.() && entry.name === segment)
    if (!directory) return { removed: 0, skipped: true, reason: "cache-dir-absent" }
    current = `${current}/${segment}`
  }

  let files = []
  try {
    files = (await listImpl(current, { withFileTypes: true })) || []
  } catch {
    return { removed: 0, skipped: true, reason: "cache-dir-absent" }
  }

  let removed = 0
  for (const entry of files.slice(0, maxFiles)) {
    if (entry.isDirectory?.()) continue
    try {
      await safeRemovePath(`${current}/${entry.name}`, { rmImpl })
      removed += 1
    } catch {
      // Cleanup is best effort: a locked file must not fail the action.
    }
  }
  return {
    removed,
    skipped: false,
    bounded: maxFiles,
    remaining: Math.max(0, files.length - removed),
    reason: "transient-browser-artifacts-removed",
  }
}
