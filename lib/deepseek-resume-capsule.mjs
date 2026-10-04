// V16.6 DeepSeek session intelligence - resume capsule (part 3 of 4).
//
// When a conversation thread rotates (turn budget, size, errors, idle), the
// successor session must continue WITHOUT the full transcript. The capsule is
// that handoff: bounded, deterministic, secret-free, and it never contains a
// transcript, a credential, a workspace path outside the root, or raw provider
// payload.
//
// Properties:
//   * deterministic fingerprint - no timestamps, no randomness
//   * hard size bound (default 4,000 chars, max 12,000)
//   * every string is passed through the secret redaction detectors
//   * refuses to build if a secret survives redaction (fail-closed)

import { createHash } from "node:crypto"
import { redactStructure, containsUnmaskedSecret, REDACTION_MASK } from "./secret-redaction.mjs"
import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"

export const RESUME_CAPSULE_SCHEMA_VERSION = 1
export const RESUME_CAPSULE_POLICY = "deepseek-resume-capsule-v16-6"
export const DEFAULT_CAPSULE_CHARS = 4_000
export const MAX_CAPSULE_CHARS = 12_000

const MAX_LIST_ITEMS = 12
const MAX_ITEM_CHARS = 400

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function clampItem(value, limit = MAX_ITEM_CHARS) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
}

function boundedList(values, limit = MAX_LIST_ITEMS, itemChars = MAX_ITEM_CHARS) {
  const list = Array.isArray(values) ? values : values ? [values] : []
  const rows = list
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => clampItem(value, itemChars))
    .filter(Boolean)
  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    total: rows.length,
  }
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

/**
 * Deterministic fingerprint over the decision-relevant capsule content only.
 * Two capsules built from the same state hash identically, in any process.
 */
export function resumeFingerprint(capsule) {
  const row = capsule || {}
  return sha256(JSON.stringify([
    RESUME_CAPSULE_SCHEMA_VERSION,
    row.taskFingerprint || "",
    row.role || "",
    row.phase || "",
    row.reasoningMode || "",
    row.turnsUsed || 0,
    row.rotations || 0,
    row.nextObjective || "",
    (row.decisions || []),
    (row.constraints || []),
    (row.evidenceRefs || []),
    (row.openQuestions || []),
    (row.failedHypotheses || []),
  ]))
}

/**
 * Build the resume capsule.
 *
 * `input` fields are all optional and all bounded:
 *   session, taskFingerprint, role, phase, reasoningMode, nextObjective,
 *   decisions, constraints, evidenceRefs, openQuestions, failedHypotheses,
 *   budgetSnapshot, env, maxChars
 */
export function buildResumeCapsule(input = {}) {
  const maxChars = int(input.maxChars, DEFAULT_CAPSULE_CHARS, 400, MAX_CAPSULE_CHARS)
  const session = input.session || {}

  const decisions = boundedList(input.decisions, 8, MAX_ITEM_CHARS)
  const constraints = boundedList(input.constraints, 8, MAX_ITEM_CHARS)
  const evidenceRefs = boundedList(input.evidenceRefs ?? session.evidenceRefs, MAX_LIST_ITEMS, 160)
  const openQuestions = boundedList(input.openQuestions, 6, MAX_ITEM_CHARS)
  const failedHypotheses = boundedList(input.failedHypotheses, 6, MAX_ITEM_CHARS)

  const sections = []
  sections.push([
    "## DeepSeek conversation resume capsule (V16.6)",
    "Continuity state for the next conversation turn. Local evidence remains authoritative.",
    `role=${String(input.role ?? session.role ?? "")} phase=${String(input.phase ?? session.phase ?? "")} mode=${String(input.reasoningMode ?? session.reasoningMode ?? "balanced")}`,
    `turns=${int(session.turnsUsed, 0, 0, 999)} rotations=${int(session.rotations, 0, 0, 99)}`,
  ].join("\n"))
  if (input.nextObjective) sections.push(`### Next objective\n${clampItem(input.nextObjective, 600)}`)
  const push = (title, list) => {
    if (list.rows.length) sections.push(`### ${title}\n${list.rows.map((row) => `- ${row}`).join("\n")}`)
  }
  push("Decisions already taken", decisions)
  push("Constraints still in force", constraints)
  push("Evidence references", evidenceRefs)
  push("Open questions", openQuestions)
  push("Rejected hypotheses", failedHypotheses)
  if (input.budgetSnapshot) {
    const snap = input.budgetSnapshot
    sections.push([
      "### Budget snapshot",
      `profile=${snap.executionProfile || "?"} turns=${snap.deepSeekTurnBudget?.effectiveMaxTurns ?? 0}`,
      `skills=${snap.skillBudget?.maxSkills ?? 0} tools=${snap.maxAdvertisedTools ?? 0} tier=${snap.deepSeekPacketTier || "?"}`,
    ].join("\n"))
  }

  let content = sections.join("\n\n")

  // Deterministic line-based truncation (never character-slicing a section in
  // half mid-word beyond the final line guard).
  let truncated = false
  if (content.length > maxChars) {
    const lines = content.split("\n")
    const kept = []
    let size = 0
    for (const line of lines) {
      if (size + line.length + 1 > maxChars) {
        truncated = true
        break
      }
      kept.push(line)
      size += line.length + 1
    }
    kept.push("[capsule truncated - re-read local evidence before continuing]")
    content = kept.join("\n")
  }

  const redacted = String(redactStructure(content).value ?? "")
  let secretHits = 0
  if (containsUnmaskedSecret(redacted)) secretHits += 1
  const secretScanClean = secretHits === 0
  if (!secretScanClean) {
    // Fail closed: a capsule that still looks like it carries a secret is not
    // usable as conversation continuity.
    return {
      schemaVersion: RESUME_CAPSULE_SCHEMA_VERSION,
      policy: RESUME_CAPSULE_POLICY,
      ok: false,
      blocked: "secret-scan-failed",
      fingerprint: "",
      content: "",
      sizeChars: 0,
      truncated,
      secretScanClean: false,
      redactions: [REDACTION_MASK],
      truncations: [],
      measurements: {
        sizeChars: NOT_MEASURED,
        turns: measured(int(session.turnsUsed, 0, 0, 999)),
        secretHits: measured(secretHits),
      },
    }
  }

  const capsule = {
    schemaVersion: RESUME_CAPSULE_SCHEMA_VERSION,
    policy: RESUME_CAPSULE_POLICY,
    ok: true,
    blocked: null,
    taskFingerprint: String(input.taskFingerprint ?? session.taskFingerprint ?? ""),
    role: String(input.role ?? session.role ?? ""),
    phase: String(input.phase ?? session.phase ?? ""),
    reasoningMode: String(input.reasoningMode ?? session.reasoningMode ?? "balanced"),
    nextObjective: input.nextObjective ? clampItem(input.nextObjective, 600) : "",
    turnsUsed: int(session.turnsUsed, 0, 0, 999),
    rotations: int(session.rotations, 0, 0, 99),
    decisions: decisions.rows,
    constraints: constraints.rows,
    evidenceRefs: evidenceRefs.rows,
    openQuestions: openQuestions.rows,
    failedHypotheses: failedHypotheses.rows,
    content: redacted,
    sizeChars: redacted.length,
    maxChars,
    truncated,
    secretScanClean,
    redactions: redacted.includes(REDACTION_MASK) ? [REDACTION_MASK] : [],
    truncations: [
      truncated ? "content" : null,
      decisions.truncated ? "decisions" : null,
      constraints.truncated ? "constraints" : null,
      evidenceRefs.truncated ? "evidenceRefs" : null,
      openQuestions.truncated ? "openQuestions" : null,
      failedHypotheses.truncated ? "failedHypotheses" : null,
    ].filter(Boolean),
    measurements: {
      sizeChars: derived(redacted.length),
      maxChars: derived(maxChars),
      turns: measured(int(session.turnsUsed, 0, 0, 999)),
      rotations: measured(int(session.rotations, 0, 0, 99)),
      secretHits: measured(0),
      transcriptChars: NOT_MEASURED,
    },
    provenance: "DERIVED",
  }
  capsule.fingerprint = resumeFingerprint(capsule)
  return capsule
}

/** Render the capsule as bounded context for the successor session. */
export function capsuleContext(capsule) {
  const row = capsule || {}
  if (!row.ok) return ""
  return String(row.content || "")
}

/** Validate a capsule before trusting it as continuity. */
export function assertResumeCapsule(capsule) {
  const violations = []
  const row = capsule || {}
  if (row.schemaVersion !== RESUME_CAPSULE_SCHEMA_VERSION) violations.push("schema-version")
  if (!row.ok) violations.push(`blocked:${row.blocked || "unknown"}`)
  if (row.secretScanClean !== true) violations.push("secret-scan")
  if (Number(row.sizeChars) > MAX_CAPSULE_CHARS) violations.push("size-over-max")
  if (containsUnmaskedSecret(row.content)) violations.push("secret-content")
  if (/\beyJ[A-Za-z0-9_-]{10,}\b/.test(String(row.content || ""))) violations.push("jwt-like-token")
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(String(row.content || ""))) violations.push("private-key")
  return { ok: violations.length === 0, violations }
}

export const RESUME_CAPSULE_EXPORTS = Object.freeze([
  "buildResumeCapsule",
  "capsuleContext",
  "assertResumeCapsule",
  "resumeFingerprint",
])
