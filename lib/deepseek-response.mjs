// V16.3 Phase B, steps 13, 18, 19 and 22: the DeepSeek response parser.
//
// A web model returns text. That text is UNTRUSTED EXTERNAL ADVICE, and this is
// the only place it becomes a structured object. The rules, in order:
//
//   1. Bounded. A response is a fixed number of characters and a fixed schema.
//      A megabyte of prose does not become a megabyte of hypotheses.
//   2. Schema-validated. Missing required fields are REFUSED, not defaulted to
//      something plausible. A parser that invents a confidence value is worse
//      than one that returns nothing.
//   3. Authority-stripped. The parser scans for attempts to grant permission,
//      demand secrets, or assert a verdict, records them as findings, and the
//      advice object physically cannot carry an authority field.
//   4. Evidence-bound. Claims that name a file/symbol are bound to what the local
//      repo actually contains; a claim about a file that does not exist is marked
//      unverified rather than silently trusted.

import { analyzeUntrustedOutput } from "./untrusted-output.mjs"
import { externalTrustContract } from "./browser-security.mjs"
import { isExcludedPacketPath } from "./decision-packet.mjs"

export const DEEPSEEK_ADVICE_SCHEMA = Object.freeze({
  summary: "string",
  hypotheses: "string[]",
  recommendedApproach: "string[]",
  filesToInspect: "string[]",
  risks: "string[]",
  edgeCases: "string[]",
  verificationSuggestions: "string[]",
  confidence: "number",
})

export const DEEPSEEK_REQUIRED_FIELDS = Object.freeze([
  "summary",
  "hypotheses",
  "recommendedApproach",
  "risks",
  "verificationSuggestions",
  "confidence",
])

export const DEEPSEEK_PARSE_FAILURE = Object.freeze({
  EMPTY: "deepseek-response-empty",
  NOT_JSON: "deepseek-response-not-json",
  SCHEMA: "deepseek-response-schema-invalid",
  OVERSIZE: "deepseek-response-oversize",
  CONFIDENCE: "deepseek-response-confidence-invalid",
  PROMPT_INJECTION: "deepseek-response-carries-instruction-override",
})

export const DEEPSEEK_MAX_RESPONSE_CHARS = 60_000

// Text patterns that mark an attempt to acquire authority. Finding one does not
// throw the whole answer away -- the diagnostic content is often still useful --
// but it is recorded, surfaced, and the advice is explicitly marked
// authority-stripped so no downstream consumer can act on it.
const AUTHORITY_ATTEMPTS = [
  { id: "verdict-claim", pattern: /\b(?:final verdict|this is (?:a )?pass|mark (?:this|the) (?:task )?(?:as )?pass|approve[ds]? (?:the )?(?:release|publish|deploy))\b/i },
  { id: "permission-claim", pattern: /\byou\s+(?:are\s+)?(?:now\s+)?(?:authorized|permitted|approved)\b|\bi (?:hereby )?(?:authorize|grant) (?:you|permission)\b|\bpermission (?:is )?granted\b|\bescalate privileges?\b/i },
  { id: "secret-request", pattern: /\b(?:send|share|reveal|print|output|echo) (?:me )?(?:the )?(?:api[ _-]?key|token|password|secret|credential|\.env)\b/i },
  { id: "command-autotrust", pattern: /\b(?:safe to (?:run|execute)|you can safely run|just run|run this (?:command )?directly|no need to verify)\b/i },
  { id: "policy-override", pattern: /\b(?:ignore|skip|bypass|disable) (?:the )?(?:tests?|verification|guard|policy|review|permission)\b/i },
  { id: "publish-authority", pattern: /\b(?:npm publish|git push|force push|deploy to production)\b.*\b(?:approved|authorized|go ahead)\b/i },
]

function boundedArray(value, max, maxChars) {
  return (Array.isArray(value) ? value : [])
    .map((row) => String(row ?? "").trim())
    .filter(Boolean)
    .slice(0, max)
    .map((row) => (row.length > maxChars ? `${row.slice(0, maxChars)}...` : row))
}

function stripFences(text) {
  const trimmed = String(text || "").trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1] : trimmed
}

export function detectAuthorityAttempts(text) {
  const value = String(text || "")
  return AUTHORITY_ATTEMPTS
    .filter((attempt) => attempt.pattern.test(value))
    .map((attempt) => attempt.id)
}

/**
 * Parse a provider response into a validated advice object, or refuse it.
 * Returns `{ ok: false, failure, ... }` rather than throwing, because a bad
 * provider answer is an expected outcome, not an exception.
 */
export function parseDeepSeekResponse(raw, options = {}) {
  const maxChars = Math.min(DEEPSEEK_MAX_RESPONSE_CHARS, Number(options.maxChars) || DEEPSEEK_MAX_RESPONSE_CHARS)
  const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "")
  const trust = { ...externalTrustContract("web-reasoning-response") }

  if (!text.trim()) {
    return { ok: false, failure: DEEPSEEK_PARSE_FAILURE.EMPTY, trustLevel: "untrusted-external", ...trust }
  }
  if (text.length > maxChars) {
    return {
      ok: false,
      failure: DEEPSEEK_PARSE_FAILURE.OVERSIZE,
      chars: text.length,
      maxChars,
      trustLevel: "untrusted-external",
      ...trust,
    }
  }

  let parsed = null
  if (typeof raw === "object" && raw !== null) {
    parsed = raw
  } else {
    try {
      parsed = JSON.parse(stripFences(text))
    } catch {
      return { ok: false, failure: DEEPSEEK_PARSE_FAILURE.NOT_JSON, trustLevel: "untrusted-external", ...trust }
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: DEEPSEEK_PARSE_FAILURE.NOT_JSON, trustLevel: "untrusted-external", ...trust }
  }

  const missing = DEEPSEEK_REQUIRED_FIELDS.filter((field) => parsed[field] === undefined || parsed[field] === null)
  if (missing.length) {
    return {
      ok: false,
      failure: DEEPSEEK_PARSE_FAILURE.SCHEMA,
      missing,
      trustLevel: "untrusted-external",
      ...trust,
    }
  }

  const confidence = Number(parsed.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return {
      ok: false,
      failure: DEEPSEEK_PARSE_FAILURE.CONFIDENCE,
      confidence: parsed.confidence,
      trustLevel: "untrusted-external",
      ...trust,
    }
  }

  const injection = analyzeUntrustedOutput(text, {
    source: "deepseek-web-response",
    trustClass: "external-data",
  })
  const authorityAttempts = detectAuthorityAttempts(text)

  const advice = {
    summary: String(parsed.summary).trim().slice(0, 2_000),
    hypotheses: boundedArray(parsed.hypotheses, 8, 400),
    recommendedApproach: boundedArray(parsed.recommendedApproach, 10, 400),
    filesToInspect: boundedArray(parsed.filesToInspect, 20, 200),
    risks: boundedArray(parsed.risks, 10, 400),
    edgeCases: boundedArray(parsed.edgeCases, 10, 400),
    verificationSuggestions: boundedArray(parsed.verificationSuggestions, 10, 400),
    confidence: Number(confidence.toFixed(3)),
  }

  const filesBound = bindClaimsToLocalEvidence(advice, options)
  const flagged = injection.flagged || authorityAttempts.length > 0

  return {
    ok: true,
    advice: {
      ...advice,
      // Embedded so a caller that keeps only `parsed.advice` does not silently
      // lose the evidence binding and downgrade a precise rejection
      // ("named file does not exist") into a vague one ("nothing verifiable").
      evidenceBinding: filesBound,
    },
    // Findings, not filters: the caller decides what to do with them, and the
    // decision is recorded either way.
    injection,
    authorityAttempts,
    flagged,
    // The advice can never assert a verdict. These fields are here so a consumer
    // that only reads flags gets the safe answer.
    producesVerdict: false,
    authority: "consultant-only",
    mayChangePermissions: false,
    mayAuthorizeSideEffects: false,
    mayRequestSecrets: false,
    evidenceBinding: filesBound,
    trustLevel: "untrusted-external",
    ...trust,
  }
}

// Maps "files to inspect" back onto what the local repository actually has.
// A consultant naming a file that does not exist is not automatically wrong --
// it may be proposing a new file -- but it MUST be distinguishable from a claim
// about existing code, because that is the difference between "check this" and
// "you made this up".
export function bindClaimsToLocalEvidence(advice = {}, options = {}) {
  const known = new Set(
    (Array.isArray(options.knownFiles) ? options.knownFiles : []).map((path) => String(path).replaceAll("\\", "/")),
  )
  const rows = (advice.filesToInspect || []).map((claim) => {
    const path = String(claim).replaceAll("\\", "/").replace(/^['"`]|['"`]$/g, "").trim()
    const normalized = path.replace(/^\.\//, "")
    if (!path) return { claim, path: null, status: "unbound", reason: "empty-claim" }
    if (isExcludedPacketPath(normalized)) {
      return { claim, path: normalized, status: "rejected", reason: "excluded-path" }
    }
    if (!known.size) {
      return { claim, path: normalized, status: "unverified", reason: "no-local-file-index-provided" }
    }
    return known.has(normalized)
      ? { claim, path: normalized, status: "present", reason: "exists-in-repository" }
      : { claim, path: normalized, status: "absent", reason: "not-found-in-repository" }
  })
  return {
    schemaVersion: 1,
    kind: "ues-advice-evidence-binding",
    claims: rows,
    present: rows.filter((row) => row.status === "present").length,
    absent: rows.filter((row) => row.status === "absent").length,
    rejected: rows.filter((row) => row.status === "rejected").length,
    unverified: rows.filter((row) => row.status === "unverified").length,
  }
}

/**
 * Local verification of provider advice.
 *
 * This is the function that keeps DeepSeek a consultant: it can ACCEPT or REJECT
 * a suggestion, and it can only do so against local evidence (files, symbols,
 * test/runtime results) that Pi itself produced. It has no output that reads as
 * a task verdict, and it cannot run anything.
 */
export function verifyLocalAdvice(adviceOrResult = {}, evidence = {}) {
  // Accepts either a bare advice object or the full parse result. Handing it
  // `parsed.advice` alone silently dropped the evidence binding, which turned
  // "the file it named does not exist" into "no verifiable claim" -- a weaker
  // and much vaguer rejection.
  const envelope = adviceOrResult && typeof adviceOrResult === "object" ? adviceOrResult : {}
  const advice = envelope.advice && typeof envelope.advice === "object" ? envelope.advice : envelope
  const binding = envelope.evidenceBinding || advice.evidenceBinding || { claims: [] }
  const rejections = []
  const confirmations = []

  for (const claim of binding.claims || []) {
    if (claim.status === "present") confirmations.push(claim)
    else if (claim.status === "rejected") rejections.push({ ...claim, rejection: "rejected-excluded-path" })
    else if (claim.status === "absent") rejections.push({ ...claim, rejection: "referenced-file-not-in-repository" })
  }

  // A recommendation that names no verifiable file at all is unverifiable, and
  // unverifiable advice is recorded as such rather than waved through.
  const verifiable = confirmations.length + rejections.length
  if (verifiable === 0 && (advice.recommendedApproach || []).length > 0) {
    rejections.push({ claim: null, path: null, status: "unverifiable", rejection: "no-locally-verifiable-claim" })
  }

  const flagged = envelope.flagged === true || advice.flagged === true
  const accepted = !flagged && rejections.length === 0 && (advice.confidence ?? 0) >= (evidence.minConfidence ?? 0.3)

  return {
    schemaVersion: 1,
    kind: "ues-local-advice-verification",
    accepted,
    // An accepted suggestion is still not a pass. This field is the machine
    // readable form of "Pi may now go and edit code, then run the tests".
    actionAuthorized: accepted ? "implement-then-verify" : "reject-and-retry-locally",
    confirmations,
    rejections,
    rejectionCount: rejections.length,
    authorityAttempts: envelope.authorityAttempts || advice.authorityAttempts || [],
    // The shape a final-verdict matrix must never read as PASS.
    isTaskVerdict: false,
    canProducePass: false,
    verificationRequired: evidence.verificationRequired !== false,
    trustLevel: "untrusted-external",
    ...externalTrustContract("web-reasoning-advice"),
  }
}
