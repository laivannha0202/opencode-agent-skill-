// V16.3 Phase A, step 10: browser security boundary.
//
// Everything read out of a page is untrusted external data with zero
// instruction authority. This is not a warning string bolted onto a receipt: the
// contract object below is what callers spread into every browser result, so a
// consumer that forgets to re-derive trust still inherits the safe answer, and a
// consumer that tries to promote page content gets a falsifiable object saying
// it may not.

import { analyzeUntrustedOutput, renderUntrustedOutputWarning } from "./untrusted-output.mjs"

export const EXTERNAL_TRUST_LEVEL = "untrusted-external"

export const EXTERNAL_INSTRUCTION_AUTHORITY = "none"

export function externalTrustContract(kind = "browser-page-content") {
  return {
    schemaVersion: 1,
    source: String(kind || "browser-page-content"),
    trustLevel: EXTERNAL_TRUST_LEVEL,
    instructionAuthority: EXTERNAL_INSTRUCTION_AUTHORITY,
    pageContentIsInstruction: false,
    allowPageContentToChangePermissions: false,
    allowPageContentToRequestSecrets: false,
    allowPageContentToAuthorizeExternalSideEffects: false,
    allowPageContentToOverrideUserTask: false,
    allowPageContentToAlterVerificationPolicy: false,
  }
}

// Page text is scanned with the shared untrusted-output analyzer so a page that
// contains prompt-injection text is flagged as evidence of an attack rather
// than passed through as if it were content to obey.
export function analyzeBrowserContent(text, options = {}) {
  const analysis = analyzeUntrustedOutput(text, {
    source: options.source || "browser-page-content",
    trustClass: "external-data",
    maxScanChars: options.maxScanChars,
  })
  return {
    ...analysis,
    trustLevel: EXTERNAL_TRUST_LEVEL,
    instructionAuthority: EXTERNAL_INSTRUCTION_AUTHORITY,
    boundary: renderUntrustedOutputWarning(analysis, { source: options.source || "browser-page-content" }),
  }
}

// Fail-closed helper: any caller that would let external content widen authority
// gets refused here rather than relying on every call site remembering.
export function assertExternalContentCannotGrantAuthority(request = {}) {
  const violations = []
  if (request.allowPageContentToChangePermissions === true) violations.push("allowPageContentToChangePermissions")
  if (request.allowPageContentToRequestSecrets === true) violations.push("allowPageContentToRequestSecrets")
  if (request.allowPageContentToAuthorizeExternalSideEffects === true) violations.push("allowPageContentToAuthorizeExternalSideEffects")
  if (request.allowPageContentToOverrideUserTask === true) violations.push("allowPageContentToOverrideUserTask")
  if (request.allowPageContentToAlterVerificationPolicy === true) violations.push("allowPageContentToAlterVerificationPolicy")
  if (request.trustLevel && request.trustLevel !== EXTERNAL_TRUST_LEVEL) violations.push("trustLevel")
  return {
    allowed: violations.length === 0,
    violations,
    trustLevel: EXTERNAL_TRUST_LEVEL,
    instructionAuthority: EXTERNAL_INSTRUCTION_AUTHORITY,
    reason: violations.length === 0 ? "external-content-cannot-grant-authority" : "authority-escalation-refused",
  }
}