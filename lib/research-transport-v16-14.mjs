// V16.14 Bounded External-Research HTTPS Transport.
//
// WHY THIS MODULE EXISTS
//
// V16.13 handed the trusted production path to the global `fetch(..., {
// redirect: "follow" })`. That is unsafe for research egress for three reasons
// the V16.13 policy module could not fix from a pure function:
//
//   1. `redirect: "follow"` is UNCONTROLLED. A public URL that 302s to
//      `http://169.254.169.254/` or `http://10.0.0.5/` would be followed by the
//      runtime without re-checking the SSRF policy on the hop.
//   2. Hostname TEXT is not the truth. `evil.example` can resolve to a private
//      address; a text-only check cannot see it.
//   3. `Promise.race` timeouts do not stop the socket. The underlying request
//      keeps running (an orphan request) after the caller stopped waiting.
//
// This module is the SINGLE V16.14 owner of the question:
//
//   "What is a safe, bounded, cancellable HTTPS exchange with a PUBLIC host,
//    where every redirect hop is re-validated and the connection is pinned to
//    the addresses we actually validated?"
//
// It owns NO policy vocabulary (that lives in research-network-policy-v16-13)
// and NO body semantics (that lives in research-page-fetch-v16-13). It returns a
// fetch-shaped response so the existing page-fetch/normalize path is unchanged.
//
// LAWS
//
//   1. PUBLIC HTTPS ONLY. The scheme, credentials and host text are checked by
//      the policy owner before any socket is opened.
//   2. RESOLVE BEFORE CONNECT, THEN PIN. The hostname is resolved, every
//      resolved address is validated, and the validated addresses are supplied
//      to the TLS socket's `lookup` so the connection cannot silently re-resolve
//      to a different (private) address (bounded DNS-rebinding defense).
//   3. REDIRECTS ARE MANUAL AND BOUNDED. Every hop is parsed, canonicalized,
//      scheme-checked, credential-checked, re-resolved and re-validated. A
//      public -> private redirect is BLOCKED_POLICY. The hop count is capped.
//   4. TRUE CANCELLATION. An AbortSignal destroys the in-flight socket
//      immediately, so no orphan request survives a soft/hard deadline.
//   5. BOUNDED BYTES. The body is streamed and truncated at `maxBytes`; the
//      socket is destroyed once the cap is reached.
//   6. INJECTABLE. A test can supply its own `dnsLookup` and `httpsRequest`
//      so the SSRF/redirect/cancellation logic is provable without a network.
//
// Local-development BROWSER network policy is a SEPARATE owner and is not
// changed by this module.

import https from "node:https"
import dns from "node:dns/promises"
import { createHash } from "node:crypto"
import {
  canonicalizeUrl,
  checkUrlAllowed,
  checkResolvedAddresses,
} from "./research-network-policy-v16-13.mjs"

export const RESEARCH_TRANSPORT_POLICY = "research-transport-v16-14"
export const RESEARCH_TRANSPORT_SCHEMA_VERSION = 1

export const DEFAULT_MAX_REDIRECTS = 5
export const DEFAULT_MAX_BYTES = 2_000_000

// Hop-by-hop / credential headers that must never be forwarded across a redirect
// to a different host. `authorization` is the important one: a GitHub token must
// not follow a redirect off GitHub.
const SENSITIVE_FORWARD_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"])

function stableHash(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex")
}

function headersToGetter(headers = {}) {
  const lower = {}
  for (const [key, value] of Object.entries(headers || {})) {
    lower[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : value
  }
  return (name) => lower[String(name).toLowerCase()] ?? null
}

/**
 * Strip sensitive headers when a redirect crosses to a different host.
 * Same-host redirects keep them; cross-host redirects drop credentials.
 */
export function filterForwardHeaders(headers, fromHost, toHost) {
  const sameHost = String(fromHost || "").toLowerCase() === String(toHost || "").toLowerCase()
  if (sameHost) return { ...headers }
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (SENSITIVE_FORWARD_HEADERS.has(String(key).toLowerCase())) continue
    out[key] = value
  }
  return out
}

function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true })
}

/**
 * Open ONE bounded HTTPS request against already-validated addresses and return
 * a fetch-shaped response. The socket is pinned to `addresses` via `lookup`, so
 * no second DNS resolution can occur between validation and connect.
 */
function openPinnedRequest(urlObj, { headers, signal, pinnedAddresses, httpsRequest, maxBytes }) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    let request
    try {
      request = httpsRequest({
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "GET",
        headers,
        // Pin the connection to the addresses we validated.
        lookup: (hostname, lookupOptions, callback) => {
          const family = lookupOptions && lookupOptions.family
          const usable = family
            ? pinnedAddresses.filter((a) => (family === 6 ? a.includes(":") : !a.includes(":")))
            : pinnedAddresses
          const chosen = (usable.length ? usable : pinnedAddresses).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }))
          if (lookupOptions && lookupOptions.all) callback(null, chosen)
          else callback(null, chosen[0].address, chosen[0].family)
        },
        servername: urlObj.hostname,
      })
    } catch (error) {
      finish(reject, error)
      return
    }

    const chunks = []
    let received = 0
    let truncated = false

    const onAbort = () => {
      try { request.destroy(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })) } catch { /* ignore */ }
      finish(reject, Object.assign(new Error("research-transport: aborted"), { code: "ABORT_ERR" }))
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    request.on("error", (error) => finish(reject, error))
    request.on("response", (response) => {
      response.on("data", (chunk) => {
        if (truncated) return
        const remaining = maxBytes - received
        if (chunk.length >= remaining) {
          chunks.push(chunk.subarray(0, remaining))
          received += remaining
          truncated = true
          try { response.destroy() } catch { /* ignore */ }
          return
        }
        chunks.push(chunk)
        received += chunk.length
      })
      const finalize = () => {
        if (signal) signal.removeEventListener("abort", onAbort)
        finish(resolve, {
          status: Number(response.statusCode || 0),
          headers: headersToGetter(response.headers),
          rawHeaders: response.headers,
          location: response.headers?.location || null,
          truncated,
          bytes: received,
          body: Buffer.concat(chunks),
        })
      }
      response.on("end", finalize)
      response.on("close", finalize)
      response.on("error", (error) => finish(reject, error))
    })
    request.end()
  })
}

/**
 * Create a bounded, cancellable, SSRF-safe HTTPS transport.
 *
 * @param {object} [options]
 * @param {(hostname: string) => Promise<{address:string,family:number}[]>} [options.dnsLookup]
 * @param {Function} [options.httpsRequest]   injectable https.request (tests)
 * @param {number} [options.maxRedirects]
 * @param {number} [options.maxBytes]
 * @param {(event: object) => void} [options.onEvent]
 */
export function createBoundedExternalTransport(options = {}) {
  const httpsRequest = typeof options.httpsRequest === "function" ? options.httpsRequest : https.request
  const dnsLookup = typeof options.dnsLookup === "function" ? options.dnsLookup : defaultLookup
  const maxRedirects = Math.max(0, Math.min(10, Number(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)))
  const maxBytes = Math.max(1024, Math.min(64 * 1024 * 1024, Number(options.maxBytes ?? DEFAULT_MAX_BYTES)))
  const emit = typeof options.onEvent === "function" ? options.onEvent : () => {}
  const counters = { requests: 0, redirects: 0, blocked: 0, aborted: 0, resolvedLookups: 0 }

  async function resolveAndValidate(urlObj) {
    // An IP-literal host is validated directly; a name is resolved first.
    const host = urlObj.hostname
    const literalV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    const literalV6 = host.includes(":")
    if (literalV4 || literalV6) {
      return checkResolvedAddresses([host])
    }
    let records
    try {
      records = await dnsLookup(host)
    } catch (error) {
      return { allowed: false, reason: `BLOCKED_POLICY:dns-failure:${error?.code || error?.message || "error"}`, failure: "BLOCKED_POLICY" }
    }
    counters.resolvedLookups += 1
    const addresses = (Array.isArray(records) ? records : []).map((row) => (typeof row === "string" ? row : row?.address)).filter(Boolean)
    return checkResolvedAddresses(addresses)
  }

  async function fetchOnce(rawUrl, { headers = {}, signal = null, method = "GET" } = {}) {
    let current
    try {
      current = new URL(rawUrl)
    } catch {
      return { status: 0, failure: "BLOCKED_POLICY", reason: "invalid-url", headers: headersToGetter({}), body: Buffer.alloc(0), text: async () => "" }
    }
    let hops = 0
    let forwardHeaders = { ...headers }
    let previousHost = current.hostname

    for (;;) {
      const canonical = canonicalizeUrl(current.toString())
      const allowed = checkUrlAllowed(canonical)
      if (!allowed.allowed) {
        counters.blocked += 1
        return { status: 0, failure: "BLOCKED_POLICY", reason: allowed.reason, headers: headersToGetter({}), body: Buffer.alloc(0), text: async () => "" }
      }
      const urlObj = new URL(canonical)
      const resolved = await resolveAndValidate(urlObj)
      if (!resolved.allowed) {
        counters.blocked += 1
        return { status: 0, failure: "BLOCKED_POLICY", reason: resolved.reason, headers: headersToGetter({}), body: Buffer.alloc(0), text: async () => "" }
      }
      const pinnedAddresses = resolved.addresses || [urlObj.hostname]

      counters.requests += 1
      let response
      try {
        response = await openPinnedRequest(urlObj, { headers: forwardHeaders, signal, pinnedAddresses, httpsRequest, maxBytes })
      } catch (error) {
        if (error?.code === "ABORT_ERR") {
          counters.aborted += 1
          return { status: 0, failure: "CANCELLED", reason: "aborted", headers: headersToGetter({}), body: Buffer.alloc(0), text: async () => "" }
        }
        return { status: 0, failure: "NETWORK_UNAVAILABLE", reason: String(error?.message || error), headers: headersToGetter({}), body: Buffer.alloc(0), text: async () => "" }
      }

      const status = Number(response.status || 0)
      const isRedirect = status >= 300 && status < 400 && response.location
      if (!isRedirect) {
        return {
          status,
          failure: null,
          headers: response.headers,
          rawHeaders: response.rawHeaders,
          bytes: response.bytes,
          truncated: response.truncated,
          body: response.body,
          finalUrl: canonical,
          text: async () => response.body.toString("utf8"),
          json: async () => JSON.parse(response.body.toString("utf8")),
        }
      }

      // Manual bounded redirect. Every hop is re-validated by the loop head.
      hops += 1
      counters.redirects += 1
      if (hops > maxRedirects) {
        counters.blocked += 1
        return { status, failure: "BLOCKED_POLICY", reason: "BLOCKED_POLICY:redirect-limit-exceeded", headers: response.headers, body: Buffer.alloc(0), text: async () => "" }
      }
      let next
      try {
        next = new URL(String(response.location), canonical)
      } catch {
        counters.blocked += 1
        return { status, failure: "BLOCKED_POLICY", reason: "BLOCKED_POLICY:invalid-redirect-location", headers: response.headers, body: Buffer.alloc(0), text: async () => "" }
      }
      // Reject a redirect that carries credentials in the Location URL.
      if (next.username || next.password) {
        counters.blocked += 1
        return { status, failure: "BLOCKED_POLICY", reason: "BLOCKED_POLICY:credential-redirect", headers: response.headers, body: Buffer.alloc(0), text: async () => "" }
      }
      forwardHeaders = filterForwardHeaders(forwardHeaders, previousHost, next.hostname)
      emit({ type: "research-redirect", hop: hops, to: next.toString() })
      previousHost = next.hostname
      current = next
    }
  }

  return {
    policy: RESEARCH_TRANSPORT_POLICY,
    schemaVersion: RESEARCH_TRANSPORT_SCHEMA_VERSION,
    maxRedirects,
    maxBytes,
    counters,
    fetch: fetchOnce,
    // Exposed for tests / diagnostics.
    _resolveAndValidate: resolveAndValidate,
    _filterForwardHeaders: filterForwardHeaders,
  }
}

/**
 * A response-shaped adapter so `fetchAndNormalize` can consume the transport
 * without knowing whether it came from `globalThis.fetch` or this module.
 */
export function toFetchLike(transport) {
  return async (url, init = {}) => {
    const res = await transport.fetch(url, {
      headers: init.headers || {},
      signal: init.signal || null,
      method: init.method || "GET",
    })
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      headers: { get: res.headers },
      text: async () => res.text(),
      json: async () => res.json(),
      __transportFailure: res.failure || null,
      __transportReason: res.reason || null,
      __truncated: res.truncated === true,
    }
  }
}

export const researchTransportExports = Object.freeze({
  createBoundedExternalTransport,
  toFetchLike,
  filterForwardHeaders,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_BYTES,
})
