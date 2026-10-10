// V16.3 runtime integration: managed browser worker client.
//
// Binds the Phase A `invoke` contract to the browser worker protocol so the
// DeepSeek lane (and any future managed browser caller) gets a real `invoke`
// without the Pi extension needing tool-dispatch rights it does not have.
//
// Design constraints this file satisfies:
//
//   - The transport is INJECTED. Tests use an in-process fake; production spawns
//     the Playwright-backed worker script. Neither the policy nor the caller can
//     tell the difference, which is what makes the lane deterministically testable.
//   - Availability is reported, never assumed. No worker, no Playwright, or an
//     unbound transport all resolve to `unavailable`, and the escalation router
//     then behaves exactly as specified (AUTO falls back, FORCE fails loudly).
//   - One request in flight at a time per session, with a hard timeout, because a
//     streaming web UI must not be able to wedge the run.

import {
  BROWSER_WORKER_FAILURE,
  BROWSER_WORKER_OPERATION,
  BROWSER_WORKER_PROTOCOL_VERSION,
  decodeWorkerResponse,
  encodeWorkerRequest,
} from "./browser-worker-protocol.mjs"
import { AUTH_PROBE_STATE, classifyAuthState } from "./browser-profile.mjs"
import { authDebugSummary, sanitizeDomInspection } from "./browser-dom-inspect.mjs"
import { sanitizeAnswerRegions, sanitizeComposerVicinity, sanitizeTransitionSummary } from "./deepseek-locators.mjs"
import { createBrowserSession } from "./browser-lifecycle.mjs"
import { terminateProcessTreeAsync } from "./process-supervisor.mjs"
import { externalTrustContract } from "./browser-security.mjs"

export const BROWSER_WORKER_CLIENT_SCHEMA_VERSION = 1

export const BROWSER_WORKER_CLIENT_STATE = Object.freeze({
  READY: "ready",
  UNAVAILABLE: "unavailable",
  NEEDS_AUTH: "needs-auth",
  TIMEOUT: "timeout",
  CLOSED: "closed",
  DEGRADED: "degraded",
})

export { AUTH_PROBE_STATE }

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Build a managed browser worker client.
 *
 * `options.transport` is `{ send(message), onMessage(listener), close() }` or
 * null. A null transport is a legitimate configuration meaning "no managed
 * browser"; it reports `unavailable` rather than failing, which is what lets the
 * escalation router fall back instead of pretending.
 *
 * @param {Record<string, any>} options
 * @returns {Record<string, any>}
 */
export function createBrowserWorkerClient(options = {}) {
  const settings = /** @type {Record<string, any>} */ (options);
  const timeoutMs = boundedInt(settings.timeoutMs, 60_000, 1_000, 600_000)
  const session = settings.session || createBrowserSession(settings.sessionOptions || {})
  const transport = settings.transport || null
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const inflight = new Map()
  let requestSeq = 0
  // Liveness. A headed browser the user closes is a distinct terminal condition,
  // not "the probe timed out": the wait state machine reports BROWSER_CLOSED
  // instead of burning the remaining budget against a process that is gone.
  const closeListeners = new Set()
  let processExited = false
  let exitCode = null
  const workerProcess = settings.process || null
  if (workerProcess && typeof workerProcess.once === "function") {
    workerProcess.once("exit", (code) => {
      processExited = true
      exitCode = code === null || code === undefined ? null : Number(code);
      state = { ...state, processExited: true, exitCode, closed: true, state: BROWSER_WORKER_CLIENT_STATE.CLOSED };
      for (const listener of closeListeners) {
        try { listener({ reason: "worker-process-exited", exitCode }) } catch {}
      }
    })
    workerProcess.once("error", (error) => {
      processExited = true
      state = { ...state, processExited: true, lastError: String(error?.message || error).slice(0, 200), closed: true };
      for (const listener of closeListeners) {
        try { listener({ reason: "worker-process-error", error }) } catch {}
      }
    })
  }

  /** @type {any} */
  let state = {
    state: transport ? BROWSER_WORKER_CLIENT_STATE.READY : BROWSER_WORKER_CLIENT_STATE.UNAVAILABLE,
    reason: transport ? null : BROWSER_WORKER_FAILURE.UNAVAILABLE,
    consecutiveFailures: 0,
    requests: 0,
    timeouts: 0,
    lastWorkerCapability: null,
    closed: false,
  }

  const onMessage = typeof transport?.onMessage === "function"
    ? transport.onMessage
    : () => null
  onMessage((message) => {
    const decoded = decodeWorkerResponse(message)
    const pending = inflight.get(decoded.requestId || "")
    if (!pending) return
    clearTimeout(pending.timer)
    inflight.delete(decoded.requestId || "")
    if (decoded.failure === BROWSER_WORKER_FAILURE.TIMEOUT) {
      state = { ...state, timeouts: state.timeouts + 1 }
    }
    pending.resolve(decoded)
  })

  const client = {
    schemaVersion: BROWSER_WORKER_CLIENT_SCHEMA_VERSION,
    kind: "ues-browser-worker-client",
    sessionId: session.id,
    protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,

    /** True while the worker process is alive and able to answer. */
    isAlive() {
      if (state.closed === true) return false
      if (processExited) return false
      if (!transport) return false
      if (typeof transport.send !== "function") return false
      return true
    },

    /** Notifies when the browser/worker goes away, so a wait can stop early. */
    onClose(listener) {
      if (typeof listener !== "function") return () => null
      closeListeners.add(listener)
      if (processExited) {
        try { listener({ reason: "worker-process-already-exited", exitCode }) } catch {}
      }
      return () => closeListeners.delete(listener)
    },

    state() {
      return {
        ...state,
        sessionId: session.id,
        inflight: inflight.size,
        processExited,
        exitCode,
        security: externalTrustContract("browser-worker-client"),
      }
    },

    /** Provider capability probe. Never throws; unavailability is a value. */
    async capability() {
      // Fail closed on a DEAD worker. `authProbe()` and `domInspect()` already
      // short-circuit here; without the same guard `capability()` writes into a
      // closed child's stdin and burns the FULL send timeout (60s in production)
      // before reporting a misleading `browser-worker-timeout` instead of the
      // true `worker-process-exited` liveness state.
      if (!transport || processExited || state.closed === true) {
        return {
          state: BROWSER_WORKER_CLIENT_STATE.UNAVAILABLE,
          reason: processExited ? "worker-process-exited" : BROWSER_WORKER_FAILURE.UNAVAILABLE,
          protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
        }
      }
      const result = await client.send(BROWSER_WORKER_OPERATION.CAPABILITY, {}, {})
      if (!result.ok) {
        return {
          state: BROWSER_WORKER_CLIENT_STATE.UNAVAILABLE,
          reason: result.failure,
          protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
        }
      }
      const worker = result.result || {}
      state = { ...state, lastWorkerCapability: worker }
      const workerState = String(worker.browserState || BROWSER_WORKER_CLIENT_STATE.READY)
      state = {
        ...state,
        state: workerState === "auth-required"
          ? BROWSER_WORKER_CLIENT_STATE.NEEDS_AUTH
          : workerState === "timeout"
            ? BROWSER_WORKER_CLIENT_STATE.TIMEOUT
            : workerState,
      }
      return {
        state: state.state,
        reason: state.reason,
        interactive: worker.interactive === true,
        inspectOnly: worker.inspectOnly === true,
        playwright: worker.playwright ?? null,
        profileMode: worker.profileMode ?? null,
        profileDir: worker.profileDir ?? null,
        profileExists: worker.profileExists === true,
        profileReason: worker.profileReason ?? null,
        headless: worker.headless !== false,
        protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
      }
    },

    /**
     * READ-ONLY auth observation.
     *
     * Returns the raw observations plus a classified state. It never touches
     * cookies, storage or session state directly: the classification comes from
     * the URL and the page's own rendered text, which is the only evidence a
     * third-party UI reliably exposes without holding credentials.
     */
    async authProbe(options = {}) {
      if (!transport || processExited || state.closed === true) {
        return {
          state: BROWSER_WORKER_CLIENT_STATE.CLOSED,
          reason: processExited ? "worker-process-exited" : BROWSER_WORKER_FAILURE.UNAVAILABLE,
          observations: null,
          transportAlive: false,
        };
      }
      const response = await client.send(BROWSER_WORKER_OPERATION.AUTH_PROBE, {
        requestId: `bw-auth-${++requestSeq}`,
        answerSelectors: Array.isArray(options.answerSelectors) ? options.answerSelectors : [],
        composerSelector: String(options.composerSelector || ""),
      }, { timeoutMs: options.timeoutMs });
      if (!response.ok || !response.result?.auth) {
        return {
          state: response.failure === BROWSER_WORKER_FAILURE.TIMEOUT
            ? AUTH_PROBE_STATE.TIMEOUT
            : AUTH_PROBE_STATE.UNKNOWN,
          reason: response.failure,
          observations: null,
        };
      }
      const classified = classifyAuthState(response.result.auth);
      return {
        ...classified,
        transportAlive: true,
        answerRegions: classified.answerRegions ?? 0,
        observations: response.result.auth,
        // The probe observed; it did not authenticate. Recording this keeps the
        // distinction visible to every caller downstream.
        probeOnly: true,
        trustLevel: "untrusted-external",
      };
    },

    /**
     * Bounded, READ-ONLY structural inspection. Never clicks, types or submits;
     * never reads cookies, storage, tokens or input values; never returns page
     * text, conversation titles or an account name. Used to repair the auth
     * selectors from measured DOM evidence instead of guesses.
     *
     * `options.mode` selects the evidence shape:
     *   structure (default) - generic visible-element structure (`inspection`)
     *   composer-vicinity   - composer/send/answer candidates (`vicinity`)
     *   send-transition-begin   - PRE-FILL same-node candidate snapshot
     *     (`transition` summary; handles stay worker-side)
     *   send-transition-measure - POST-FILL re-inspection of THOSE SAME
     *     handles (`transition` summary with changed/unchanged flags)
     *   deepseek-answer-regions - bounded assistant-answer regions ONLY
     *     (`answerRegions`: per-family counts + selected region text <=40k;
     *     never whole-page body text, sidebar/history/account text, or HTML)
     */
    async domInspect(options = {}) {
      if (!transport || processExited || state.closed === true) {
        return { ok: false, reason: processExited ? "worker-process-exited" : BROWSER_WORKER_FAILURE.UNAVAILABLE };
      }
      const rawMode = String(options.mode || "structure").trim().toLowerCase();
      const mode = rawMode === "composer-vicinity" || rawMode === "send-transition-begin" || rawMode === "send-transition-measure" || rawMode === "deepseek-answer-regions"
        ? rawMode
        : "structure";
      const response = await client.send(BROWSER_WORKER_OPERATION.DOM_INSPECT, {
        requestId: `bw-dom-${++requestSeq}`,
        limit: Number(options.limit) || 60,
        mode,
        answerSelectors: Array.isArray(options.answerSelectors) ? options.answerSelectors : [],
        nearbyLimit: Number(options.nearbyLimit) || 10,
        selector: typeof options.selector === "string" ? options.selector : null,
      }, { timeoutMs: options.timeoutMs });
      if (!response.ok) {
        return { ok: false, failure: response.failure, reason: response.failure };
      }
      const row = response.result || {};
      if (mode === "composer-vicinity") {
        // Sanitized at the client boundary too: the worker is not trusted to
        // have filtered correctly, and the in-page filter is a second layer.
        return {
          ok: true,
          vicinity: sanitizeComposerVicinity(row.vicinity || {}),
          trustLevel: "untrusted-external",
        };
      }
      if (mode === "send-transition-begin" || mode === "send-transition-measure") {
        // Second independent boundary: only counts/booleans and allowlisted
        // category names survive, regardless of what the worker claimed.
        return {
          ok: true,
          transition: sanitizeTransitionSummary(row.transition || {}),
          trustLevel: "untrusted-external",
        };
      }
      if (mode === "deepseek-answer-regions") {
        // Answer-region boundary: per-family counts + selected region text
        // only (<=40k). Never whole-page body text, sidebar/history/account
        // text, or raw HTML. The worker is not trusted to have filtered.
        return {
          ok: true,
          answerRegions: sanitizeAnswerRegions(row.answerRegions || {}),
          trustLevel: "untrusted-external",
        };
      }
      return {
        ok: true,
        // Sanitized at the client boundary too: the worker is not trusted to have
        // filtered correctly, and the in-page filter is a second layer, not the
        // only one.
        inspection: sanitizeDomInspection(row.dom || row),
        trustLevel: "untrusted-external",
      };
    },

    /** Booleans and counts only; safe to print. */
    authDebugSummary(observations, probe) {
      return authDebugSummary(observations, probe);
    },

    /**
     * Execute one action. The return shape is EXACTLY what Phase A expects:
     * `{ ok, ...observations }`. `ok` is "the worker did not error", never
     * "the intended outcome happened".
     */
    async invoke(action, context = {}) {
      // Same liveness contract as `authProbe()`/`domInspect()`: a dead or closed
      // worker must fail immediately rather than queue a request the transport
      // can never answer, which would burn the full action timeout and then
      // report a timeout as if the page had hung.
      if (processExited || state.closed === true) {
        return { ok: false, error: `browser-worker ${action} failed: ${processExited ? "worker-process-exited" : BROWSER_WORKER_FAILURE.UNAVAILABLE}` }
      }
      const targetUrl = typeof context.target === "string"
        ? context.target
        : context.target?.url;
      const request = encodeWorkerRequest({
        operation: action,
        requestId: `bw-${++requestSeq}`,
        url: context.url || targetUrl,
        selector: context.target?.selector,
        role: context.target?.role,
        name: context.target?.accessibleName || context.target?.name,
        transition: context.target?.transition,
        text: context.value,
        timeoutMs: context.navigationTimeoutMs || context.actionTimeoutMs,
        waitUntil: context.waitUntil,
        approved: context.approved,
        externalSideEffect: context.provenExternalSideEffect === true || context.externalSideEffect === true,
        idempotencyKey: context.idempotencyKey,
      })
      if (!request.ok) {
        return { ok: false, error: `browser-worker refused ${action}: ${request.failure}` }
      }
      const admission = session.beginAction()
      if (admission.ok === false) {
        return { ok: false, error: `browser-worker session refused ${action}: ${admission.reason}` }
      }
      const response = await client.send(action, request.payload, { timeoutMs: context.actionTimeoutMs })
      if (!response.ok) {
        state = { ...state, consecutiveFailures: state.consecutiveFailures + 1 }
        return { ok: false, error: `browser-worker ${action} failed: ${response.failure}` }
      }
      state = { ...state, consecutiveFailures: 0 }
      const row = response.result || {}
      return {
        ok: true,
        ...row,
        beforeUrl: row.beforeUrl ?? row.url ?? null,
        afterUrl: row.finalUrl ?? row.url ?? null,
        result: row,
        observations: response.observations,
        workerRequestId: response.requestId,
      }
    },

    send(operation, payload, sendOptions = {}) {
      if (!transport || typeof transport.send !== "function") {
        return Promise.resolve({
          ok: false,
          failure: BROWSER_WORKER_FAILURE.UNAVAILABLE,
          requestId: String(payload?.requestId || ""),
          operation,
        })
      }
      if (inflight.size >= 1) {
        // Serialized by design: a streaming web page plus a parallel click is how
        // a stale locator gets created in the first place.
        return Promise.resolve({
          ok: false,
          failure: BROWSER_WORKER_FAILURE.TRANSPORT,
          requestId: String(payload?.requestId || ""),
          operation,
        })
      }
      state = { ...state, requests: state.requests + 1 }
      const requestId = String(payload?.requestId || "")
      const waitMs = boundedInt(sendOptions.timeoutMs, timeoutMs, 100, 600_000)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          inflight.delete(requestId)
          resolve({
            ok: false,
            failure: BROWSER_WORKER_FAILURE.TIMEOUT,
            requestId,
            operation,
          })
        }, waitMs)
        inflight.set(requestId, { resolve, reject: () => {}, timer })
        try {
          transport.send({ protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, operation, ...payload })
        } catch (error) {
          clearTimeout(timer)
          inflight.delete(requestId)
          resolve({
            ok: false,
            failure: BROWSER_WORKER_FAILURE.TRANSPORT,
            requestId,
            operation,
            detail: String(error?.message || error).slice(0, 200),
          })
        }
      })
    },

    /** Deterministic teardown. Idempotent, bounded, Windows-safe. */
    async close() {
      if (state.closed) return { closed: true, alreadyClosed: true }
      state = { ...state, closed: true, state: BROWSER_WORKER_CLIENT_STATE.CLOSED }
      for (const [key, pending] of inflight) {
        clearTimeout(pending.timer)
        inflight.delete(key)
        pending.resolve({ ok: false, failure: BROWSER_WORKER_FAILURE.CLOSED, requestId: key, operation: "close" })
      }
      try {
        await transport?.send?.({
          protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
          operation: BROWSER_WORKER_OPERATION.CLOSE,
          requestId: "bw-close",
        })
      } catch {}
      try {
        transport?.close?.()
      } catch {}
      if (options.process) {
        try {
          await terminateProcessTreeAsync(options.process, { graceMs: boundedInt(options.graceMs, 1_000, 0, 10_000) }).catch(() => {})
        } catch {}
      }
      if (typeof session.close === "function") session.close()
      return {
        closed: true,
        schemaVersion: BROWSER_WORKER_CLIENT_SCHEMA_VERSION,
        kind: "ues-browser-worker-client-cleanup",
        sessionId: session.id,
        requests: state.requests,
        timeouts: state.timeouts,
        inflight: 0,
        security: externalTrustContract("browser-worker-client"),
      }
    },
  }

  return client
}

/**
 * Builds a transport for a spawned worker process. Returns null when the worker
 * entry point cannot be resolved, which the client reports as `unavailable`
 * rather than as a failure.
 */
export function spawnBrowserWorkerTransport(scriptPath, options = {}) {
  const spawnImpl = options.spawnImpl
  if (typeof spawnImpl !== "function" || !scriptPath) return null
  // `scriptArgs` carries the worker's mode flags (`--live`, `--headed`,
  // `--profile=`). They are validated to be flag-shaped so this transport cannot
  // be used to smuggle an arbitrary program into the worker process.
  const scriptArgs = (Array.isArray(options.scriptArgs) ? options.scriptArgs : [])
    .map((entry) => String(entry))
    .filter((entry) => /^--[a-z0-9][a-z0-9-]*(=[^\r\n]{0,200})?$/i.test(entry))
    .slice(0, 8);
  let child = null
  try {
    child = spawnImpl(process.execPath, [scriptPath, ...scriptArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(options.spawnOptions || {}),
    })
  } catch {
    return null
  }
  if (!child) return null

  let buffer = ""
  const listeners = new Set()
  const stdoutOnData = (chunk) => {
    buffer += String(chunk || "")
    let index = buffer.indexOf("\n")
    while (index !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
      if (!line) continue
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      for (const listener of listeners) listener(parsed)
    }
  }
  child.stdout?.on?.("data", stdoutOnData)
  child.stderr?.on?.("data", (chunk) => {
    options.onStderr?.(String(chunk || ""))
  })

  return {
    send(message) {
      child.stdin?.write?.(JSON.stringify(message) + "\n")
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      try {
        child.stdin?.end?.()
      } catch {}
    },
    process: child,
  }
}