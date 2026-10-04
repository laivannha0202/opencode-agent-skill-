// V16.6 DeepSeek evidence-request loop.
//
// DeepSeek never runs tools (V16.5 rule, unchanged). When it needs local
// evidence it ASKS, using a bounded, allowlisted request format. Then:
//
//   DeepSeek emits request  ->  this module VALIDATES it
//                             ->  Pi gathers the evidence locally
//                             ->  redaction + bounded delta
//                             ->  delta goes back to DeepSeek
//
// Hard rules enforced here:
//   * only allowlisted kinds, bounded counts, bounded sizes
//   * workspace containment: a request can never escape the workspace root
//   * no `.env`, key, token, credential or Evidence Store-internal file
//   * redaction runs on every delta before it leaves the workspace
//   * a request that fails validation is DENIED, not silently narrowed

import { createHash } from "node:crypto"
import path from "node:path"
import { redactSecrets, containsUnmaskedSecret, REDACTION_MASK } from "./secret-redaction.mjs"
import { measured, derived, NOT_MEASURED, estimateTokensFromChars } from "./measurement-provenance.mjs"

export const EVIDENCE_REQUEST_SCHEMA_VERSION = 1
export const EVIDENCE_REQUEST_POLICY = "deepseek-evidence-requests-v16-6"

/**
 * The complete allowlist. Adding a kind here is a security decision: it must
 * have a size bound and an explicit "may this ever contain a secret" answer.
 */
export const EVIDENCE_KINDS = Object.freeze({
  diff: Object.freeze({ maxChars: 16_000, mayContainSecret: false, description: "workspace diff excerpt" }),
  "failed-output": Object.freeze({ maxChars: 8_000, mayContainSecret: false, description: "last failing command output" }),
  "file-excerpt": Object.freeze({ maxChars: 4_000, mayContainSecret: false, description: "bounded file excerpt" }),
  "test-names": Object.freeze({ maxChars: 2_000, mayContainSecret: false, description: "affected test names" }),
  "verifier-output": Object.freeze({ maxChars: 6_000, mayContainSecret: false, description: "verifier summary" }),
  "repo-summary": Object.freeze({ maxChars: 4_000, mayContainSecret: false, description: "affected files summary" }),
  "telemetry-summary": Object.freeze({ maxChars: 4_000, mayContainSecret: false, description: "run telemetry summary" }),
  "tool-output": Object.freeze({ maxChars: 8_000, mayContainSecret: false, description: "bounded tool output fragment" }),
})

export const EVIDENCE_KIND_LIST = Object.freeze(Object.keys(EVIDENCE_KINDS))
export const MAX_REQUESTS_PER_EXCHANGE = 4
export const MAX_REQUESTS_PER_RUN = 8

// The truncation marker is charged against the caller's char budget.
const TRUNCATION_MARKER = "\n[truncated]"

/** Files that must never be read for a DeepSeek evidence request. */
const FORBIDDEN_BASENAMES = Object.freeze([
  ".env",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "id_rsa",
  "id_ed25519",
  "secrets.json",
  "credentials.json",
])
const FORBIDDEN_EXTENSIONS = Object.freeze([".pem", ".key", ".p12", ".pfx", ".keystore"])

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

/**
 * Parse DeepSeek's reply for evidence requests.
 * Recognized lines (case-insensitive, one kind per line):
 *   EVIDENCE: diff
 *   evidence-request: file-excerpt
 *   evidence: <unknown-kind>   -> rejected, with reason
 */
export function parseEvidenceRequests(text, options = {}) {
  const maxRequests = int(options.maxRequests, MAX_REQUESTS_PER_EXCHANGE, 1, 8)
  const source = String(text || "")
  const allowed = []
  const rejected = []
  const seen = new Set()
  const lines = source.split(/\r?\n/)
  for (const raw of lines) {
    const match = raw.match(/^\s*(?:evidence-request|evidence)\s*:\s*([a-z0-9-]+)\s*$/i)
    if (!match) continue
    const kind = match[1].toLowerCase()
    if (seen.has(kind)) {
      rejected.push({ kind, reason: "duplicate" })
      continue
    }
    seen.add(kind)
    if (!EVIDENCE_KINDS[kind]) {
      rejected.push({ kind, reason: "kind-not-allowlisted" })
      continue
    }
    if (allowed.length >= maxRequests) {
      rejected.push({ kind, reason: "per-exchange-cap" })
      continue
    }
    allowed.push({ kind, maxChars: EVIDENCE_KINDS[kind].maxChars })
  }
  return {
    schemaVersion: EVIDENCE_REQUEST_SCHEMA_VERSION,
    policy: EVIDENCE_REQUEST_POLICY,
    requests: allowed,
    rejected,
    total: allowed.length + rejected.length,
    bounded: allowed.length <= maxRequests,
    maxRequests,
  }
}

/** True when `target` resolves inside `root` (Windows and POSIX). */
export function isInsideWorkspace(root, target) {
  if (!root || !target) return false
  let resolvedRoot = ""
  let resolvedTarget = ""
  try {
    resolvedRoot = path.resolve(String(root))
    resolvedTarget = path.resolve(String(target))
  } catch {
    return false
  }
  const a = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot
  const b = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget
  if (a === b) return true
  return b.startsWith(a + path.sep)
}

function forbiddenPath(target) {
  const base = path.basename(String(target || "")).toLowerCase()
  if (FORBIDDEN_BASENAMES.includes(base)) return "secret-file"
  if (base.startsWith(".env")) return "env-file"
  const ext = path.extname(base)
  if (FORBIDDEN_EXTENSIONS.includes(ext)) return "key-material"
  const normalized = String(target || "").replace(/\\/g, "/")
  // Relative and absolute spellings both count: `.git/config` must be denied
  // exactly like `lib/.git/config`.
  if (/(^|\/)\.git(\/|$)/.test(normalized)) return "git-internals"
  if (/(^|\/)node_modules(\/|$)/.test(normalized)) return "dependency-tree"
  return null
}

/**
 * Validate one evidence request. `state` carries the per-run counter so the
 * run-level cap is enforced.
 */
export function authorizeEvidenceRequest(request = {}, options = {}) {
  const root = String(options.root || options.workspaceRoot || "")
  const state = options.state || { requestsThisRun: 0 }
  const kind = String(request.kind || "").toLowerCase()
  const target = request.target ? String(request.target) : ""
  const violations = []

  if (!EVIDENCE_KINDS[kind]) violations.push("kind-not-allowlisted")
  if (state.requestsThisRun >= MAX_REQUESTS_PER_RUN) violations.push("run-cap-exhausted")

  if (target) {
    if (!root) violations.push("workspace-root-unknown")
    else if (!isInsideWorkspace(root, target)) violations.push("outside-workspace")
    const forbidden = forbiddenPath(target)
    if (forbidden) violations.push(forbidden)
    if (/\.\./.test(target)) violations.push("traversal")
  }

  if (violations.length) {
    return {
      allowed: false,
      kind,
      target: target || null,
      violations,
      reason: violations[0],
      policy: EVIDENCE_REQUEST_POLICY,
    }
  }

  return {
    allowed: true,
    kind,
    target: target || null,
    maxChars: EVIDENCE_KINDS[kind].maxChars,
    violations: [],
    reason: "allowlisted",
    policy: EVIDENCE_REQUEST_POLICY,
  }
}

/**
 * Redact + bound an evidence payload into the delta that may be sent back to
 * DeepSeek. Never returns raw content: secret detectors run first, then the
 * size bound, then a final secret scan (fail-closed).
 */
export function prepareEvidenceDelta(input = {}) {
  const kind = String(input.kind || "").toLowerCase()
  const spec = EVIDENCE_KINDS[kind]
  if (!spec) {
    return {
      ok: false,
      blocked: "kind-not-allowlisted",
      kind,
      text: "",
      chars: 0,
      redactionApplied: false,
      truncated: false,
      secretScanClean: false,
      evidenceRef: null,
    }
  }
  const maxChars = Math.min(spec.maxChars, int(input.maxChars, spec.maxChars, 200, spec.maxChars))
  const raw = String(input.data ?? input.text ?? "")
  const redaction = redactSecrets(raw)
  let redacted = String(redaction.text ?? raw)
  const redactionApplied = redacted !== raw || redaction.redacted === true
  let truncated = false
  if (redacted.length > maxChars) {
    // The marker is part of the budget: a delta never exceeds its own bound.
    redacted = redacted.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
    truncated = true
  }
  const secretScanClean = !containsUnmaskedSecret(redacted)
  const evidenceRef = `evidence:sha256:${sha256(kind + "\n" + raw)}`
  return {
    ok: secretScanClean,
    blocked: secretScanClean ? null : "secret-scan-failed",
    kind,
    text: secretScanClean ? redacted : "",
    chars: secretScanClean ? redacted.length : 0,
    rawChars: raw.length,
    redactionApplied,
    redactionMask: redactionApplied ? REDACTION_MASK : null,
    truncated,
    secretScanClean,
    evidenceRef,
    requestedChars: maxChars,
    provenance: "DERIVED",
  }
}

/** Per-run evidence request budget with explicit counters. */
export function createEvidenceRequestBudget() {
  let requestsThisRun = 0
  const counters = {
    parsed: 0,
    authorized: 0,
    denied: 0,
    deltasPrepared: 0,
    redactions: 0,
    truncations: 0,
    secretBlocks: 0,
    deniedByReason: Object.create(null),
  }
  return {
    get requestsThisRun() {
      return requestsThisRun
    },
    authorize(request, options = {}) {
      counters.parsed += 1
      const decision = authorizeEvidenceRequest(request, { ...options, state: { requestsThisRun } })
      if (decision.allowed) {
        requestsThisRun += 1
        counters.authorized += 1
      } else {
        counters.denied += 1
        counters.deniedByReason[decision.reason] = (counters.deniedByReason[decision.reason] || 0) + 1
      }
      return decision
    },
    prepare(input) {
      const delta = prepareEvidenceDelta(input)
      if (delta.ok) counters.deltasPrepared += 1
      if (delta.redactionApplied) counters.redactions += 1
      if (delta.truncated) counters.truncations += 1
      if (!delta.secretScanClean) counters.secretBlocks += 1
      return delta
    },
    parse(text, options) {
      const parsed = parseEvidenceRequests(text, options)
      for (const row of parsed.rejected) {
        counters.denied += 1
        counters.deniedByReason[row.reason] = (counters.deniedByReason[row.reason] || 0) + 1
      }
      return parsed
    },
    telemetry() {
      return {
        schemaVersion: EVIDENCE_REQUEST_SCHEMA_VERSION,
        policy: EVIDENCE_REQUEST_POLICY,
        requestsThisRun: measured(requestsThisRun),
        maxPerRun: derived(MAX_REQUESTS_PER_RUN),
        maxPerExchange: derived(MAX_REQUESTS_PER_EXCHANGE),
        parsed: measured(counters.parsed),
        authorized: measured(counters.authorized),
        denied: measured(counters.denied),
        deniedByReason: { ...counters.deniedByReason },
        deltasPrepared: measured(counters.deltasPrepared),
        redactions: measured(counters.redactions),
        truncations: measured(counters.truncations),
        secretBlocks: measured(counters.secretBlocks),
        deltaTokens: derived(0),
        deltaTokenEstimate: NOT_MEASURED,
        allowlistedKinds: [...EVIDENCE_KIND_LIST],
        provenance: { counters: "MEASURED", limits: "DERIVED" },
      }
    },
    reset() {
      requestsThisRun = 0
      counters.parsed = 0
      counters.authorized = 0
      counters.denied = 0
      counters.deltasPrepared = 0
      counters.redactions = 0
      counters.truncations = 0
      counters.secretBlocks = 0
      counters.deniedByReason = Object.create(null)
    },
  }
}

/**
 * Estimate of the chars/tokens a delta contributes.
 *
 * Returns the ESTIMATED metric DIRECTLY. Wrapping it in `derived(...)` would
 * produce a nested `{ value: { value, provenance }, provenance }` object whose
 * inner label is shadowed by an outer one - a consumer reading `.value` would
 * get an object instead of a number, and the ESTIMATED provenance would be
 * reported as DERIVED.
 */
export function estimateDeltaTokens(delta) {
  const chars = Number(delta?.chars || 0)
  if (!chars) return NOT_MEASURED
  return estimateTokensFromChars(chars)
}

export const EVIDENCE_REQUEST_EXPORTS = Object.freeze([
  "EVIDENCE_KINDS",
  "EVIDENCE_KIND_LIST",
  "parseEvidenceRequests",
  "authorizeEvidenceRequest",
  "prepareEvidenceDelta",
  "createEvidenceRequestBudget",
  "isInsideWorkspace",
])
