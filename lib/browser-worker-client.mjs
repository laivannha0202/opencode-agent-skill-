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
import { createBrowserSession } from "./browser-lifecycle.mjs"
import { terminateProcessTree } from "./process-supervisor.mjs"
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

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * @param options.transport
 *   { send(message) -> void, onMessage(cb), close() } or null
 *   A null transport is a legitimate configuration meaning "no managed browser".
 */
export function createBrowserWorkerClient(options = {}) {
  const timeoutMs = boundedInt(options.timeoutMs, 60_000, 1_000, 600_000)
  const session = options.session || createBrowserSession(options.sessionOptions || {})
  const transport = options.transport || null
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const inflight = new Map()
  let requestSeq = 0
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
    state() {
      return {
        ...state,
        sessionId: session.id,
        inflight: inflight.size,
        security: externalTrustContract("browser-worker-client"),
      }
    },

    /** Provider capability probe. Never throws; unavailability is a value. */
    async capability() {
      if (!transport) {
        return {
          state: BROWSER_WORKER_CLIENT_STATE.UNAVAILABLE,
          reason: BROWSER_WORKER_FAILURE.UNAVAILABLE,
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
        protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
      }
    },

    /**
     * Execute one action. The return shape is EXACTLY what Phase A expects:
     * `{ ok, ...observations }`. `ok` is "the worker did not error", never
     * "the intended outcome happened".
     */
    async invoke(action, context = {}) {
      const request = encodeWorkerRequest({
        operation: action,
        requestId: `bw-${++requestSeq}`,
        url: context.url || context.target?.url,
        selector: context.target?.selector,
        role: context.target?.role,
        name: context.target?.accessibleName || context.target?.name,
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
          terminateProcessTree(options.process, { graceMs: boundedInt(options.graceMs, 1_000, 0, 10_000) })
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
  let child = null
  try {
    child = spawnImpl(process.execPath, [scriptPath], {
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