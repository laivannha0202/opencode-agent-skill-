// V16.3 DeepSeek live smoke result semantics.
//
// The bridge proved itself end-to-end (auth -> fill once -> unique Send ->
// submit once -> scoped polling -> parsed JSON -> local verifier ran) and the
// local verifier REJECTED the advice. That is a valid safe system outcome, not
// an integration failure. This module separates:
//
//   A. TRANSPORT / INTEGRATION SUCCESS (did the bridge operate?)
//   B. ADVICE ACCEPTANCE (did the local verifier trust the advice?)
//
// PASS means A is fully verified, regardless of B. B is reported separately
// as `adviceAccepted`. Rejected advice must never produce advisorText and must
// never authorize action; that invariant lives in the runtime verifier, which
// this module does not weaken.
//
// Safety: verification summaries carry bounded structural fields only
// (counts, status/rejection tokens, safe repo-relative paths). Raw DeepSeek
// prose (summary, hypotheses, approaches, risks, edge cases, suggestions) is
// never printed here.

export const DEEPSEEK_SMOKE_INTEGRATION_CHECKS = Object.freeze([
  "sessionStarted",
  "promptFilled",
  "promptSubmitted",
  "responseExtracted",
  "structuredParser",
  "localVerifierRan",
  "cleanupRan",
]);

function isFiniteConfidence(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether the local verifier ran for this result. True only when a
 * verification object with a boolean `accepted` field is present. A parser
 * failure, timeout, or transport failure has no verification.
 */
export function didLocalVerifierRun(result = {}) {
  return Boolean(result && result.verification && typeof result.verification.accepted === "boolean");
}

/**
 * Compute the bounded integration checks from browser evidence + result.
 * Counters are the smoke-layer fill/click/answer-read counts (never telemetry
 * inference). `cleanupRan` is true when the lane was closed (smoke always
 * closes; callers pass false only when cleanup contractually failed).
 */
export function computeIntegrationChecks({ result = {}, telemetry = {}, counters = {}, cleanupRan = true } = {}) {
  return {
    sessionStarted: Number(telemetry.webReasoningEscalations || 0) > 0,
    promptFilled: Number(counters.fillAttempts || 0) === 1,
    promptSubmitted: Number(counters.submitAttempts || 0) === 1,
    responseExtracted: Boolean(result?.advice?.summary),
    structuredParser: Boolean(result?.advice && isFiniteConfidence(result.advice.confidence)),
    localVerifierRan: didLocalVerifierRun(result),
    cleanupRan: cleanupRan === true,
  };
}

export function isIntegrationVerified(checks = {}) {
  return DEEPSEEK_SMOKE_INTEGRATION_CHECKS.every((key) => checks[key] === true);
}

function isConsultationOutcome(outcome) {
  return outcome === "advised" || outcome === "advice-rejected";
}

/**
 * Evaluate the final smoke status.
 *
 * PASS when every integration check holds AND the lane completed a
 * consultation with a parsed response that reached the verifier
 * (outcome advised OR advice-rejected). Advice rejection itself is NOT a
 * failure; it is reported via `adviceAccepted: false`.
 *
 * FAIL for auth, browser-unavailable, UI_CHANGED, submit/answer/parser
 * failures, duplicate submit, and any integration gap. Callers keep their
 * existing early returns for NEEDS_AUTH/UI_CHANGED/UNAVAILABLE/TIMEOUT; this
 * helper governs only the final advised/rejected branch.
 */
export function evaluateDeepSeekSmokeResult({ result = {}, telemetry = {}, counters = {}, cleanupRan = true } = {}) {
  const checks = computeIntegrationChecks({ result, telemetry, counters, cleanupRan });
  const integrationVerified = isIntegrationVerified(checks);
  const outcome = String(result?.outcome || "");
  const consultationCompleted = isConsultationOutcome(outcome) && checks.responseExtracted && checks.structuredParser;
  const responseParsed = checks.responseExtracted && checks.structuredParser;
  const adviceAccepted = outcome === "advised" && result?.verification?.accepted === true;
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const status = integrationVerified && consultationCompleted && isConsultationOutcome(outcome) ? "PASS" : "FAIL";
  return {
    status,
    checks,
    failedChecks,
    integrationVerified,
    consultationCompleted,
    responseParsed,
    adviceAccepted,
    localVerifierRan: checks.localVerifierRan,
    outcome,
  };
}

// Repo-relative path shape. Absolute paths, traversals, env refs, and
// overlong values are withheld rather than printed.
const SAFE_REPO_PATH = /^[A-Za-z0-9._\-/]{1,200}$/;

function safePath(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value);
  if (!raw) return null;
  if (!SAFE_REPO_PATH.test(raw)) return "[withheld-non-repo-path]";
  if (raw.startsWith("/") || raw.includes("..") || raw.includes("$") || raw.includes("\0")) {
    return "[withheld-non-repo-path]";
  }
  return raw.slice(0, 200);
}

/**
 * Bounded, prose-free verification summary. Exposes counts plus per-rejection
 * structural fields (status, rejection, safe path) for the synthetic known
 * files. Never includes advice prose, confidence narratives, or raw model
 * text.
 */
export function safeVerificationSummary(verification = {}, knownFiles = []) {
  const known = new Set((Array.isArray(knownFiles) ? knownFiles : []).map((p) => String(p)));
  const rejections = Array.isArray(verification?.rejections) ? verification.rejections : [];
  const confirmations = Array.isArray(verification?.confirmations) ? verification.confirmations : [];
  const safeRejections = rejections.slice(0, 8).map((row) => {
    const status = String(row?.status || "").slice(0, 40) || null;
    const rejection = String(row?.rejection || row?.reason || "").slice(0, 80) || null;
    const path = row?.path === null || row?.path === undefined ? null : safePath(row.path);
    const out = { rejection, status };
    if (path !== null) out.path = path;
    // Mark whether the claimed path was part of the synthetic known set.
    // Membership is metadata, not prose.
    if (row?.path !== null && row?.path !== undefined && typeof row.path === "string") {
      out.knownFile = known.has(String(row.path));
    }
    return out;
  });
  return {
    verificationAccepted: verification?.accepted === true,
    verificationRejectionCount: Number(verification?.rejectionCount ?? rejections.length) || 0,
    verificationConfirmations: Number(confirmations.length) || 0,
    verificationRejections: safeRejections,
  };
}
