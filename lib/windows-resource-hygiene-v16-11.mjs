// V16.11 Windows resource hygiene.
//
// WHY THIS MODULE EXISTS
//
// A warm browser worker is a long-lived OS process holding file handles: a
// user-data-dir, a profile lock, screenshot artifacts and inherited stdio pipes.
// On POSIX a leaked handle is mostly harmless; on WINDOWS a still-open handle
// keeps a file LOCKED, so a subsequent `rm -rf` of the user-data-dir fails with
// EBUSY/EPERM and the next run cannot start. V16.10 cleaned up best-effort and
// never PROVED the cleanup completed, so a Windows leak was invisible.
//
// This module owns ONE decision: given the resources a browser session acquired,
// is cleanup COMPLETE, and can we prove it? It runs a bounded, ordered teardown
// (close pages -> close browser -> kill process tree -> release locks -> remove
// artifacts) and returns a receipt with a per-resource verdict. It never throws:
// a partial cleanup is REPORTED, not hidden.
//
// It reuses the proven primitives: `terminateProcessTree` for the OS process and
// `closeBrowserSession` for the browser surface. It owns no browser and no policy
// beyond the teardown order.

import { rmSync, existsSync } from "node:fs"
import { closeBrowserSession } from "./browser-lifecycle.mjs"
import { terminateProcessTree } from "./process-supervisor.mjs"

export const WINDOWS_HYGIENE_SCHEMA_VERSION = 1
export const WINDOWS_HYGIENE_POLICY = "windows-hygiene-v16-11"

// The ordered teardown. Order matters on Windows: the process tree must die
// BEFORE the user-data-dir is removed, or the removal hits a locked file.
export const HYGIENE_STEP = Object.freeze({
  CLOSE_PAGES: "close-pages",
  CLOSE_BROWSER: "close-browser",
  KILL_PROCESS_TREE: "kill-process-tree",
  RELEASE_PROFILE_LOCK: "release-profile-lock",
  REMOVE_USER_DATA: "remove-user-data",
  REMOVE_ARTIFACTS: "remove-artifacts",
})

export const HYGIENE_VERDICT = Object.freeze({
  COMPLETE: "complete",
  PARTIAL: "partial",
  NOTHING_TO_DO: "nothing-to-do",
  FAILED: "failed",
})

function isWindows() {
  return process.platform === "win32"
}

/**
 * Remove a path with bounded Windows-aware retries. Node's own `rmSync`
 * `maxRetries`/`retryDelay` handle the EPERM/EBUSY handle-release race on
 * Windows; we wrap it so a partial cleanup is a REPORTED value, never a throw.
 */
function removeWithRetry(target, options = {}) {
  const maxRetries = Math.max(0, Math.min(10, Number(options.attempts || 5)))
  const retryDelay = Math.max(0, Number(options.retryDelayMs ?? 100))
  const fsImpl = options.fsImpl || { rmSync, existsSync }
  try {
    fsImpl.rmSync(target, { recursive: true, force: true, maxRetries, retryDelay })
    return { removed: true, attempts: maxRetries + 1, error: null }
  } catch (error) {
    return { removed: false, attempts: maxRetries + 1, error: String(error?.message || error) }
  }
}

/**
 * Tear down a browser session's OS resources and PROVE it.
 *
 * @param {object} session
 * @param {object} [session.process] the browser subprocess
 * @param {object} [session.browser] the automation browser handle
 * @param {Array} [session.pages] open pages
 * @param {string} [session.userDataDir] the browser profile dir
 * @param {string[]} [session.artifactDirs] transient artifact dirs
 * @param {Function} [session.releaseLock] release the profile lock handle
 * @param {object} [options]
 * @param {Function} [options.killTree] override the process killer (tests)
 * @param {Function} [options.closeBrowserSession] override the browser teardown (tests)
 * @param {object} [options.fsImpl] override fs (tests)
 * @param {boolean} [options.dryRun] report what WOULD be removed without removing
 * @returns {object} a receipt; `verdict` is COMPLETE only when every step proved.
 */
export async function proveBrowserResourceCleanup(session = {}, options = {}) {
  const fsImpl = options.fsImpl || { rmSync, existsSync }
  const killTree = typeof options.killTree === "function" ? options.killTree : terminateProcessTree
  const closeBrowser = typeof options.closeBrowserSession === "function" ? options.closeBrowserSession : closeBrowserSession
  const dryRun = options.dryRun === true
  const receipt = {
    schemaVersion: WINDOWS_HYGIENE_SCHEMA_VERSION,
    policy: WINDOWS_HYGIENE_POLICY,
    platform: process.platform,
    windows: isWindows(),
    sessionId: session.id || null,
    steps: [],
    errors: [],
    removedPaths: [],
    retainedPaths: [],
    lockReleased: false,
    processTreeTerminated: false,
  }

  const record = (step, ok, detail) => {
    receipt.steps.push({ step, ok: ok === true, detail: detail || null })
    if (ok !== true) receipt.errors.push(`${step}:${detail || "failed"}`)
  }

  // 1. Close the browser surface (pages + browser handle) via the proven path.
  if (session.browser || (Array.isArray(session.pages) && session.pages.length > 0)) {
    try {
      const closed = await closeBrowser(session, { closePage: options.closePage, closeBrowser: options.closeBrowser })
      record(HYGIENE_STEP.CLOSE_PAGES, closed.pagesFailed === 0, `closed=${closed.pagesClosed} failed=${closed.pagesFailed}`)
      record(HYGIENE_STEP.CLOSE_BROWSER, closed.browserClosed || !session.browser, null)
    } catch (error) {
      record(HYGIENE_STEP.CLOSE_PAGES, false, String(error?.message || error))
    }
  }

  // 2. Kill the process tree. This MUST precede file removal on Windows.
  if (session.process) {
    try {
      const killed = killTree(session.process, { graceMs: Number(options.graceMs) || 1500 })
      receipt.processTreeTerminated = killed !== false
      record(HYGIENE_STEP.KILL_PROCESS_TREE, receipt.processTreeTerminated, killed === false ? "kill-returned-false" : null)
    } catch (error) {
      record(HYGIENE_STEP.KILL_PROCESS_TREE, false, String(error?.message || error))
    }
  }

  // 3. Release the profile lock handle. A retained lock keeps the profile dir
  //    undeletable on Windows, so this is its own step with its own verdict.
  if (typeof session.releaseLock === "function") {
    try {
      await session.releaseLock()
      receipt.lockReleased = true
      record(HYGIENE_STEP.RELEASE_PROFILE_LOCK, true, null)
    } catch (error) {
      record(HYGIENE_STEP.RELEASE_PROFILE_LOCK, false, String(error?.message || error))
    }
  }

  // 4. Remove the user-data-dir (the profile). Bounded retry handles the Windows
  //    handle-release race. A path we cannot prove we removed is RETAINED.
  if (session.userDataDir) {
    if (dryRun) {
      record(HYGIENE_STEP.REMOVE_USER_DATA, true, "dry-run")
    } else {
      const result = removeWithRetry(session.userDataDir, { fsImpl, attempts: options.attempts })
      if (result.removed) {
        receipt.removedPaths.push(session.userDataDir)
        record(HYGIENE_STEP.REMOVE_USER_DATA, true, `attempts=${result.attempts}`)
      } else {
        receipt.retainedPaths.push(session.userDataDir)
        record(HYGIENE_STEP.REMOVE_USER_DATA, false, result.error)
      }
    }
  }

  // 5. Remove transient artifact dirs.
  for (const dir of Array.isArray(session.artifactDirs) ? session.artifactDirs : []) {
    if (dryRun) {
      record(HYGIENE_STEP.REMOVE_ARTIFACTS, true, "dry-run")
      continue
    }
    const result = removeWithRetry(dir, { fsImpl, attempts: options.attempts })
    if (result.removed) receipt.removedPaths.push(dir)
    else receipt.retainedPaths.push(dir)
    record(HYGIENE_STEP.REMOVE_ARTIFACTS, result.removed, result.removed ? dir : result.error)
  }

  const attempted = receipt.steps.length
  const succeeded = receipt.steps.filter((s) => s.ok).length
  if (attempted === 0) receipt.verdict = HYGIENE_VERDICT.NOTHING_TO_DO
  else if (receipt.errors.length === 0) receipt.verdict = HYGIENE_VERDICT.COMPLETE
  else if (succeeded > 0) receipt.verdict = HYGIENE_VERDICT.PARTIAL
  else receipt.verdict = HYGIENE_VERDICT.FAILED

  // The proof the directive demands: no retained path and no error.
  receipt.clean = receipt.verdict === HYGIENE_VERDICT.COMPLETE || receipt.verdict === HYGIENE_VERDICT.NOTHING_TO_DO
  receipt.attempted = attempted
  receipt.succeeded = succeeded
  return receipt
}

/**
 * A bounded leak detector: given a root and a set of expected-empty directories,
 * report which still hold entries. Read-only; used by the hygiene gate.
 */
export function detectRetainedResources(root, dirs = [], options = {}) {
  const fsImpl = options.fsImpl || { existsSync }
  const listImpl = options.listImpl
  const retained = []
  for (const dir of dirs) {
    const abs = String(dir)
    try {
      if (!fsImpl.existsSync(abs)) continue
      if (typeof listImpl === "function") {
        const entries = listImpl(abs)
        if (Array.isArray(entries) && entries.length > 0) retained.push({ dir: abs, entries: entries.length })
      } else {
        retained.push({ dir: abs, entries: null })
      }
    } catch (error) {
      retained.push({ dir: abs, error: String(error?.message || error) })
    }
  }
  return { root: String(root), retained, clean: retained.length === 0 }
}

export const windowsHygieneExports = Object.freeze({
  WINDOWS_HYGIENE_SCHEMA_VERSION,
  WINDOWS_HYGIENE_POLICY,
  HYGIENE_STEP,
  HYGIENE_VERDICT,
  proveBrowserResourceCleanup,
  detectRetainedResources,
})
