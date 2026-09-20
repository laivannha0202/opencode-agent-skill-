import { createHash, randomUUID } from "node:crypto"

const KINDS = new Set(["plan-verification", "integration-verification"])
const VERDICTS = new Set(["PASS", "FAIL", "PARTIAL"])

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex")
}

export function createGateReceipt(input = {}) {
  const kind = String(input.kind || "")
  const verdict = String(input.verdict || "").toUpperCase()
  const evidence = String(input.evidence || "").trim()
  const report = input.report == null ? null : String(input.report)
  return {
    schemaVersion: 1,
    id: randomUUID(),
    kind,
    slug: String(input.slug || ""),
    verdict,
    verifier: String(input.verifier || ""),
    sessionID: input.sessionID ? String(input.sessionID) : null,
    runId: input.runId ? String(input.runId) : null,
    planHash: input.planHash ? String(input.planHash) : null,
    workspaceFingerprint: input.workspaceFingerprint ? String(input.workspaceFingerprint) : null,
    evidence,
    reportHash: report == null ? null : digest(report),
    createdAt: input.createdAt || new Date().toISOString(),
  }
}

export function validateGateReceipt(receipt) {
  const errors = []
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, errors: ["receipt must be an object"] }
  }
  if (receipt.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (!KINDS.has(receipt.kind)) errors.push("invalid gate receipt kind")
  if (!VERDICTS.has(receipt.verdict)) errors.push("invalid gate receipt verdict")
  if (!String(receipt.id || "").trim()) errors.push("receipt id is required")
  if (!String(receipt.slug || "").trim()) errors.push("slug is required")
  if (!String(receipt.verifier || "").trim()) errors.push("verifier is required")
  if (!String(receipt.evidence || "").trim()) errors.push("evidence is required")
  if (!Number.isFinite(Date.parse(receipt.createdAt || ""))) errors.push("createdAt must be an ISO timestamp")
  if (receipt.kind === "plan-verification" && !String(receipt.planHash || "").trim()) {
    errors.push("plan verification receipt requires planHash")
  }
  if (receipt.kind === "integration-verification" && !String(receipt.workspaceFingerprint || "").trim()) {
    errors.push("integration verification receipt requires workspaceFingerprint")
  }
  return { valid: errors.length === 0, errors }
}
