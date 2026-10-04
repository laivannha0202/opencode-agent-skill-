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
import { measured, derived, estimated, NOT_MEASURED, estimateTokensFromChars } from "./measurement-provenance.mjs"

export const EVIDENCE_REQUEST_SCHEMA_VERSION = 2
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

/**
 * V16.6.1 cumulative evidence budget.
 *
 * Counting requests alone was not a budget: every kind individually passed its
 * own size check while `MAX_REQUESTS_PER_RUN` of them could still put 8 x 16k
 * chars on the wire. A run therefore gets BOTH a count budget and a character
 * budget, per exchange and for the whole run.
 */
export const EVIDENCE_LIMITS = Object.freeze({
  maxRequestsPerExchange: 4,
  maxRequestsPerRun: 8,
  maxCharsPerExchange: 24_000,
  maxCharsPerRun: 60_000,
  maxCharsPerRequest: 16_000,
  maxReasonChars: 400,
})

export const MAX_REQUESTS_PER_EXCHANGE = EVIDENCE_LIMITS.maxRequestsPerExchange
export const MAX_REQUESTS_PER_RUN = EVIDENCE_LIMITS.maxRequestsPerRun
export const MAX_CHARS_PER_EXCHANGE = EVIDENCE_LIMITS.maxCharsPerExchange
export const MAX_CHARS_PER_RUN = EVIDENCE_LIMITS.maxCharsPerRun

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
 *
 * V16.6.1: ONE canonical protocol. The advisor reply is JSON (see
 * `lib/deepseek-response.mjs`), and `evidenceRequests` is an OPTIONAL array on
 * that object. The legacy `EVIDENCE: <kind>` line format is still ACCEPTED for
 * backward compatibility with an advisor that ignored the JSON schema, but it
 * is a compatibility PARSER over the same normalized shape - never a second
 * authority path. Both routes converge on `validateEvidenceRequest`.
 */
export function parseEvidenceRequests(text, options = {}) {
  const maxRequests = int(options.maxRequests, MAX_REQUESTS_PER_EXCHANGE, 1, EVIDENCE_LIMITS.maxRequestsPerExchange)
  const source = String(text || "")
  const allowed = []
  const rejected = []
  const seen = new Set()
  const rows = []

  // --- canonical path: JSON `evidenceRequests` array ----------------------
  let structured = null
  if (options.structured !== false) {
    try {
      const parsed = JSON.parse(String(source).replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim())
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.evidenceRequests)) {
        structured = parsed.evidenceRequests
      }
    } catch {
      structured = null
    }
  }
  if (Array.isArray(structured)) {
    for (const row of structured.slice(0, EVIDENCE_LIMITS.maxRequestsPerExchange * 2)) {
      const kind = String(row?.kind || "").toLowerCase()
      const target = row?.target ? String(row.target) : null
      const reason = row?.reason ? String(row.reason).slice(0, EVIDENCE_LIMITS.maxReasonChars) : null
      const decision = validateEvidenceRequest({ kind, target, reason }, { maxRequests })
      for (const violation of decision.violations) rejected.push({ kind, target, reason: violation })
      if (decision.violations.length === 0) allowed.push(decision.request)
    }
  } else {
    // --- compatibility path: `EVIDENCE: <kind>` lines ---------------------
    const lines = source.split(/\r?\n/)
    for (const raw of lines) {
      const match = raw.match(/^\s*(?:evidence-request|evidence)\s*:\s*([a-z0-9-]+)\s*$/i)
      if (!match) continue
      const kind = match[1].toLowerCase()
      const decision = validateEvidenceRequest({ kind }, { maxRequests })
      if (seen.has(kind)) {
        rejected.push({ kind, reason: "duplicate" })
        continue
      }
      seen.add(kind)
      for (const violation of decision.violations) rejected.push({ kind, reason: violation })
      if (decision.violations.length === 0) allowed.push(decision.request)
    }
  }

  return {
    schemaVersion: EVIDENCE_REQUEST_SCHEMA_VERSION,
    policy: EVIDENCE_REQUEST_POLICY,
    protocol: Array.isArray(structured) ? "json" : "legacy-line-compat",
    requests: allowed.slice(0, maxRequests),
    rejected,
    total: allowed.length + rejected.length,
    bounded: allowed.length <= maxRequests,
    maxRequests,
  }
}

/**
 * Shape + policy validation of ONE request. Shared by the canonical JSON path
 * and the legacy line path so neither can be stricter than the other.
 */
function validateEvidenceRequest(request = {}, options = {}) {
  const maxRequests = int(options.maxRequests, MAX_REQUESTS_PER_EXCHANGE, 1, EVIDENCE_LIMITS.maxRequestsPerExchange)
  const kind = String(request.kind || "").toLowerCase()
  const target = request.target ? String(request.target) : ""
  const reason = request.reason ? String(request.reason).slice(0, EVIDENCE_LIMITS.maxReasonChars) : null
  const violations = []
  if (!EVIDENCE_KINDS[kind]) violations.push("kind-not-allowlisted")
  if (reason && String(request.reason).length > EVIDENCE_LIMITS.maxReasonChars) violations.push("reason-over-budget")
  if (target) {
    const forbidden = forbiddenPath(target)
    if (forbidden) violations.push(forbidden)
    if (/(^|[/\\])\.\.([/\\]|$)/.test(target)) violations.push("traversal")
  }
  if (violations.length) return { violations, request: null }
  return {
    violations: [],
    request: {
      kind,
      target: target || null,
      reason,
      maxChars: Math.min(EVIDENCE_KINDS[kind].maxChars, EVIDENCE_LIMITS.maxCharsPerRequest),
      // A request is a REQUEST. It is never a tool invocation, never a
      // permission and never a verdict: the explicit negatives travel with the
      // object so a consumer that only reads flags still refuses.
      isToolInvocation: false,
      mayGrantPermissions: false,
      mayProducePass: false,
    },
  }
}

function isAbsolutePath(value) {
  const text = String(value || "")
  return path.isAbsolute(text) || /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text)
}

/**
 * True when `target` resolves inside `root` (Windows and POSIX).
 *
 * V16.6.1: a RELATIVE target is resolved against the WORKSPACE ROOT, never
 * against `process.cwd()`. Resolving relative to the process directory made
 * containment depend on where the process happened to be started: a run
 * launched from a parent directory could resolve `lib/x.mjs` outside the
 * workspace root it was given.
 */
export function isInsideWorkspace(root, target) {
  if (!root || !target) return false
  let resolvedRoot = ""
  let resolvedTarget = ""
  try {
    resolvedRoot = path.resolve(String(root))
    const raw = String(target)
    resolvedTarget = isAbsolutePath(raw) ? path.resolve(raw) : path.resolve(resolvedRoot, raw)
  } catch {
    return false
  }
  const a = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot
  const b = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget
  if (a === b) return true
  if (!b.startsWith(a + path.sep)) return false
  // Windows drive-letter case (`C:\ws` vs `c:\ws`) is handled above; the
  // separator check below rejects a sibling whose name merely shares a prefix.
  return (resolvedTarget + path.sep).length > (resolvedRoot + path.sep).length
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
  const checked = validateEvidenceRequest(request, { maxRequests: options.maxRequests })
  const kind = String(request.kind || "").toLowerCase()
  const target = request.target ? String(request.target) : ""
  const violations = [...checked.violations]

  if (!EVIDENCE_KINDS[kind]) violations.push("kind-not-allowlisted")
  if (Number(state.requestsThisRun) >= EVIDENCE_LIMITS.maxRequestsPerRun) violations.push("run-cap-exhausted")

  if (target) {
    if (!root) violations.push("workspace-root-unknown")
    else if (!isInsideWorkspace(root, target)) violations.push("outside-workspace")
    const forbidden = forbiddenPath(target)
    if (forbidden) violations.push(forbidden)
  }

  if (violations.length) {
    return {
      allowed: false,
      kind,
      target: target || null,
      violations: [...new Set(violations)],
      reason: violations[0],
      policy: EVIDENCE_REQUEST_POLICY,
    }
  }

  return {
    allowed: true,
    kind,
    target: checked.request.target,
    reason: checked.request.reason,
    maxChars: checked.request.maxChars,
    violations: [],
    reasonCode: "allowlisted",
    isToolInvocation: false,
    mayGrantPermissions: false,
    mayProducePass: false,
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
    // ESTIMATED (chars/4). Never presented as a measured token count.
    tokens: estimateTokensFromChars(secretScanClean ? redacted.length : 0),
    provenance: "DERIVED",
  }
}

/** Per-run evidence request budget with explicit counters. */
export function createEvidenceRequestBudget() {
  let requestsThisRun = 0
  let charsThisRun = 0
  let charsThisExchange = 0
  let requestsThisExchange = 0
  let deltaTokensSent = 0
  const counters = {
    parsed: 0,
    authorized: 0,
    denied: 0,
    deltasPrepared: 0,
    redactions: 0,
    truncations: 0,
    secretBlocks: 0,
    deniedByReason: Object.create(null),
    charsSent: 0,
    exchangeExhaustions: 0,
    runExhaustions: 0,
  }
  return {
    get requestsThisRun() {
      return requestsThisRun
    },
    get charsThisRun() {
      return charsThisRun
    },
    authorize(request, options = {}) {
      counters.parsed += 1
      const decision = authorizeEvidenceRequest(request, {
        ...options,
        state: {
          requestsThisRun,
          charsThisRun,
          requestsThisExchange,
          charsThisExchange,
        },
      })
      // V16.6.1: the CUMULATIVE character budget is enforced here, not per
      // request. Without it N individually-valid requests of 16k chars each
      // were all authorized and then all sent.
      if (decision.allowed && Number(decision.maxChars) > 0) {
        const remainingRun = Math.max(0, EVIDENCE_LIMITS.maxCharsPerRun - charsThisRun)
        const remainingExchange = Math.max(0, EVIDENCE_LIMITS.maxCharsPerExchange - charsThisExchange)
        const room = Math.min(decision.maxChars, remainingRun, remainingExchange)
        if (room < 200) {
          counters.denied += 1
          counters.deniedByReason.charsBudgetExhausted = (counters.deniedByReason.charsBudgetExhausted || 0) + 1
          if (remainingExchange <= 0) counters.exchangeExhaustions += 1
          else counters.runExhaustions += 1
          return {
            allowed: false,
            kind: decision.kind,
            target: decision.target,
            violations: remainingExchange <= 0 ? ["exchange-chars-budget-exhausted"] : ["run-chars-budget-exhausted"],
            reason: remainingExchange <= 0 ? "exchange-chars-budget-exhausted" : "run-chars-budget-exhausted",
            remainingRunChars: remainingRun,
            remainingExchangeChars: remainingExchange,
            policy: EVIDENCE_REQUEST_POLICY,
          }
        }
        const requestedMaxChars = Number(decision.maxChars)
        decision.maxChars = room
        decision.cappedByBudget = room < requestedMaxChars
      }
      if (decision.allowed) {
        requestsThisRun += 1
        requestsThisExchange += 1
        counters.authorized += 1
      } else {
        counters.denied += 1
        counters.deniedByReason[decision.reason] = (counters.deniedByReason[decision.reason] || 0) + 1
      }
      return decision
    },
    prepare(input) {
      const delta = prepareEvidenceDelta(input)
      if (delta.ok) {
        counters.deltasPrepared += 1
        const chars = Number(delta.chars || 0)
        // A prepared delta is charged against the run as soon as it exists.
        // Nothing that leaves the machine is unaccounted for.
        counters.charsSent += chars
        charsThisRun += chars
        charsThisExchange += chars
        deltaTokensSent += Number(delta.tokens?.value || 0)
      }
      if (delta.redactionApplied) counters.redactions += 1
      if (delta.truncated) counters.truncations += 1
      if (!delta.secretScanClean) counters.secretBlocks += 1
      return delta
    },
    /** Reset the PER-EXCHANGE counters. The run counters are never reset. */
    beginExchange() {
      charsThisExchange = 0
      requestsThisExchange = 0
    },
    /**
     * Bounded refusal returned when the budget is exhausted. AUTO continues
     * with local reasoning; nothing crashes and nothing is faked as delivered.
     */
    refusal() {
      const remainingRunChars = Math.max(0, EVIDENCE_LIMITS.maxCharsPerRun - charsThisRun)
      const remainingExchangeChars = Math.max(0, EVIDENCE_LIMITS.maxCharsPerExchange - charsThisExchange)
      const exhausted = remainingRunChars <= 0 || remainingExchangeChars <= 0
      return {
        exhausted,
        requestsThisRun,
        remainingRunChars,
        remainingExchangeChars,
        remainingRunRequests: Math.max(0, EVIDENCE_LIMITS.maxRequestsPerRun - requestsThisRun),
        text: exhausted
          ? `[evidence budget exhausted: ${EVIDENCE_LIMITS.maxCharsPerRun - remainingRunChars}/${EVIDENCE_LIMITS.maxCharsPerRun} run chars used; continuing with local reasoning only]`
          : "",
      };
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
        requestsRequested: measured(counters.parsed),
        requestsThisRun: measured(requestsThisRun),
        requestsAuthorized: measured(counters.authorized),
        requestsDenied: measured(counters.denied),
        maxPerRun: derived(EVIDENCE_LIMITS.maxRequestsPerRun),
        maxPerExchange: derived(EVIDENCE_LIMITS.maxRequestsPerExchange),
        maxCharsPerRun: derived(EVIDENCE_LIMITS.maxCharsPerRun),
        maxCharsPerExchange: derived(EVIDENCE_LIMITS.maxCharsPerExchange),
        deniedByReason: { ...counters.deniedByReason },
        deltasPrepared: measured(counters.deltasPrepared),
        redactions: measured(counters.redactions),
        truncations: measured(counters.truncations),
        secretBlocks: measured(counters.secretBlocks),
        evidenceCharsSent: measured(counters.charsSent),
        // chars/4 is an approximation, so it is ESTIMATED and never DERIVED.
        estimatedEvidenceTokens: estimated(deltaTokensSent),
        providerEvidenceTokens: NOT_MEASURED,
        runBudgetRemainingChars: derived(Math.max(0, EVIDENCE_LIMITS.maxCharsPerRun - charsThisRun)),
        exchangeBudgetRemainingChars: derived(Math.max(0, EVIDENCE_LIMITS.maxCharsPerExchange - charsThisExchange)),
        exchangeExhaustions: measured(counters.exchangeExhaustions),
        runExhaustions: measured(counters.runExhaustions),
        allowlistedKinds: [...EVIDENCE_KIND_LIST],
        provenance: { counters: "MEASURED", limits: "DERIVED", tokens: "ESTIMATED" },
      }
    },
    reset() {
      requestsThisRun = 0
      charsThisRun = 0
      charsThisExchange = 0
      requestsThisExchange = 0
      deltaTokensSent = 0
      counters.parsed = 0
      counters.authorized = 0
      counters.denied = 0
      counters.deltasPrepared = 0
      counters.redactions = 0
      counters.truncations = 0
      counters.secretBlocks = 0
      counters.charsSent = 0
      counters.exchangeExhaustions = 0
      counters.runExhaustions = 0
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
  "EVIDENCE_LIMITS",
  "MAX_CHARS_PER_EXCHANGE",
  "MAX_CHARS_PER_RUN",
  "parseEvidenceRequests",
  "authorizeEvidenceRequest",
  "prepareEvidenceDelta",
  "createEvidenceRequestBudget",
  "isInsideWorkspace",
])
