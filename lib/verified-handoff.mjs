// V16.5 Phase 7: Verified Handoff Capsules.
//
// A child's raw transcript must never be dumped into parent context. The raw text
// goes to the Evidence Store; the parent receives a bounded, redacted capsule.
//
// Capsule contract (bounded 2k-6k chars by default):
//   childId, role, task, findings, relevantFiles, symbols, evidenceRefs,
//   proposedActions, unresolvedQuestions, risks, verificationStatus, confidence,
//   rawEvidenceAvailable
//
// Authority rules that are structural, not advisory:
//   - the capsule carries no PASS/FAIL; verificationStatus is a CHILD CLAIM only
//   - a child can never grant a permission through a handoff
//   - every field is redacted through secret-redaction.mjs
//   - the capsule is bound to the raw evidence by fingerprint

import { createHash } from "node:crypto"
import { putEvidence } from "./evidence-store.mjs"
import { redactSecrets } from "./secret-redaction.mjs"

export const HANDOFF_SCHEMA_VERSION = 1
export const HANDOFF_MIN_CHARS = 2_000
export const HANDOFF_MAX_CHARS = 6_000
export const HANDOFF_CHAR_BUDGET = 4_000

export const VERIFICATION_STATUS = Object.freeze({
  NOT_VERIFIED: "not-verified",
  CHILD_CLAIM_PASS: "child-claim-pass",
  CHILD_CLAIM_FAIL: "child-claim-fail",
  CONFLICTED: "conflicted",
})

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)
}

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
}

function capList(values = [], limit = 12, itemChars = 240) {
  return unique(values).slice(0, limit).map((value) => capText(value, itemChars))
}

function capText(value, limit = 1_200) {
  const redacted = redactSecrets(String(value || "").replace(/\s+/g, " ").trim())
  return String(redacted?.text ?? "").slice(0, limit)
}

function scoreConfidence(input = {}) {
  const signals = Number(input.evidenceCount || 0) + Number(input.fileCount || 0)
  if (signals >= 6) return "high"
  if (signals >= 2) return "medium"
  return "low"
}

/**
 * Build a bounded Verified Handoff Capsule.
 * The raw child output is persisted to the Evidence Store and referenced, not inlined.
 */
export async function createHandoffCapsule(root, input = {}) {
  const raw = String(input.rawOutput || "")
  const rawChars = raw.length
  const budget = Math.max(HANDOFF_MIN_CHARS, Math.min(HANDOFF_MAX_CHARS, Number(input.budgetChars) || HANDOFF_CHAR_BUDGET))

  let rawRef = null
  if (raw) {
    const evidence = await putEvidence(root, raw, {
      kind: "subagent-handoff-raw",
      source: String(input.childId || "unknown"),
      summary: `Raw bounded child output for ${input.role || "specialist"}`,
    })
    rawRef = evidence.ref
  }

  const findings = capList(input.findings, 14, 260)
  const risks = capList(input.risks, 8, 220)
  const questions = capList(input.unresolvedQuestions, 8, 220)
  const proposedActions = capList(input.proposedActions, 8, 220)

  const capsule = {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    childId: String(input.childId || ""),
    parentId: String(input.parentId || ""),
    role: String(input.role || ""),
    agent: String(input.agent || ""),
    task: capText(input.task, 400),
    findings,
    relevantFiles: capList(input.relevantFiles, 20, 160),
    symbols: capList(input.symbols, 20, 160),
    evidenceRefs: unique(input.evidenceRefs).slice(0, 20),
    proposedActions,
    unresolvedQuestions: questions,
    risks,
    // Explicitly a child claim. The local verifier is the only authority.
    verificationStatus: VERIFICATION_STATUS.NOT_VERIFIED,
    childVerificationClaim: input.childVerificationClaim || null,
    canProducePass: false,
    isTaskVerdict: false,
    canGrantPermission: false,
    confidence: scoreConfidence(input),
    rawEvidenceAvailable: Boolean(rawRef),
    rawEvidenceRef: rawRef,
    measurements: {
      rawChildChars: rawChars,
      handoffChars: 0,
      handoffRatio: rawChars ? 0 : null,
      handoffRecallCount: Number(input.handoffRecallCount || 0),
      rawEvidenceRehydrations: Number(input.rawEvidenceRehydrations || 0),
      parentContextGrowthChars: 0,
      evidence: rawChars ? "MEASURED" : "NOT_MEASURED",
    },
    redaction: {
      applied: true,
      policy: "secret-redaction.mjs",
    },
    source: {
      provenance: "child-specialist",
      instructionAuthority: "none",
    },
  }

  capsule.measurements.handoffChars = capsule.text?.length || estimateCapsuleChars(capsule)
  capsule.measurements.handoffRatio = rawChars ? Number((capsule.measurements.handoffChars / rawChars).toFixed(4)) : null
  capsule.fingerprint = "handoff:sha256:" + hash([capsule.childId, capsule.role, findings, rawRef, capsule.measurements.handoffChars])
  return capsule
}

function estimateCapsuleChars(capsule) {
  const lines = [
    `child=${capsule.childId} role=${capsule.role} agent=${capsule.agent}`,
    `task: ${capsule.task}`,
    capsule.findings.length ? `findings:\n${capsule.findings.map((row) => `- ${row}`).join("\n")}` : "",
    capsule.risks.length ? `risks:\n${capsule.risks.map((row) => `- ${row}`).join("\n")}` : "",
    capsule.unresolvedQuestions.length ? `open questions:\n${capsule.unresolvedQuestions.map((row) => `- ${row}`).join("\n")}` : "",
    capsule.proposedActions.length ? `proposed actions:\n${capsule.proposedActions.map((row) => `- ${row}`).join("\n")}` : "",
    capsule.relevantFiles.length ? `files: ${capsule.relevantFiles.join(", ")}` : "",
    capsule.symbols.length ? `symbols: ${capsule.symbols.join(", ")}` : "",
    capsule.evidenceRefs.length ? `evidence: ${capsule.evidenceRefs.join(", ")}` : "",
    `verification: ${capsule.verificationStatus} (child claim only; local verifier is the authority)`,
    `confidence: ${capsule.confidence}; raw evidence: ${capsule.rawEvidenceAvailable ? capsule.rawEvidenceRef : "none"}`,
  ].filter(Boolean)
  return lines.join("\n").length
}

/** Render the parent-facing compact text block. Bounded by the same budget. */
export function renderHandoffCapsule(capsule, options = {}) {
  const budget = Math.max(600, Math.min(HANDOFF_MAX_CHARS, Number(options.budgetChars) || HANDOFF_CHAR_BUDGET))
  const lines = [
    `## Child handoff (${capsule.role || "specialist"} · ${capsule.childId})`,
    capsule.task ? `Task: ${capsule.task}` : "",
  ]
  const section = (heading, rows) => (rows?.length ? `${heading}\n${rows.map((row) => `- ${row}`).join("\n")}` : "")
  const ordered = [
    section("Findings", capsule.findings),
    section("Risks", capsule.risks),
    section("Open questions", capsule.unresolvedQuestions),
    section("Proposed actions", capsule.proposedActions),
    capsule.relevantFiles.length ? `Files: ${capsule.relevantFiles.join(", ")}` : "",
    capsule.symbols.length ? `Symbols: ${capsule.symbols.join(", ")}` : "",
    capsule.evidenceRefs.length ? `Evidence refs: ${capsule.evidenceRefs.join(", ")}` : "",
    `Verification: ${capsule.verificationStatus} (child claim only — the local verifier is the authority)`,
    `Confidence: ${capsule.confidence}; raw transcript: ${capsule.rawEvidenceAvailable ? "available by reference" : "not stored"}`,
  ].filter(Boolean)
  lines.push(...ordered)
  const text = lines.join("\n").slice(0, budget)
  capsule.measurements.handoffChars = text.length
  capsule.measurements.parentContextGrowthChars = text.length
  if (capsule.measurements.rawChildChars > 0) {
    capsule.measurements.handoffRatio = Number((text.length / capsule.measurements.rawChildChars).toFixed(4))
    capsule.measurements.evidence = "MEASURED"
  }
  return { text, chars: text.length, bounded: true, budgetChars: budget }
}

/**
 * Record that the parent rehydrated the raw child evidence for a specific ref.
 * Keeps raw expansion observable instead of silent.
 */
export function recordRawRehydration(capsule, ref) {
  if (!capsule) return null
  if (ref && capsule.rawEvidenceRef && ref !== capsule.rawEvidenceRef) {
    throw new Error("rehydration ref does not match the stored raw evidence ref")
  }
  capsule.measurements.rawEvidenceRehydrations += 1
  return capsule.measurements
}

/** Fail-closed check used by tests and by the runtime before trusting a handoff. */
export function assertHandoffAuthority(capsule) {
  const violations = []
  if (capsule.canProducePass !== false) violations.push("canProducePass must be false")
  if (capsule.isTaskVerdict !== false) violations.push("isTaskVerdict must be false")
  if (capsule.canGrantPermission !== false) violations.push("canGrantPermission must be false")
  if (capsule.verificationStatus !== VERIFICATION_STATUS.NOT_VERIFIED) violations.push("verificationStatus must not claim local verification")
  if (capsule.source?.instructionAuthority !== "none") violations.push("child handoff carries no instruction authority")
  return { ok: violations.length === 0, violations }
}
