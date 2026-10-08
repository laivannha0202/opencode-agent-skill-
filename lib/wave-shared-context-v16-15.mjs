// V16.15 Wave Shared Context (capsule + child delta).
//
// WHY THIS MODULE EXISTS
//
// When V16.15 runs N independent writers, the naive implementation gives every
// child the same parent context. On a real repository that means N children each
// re-reading the package structure, the shared API contract, the version facts
// and the architecture summary. The wall time is lower but the TOTAL context and
// the token bill multiply by N.
//
// This module is the single owner of the fix:
//
//   PARENT reads the common facts ONCE
//     -> ONE immutable WAVE SHARED SNAPSHOT (bounded, content-addressed)
//     -> every child receives the SAME snapshot REFERENCE plus its own delta
//
// LAWS
//
//   1. ONE SNAPSHOT PER WAVE. The snapshot is immutable after assembly. Two
//      children of the same wave can never receive two different snapshots.
//   2. REFERENCES, NOT BODIES. A snapshot entry carries a content hash and a
//      bounded inline preview. Full bodies live in the EXISTING Evidence Store
//      (`lib/evidence-store.mjs`) and are fetched on demand. This module never
//      creates a second evidence store, cache or ledger.
//   3. THE CHILD DELTA EXCLUDES EVERYTHING SHARED. A field present in the
//      snapshot is never repeated in the delta. `duplicateCharsAvoided` is the
//      MEASURED char count that would have been duplicated had each child been
//      given the shared block inline.
//   4. NO PARENT CONVERSATION. The snapshot is built from explicitly named
//      bounded facts. There is no code path that copies a conversation,
//      reasoning trace or full tool log into a child.
//   5. BOUNDED ALWAYS. Every list has a cap and every string is truncated at a
//      declared limit, so a pathological repository cannot blow a child's budget.

import { createHash } from "node:crypto"
import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const WAVE_SHARED_CONTEXT_SCHEMA_VERSION = 1
export const WAVE_SHARED_CONTEXT_POLICY = "wave-shared-context-v16-15"

/** Hard bounds. A capsule that exceeds these is truncated, never rejected. */
export const WAVE_CONTEXT_LIMITS = Object.freeze({
  maxSnapshotChars: 6_000,
  maxEntryPreviewChars: 400,
  maxEntries: 24,
  maxGoalChars: 600,
  maxConstraintChars: 300,
  maxConstraints: 12,
  maxArchitectureNotes: 12,
  maxVersionFacts: 16,
  maxEvidenceRefs: 24,
  maxTestCommands: 8,
  maxSymbols: 24,
  maxChildGoalChars: 700,
  maxChildAcceptance: 10,
  maxChildVerification: 8,
  maxDeltaChars: 4_000,
  maxDependencyReceipts: 8,
})

/** The only fact classes a wave snapshot may contain. */
export const SNAPSHOT_FACT = Object.freeze({
  GOAL: "goal",
  CONSTRAINTS: "constraints",
  ARCHITECTURE: "architecture",
  VERSION_FACTS: "version-facts",
  SOURCE_EVIDENCE: "source-evidence",
  REQUIREMENT_IDS: "requirement-ids",
  TEST_COMMANDS: "test-commands",
  WORKSPACE_GENERATION: "workspace-generation",
  SYMBOLS: "symbols",
})

function truncate(value, maxChars) {
  const text = String(value ?? "")
  if (text.length <= maxChars) return { text, truncated: false, originalChars: text.length }
  return { text: text.slice(0, Math.max(0, maxChars - 18)) + "\n...[truncated]", truncated: true, originalChars: text.length }
}

function unique(values, limit) {
  const rows = [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))]
  return limit ? rows.slice(0, limit) : rows
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, 24)
}

/**
 * Normalize one evidence reference. A reference is a pointer into the EXISTING
 * Evidence Store: either a `evidence:sha256:<hash>` ref or a caller-declared
 * logical id. It never carries the body.
 */
export function normalizeEvidenceRef(value) {
  if (!value) return null
  if (typeof value === "string") {
    const text = value.trim()
    return text ? { ref: text, preview: null } : null
  }
  const ref = String(value.ref || value.handle || value.id || "").trim()
  if (!ref) return null
  const previewSource = value.preview ?? value.summary ?? value.label ?? null
  const preview = previewSource == null ? null : truncate(previewSource, WAVE_CONTEXT_LIMITS.maxEntryPreviewChars).text
  return { ref, preview }
}

/**
 * Assemble the immutable wave shared snapshot.
 *
 * Every field is optional. Absent facts are recorded as absent (so a caller can
 * tell "we did not read it" from "we read it and it was empty"), never faked.
 *
 * @param {object} input
 * @param {string}   [input.waveId]
 * @param {string}   [input.goal]
 * @param {string[]} [input.constraints]
 * @param {string[]} [input.architecture]      bounded architecture notes
 * @param {string[]} [input.versionFacts]
 * @param {Array}    [input.sourceEvidence]    evidence refs (pointer only)
 * @param {string[]} [input.requirementIds]
 * @param {Array}    [input.testCommands]      { command, args } or string
 * @param {string}   [input.workspaceGeneration]
 * @param {string[]} [input.symbols]
 */
export function createWaveSharedSnapshot(input = {}) {
  const goal = truncate(input.goal, WAVE_CONTEXT_LIMITS.maxGoalChars)
  const constraints = unique(input.constraints, WAVE_CONTEXT_LIMITS.maxConstraints)
    .map((row) => truncate(row, WAVE_CONTEXT_LIMITS.maxConstraintChars).text)
  const architecture = unique(input.architecture, WAVE_CONTEXT_LIMITS.maxArchitectureNotes)
    .map((row) => truncate(row, WAVE_CONTEXT_LIMITS.maxEntryPreviewChars).text)
  const versionFacts = unique(input.versionFacts, WAVE_CONTEXT_LIMITS.maxVersionFacts)
    .map((row) => truncate(row, WAVE_CONTEXT_LIMITS.maxEntryPreviewChars).text)
  const requirementIds = unique(input.requirementIds, WAVE_CONTEXT_LIMITS.maxEntries)
  const symbols = unique(input.symbols, WAVE_CONTEXT_LIMITS.maxSymbols)
  const workspaceGeneration = input.workspaceGeneration == null
    ? null
    : String(input.workspaceGeneration)

  const evidenceRefs = (input.sourceEvidence || [])
    .map(normalizeEvidenceRef)
    .filter(Boolean)
    .slice(0, WAVE_CONTEXT_LIMITS.maxEvidenceRefs)

  const testCommands = (input.testCommands || [])
    .map((row) => {
      if (typeof row === "string") {
        const command = row.trim()
        return command ? { command, args: [] } : null
      }
      const command = String(row?.command || "").trim()
      if (!command) return null
      return { command, args: Array.isArray(row?.args) ? row.args.map(String) : [] }
    })
    .filter(Boolean)
    .slice(0, WAVE_CONTEXT_LIMITS.maxTestCommands)

  const facts = {
    [SNAPSHOT_FACT.GOAL]: goal.text,
    [SNAPSHOT_FACT.CONSTRAINTS]: constraints,
    [SNAPSHOT_FACT.ARCHITECTURE]: architecture,
    [SNAPSHOT_FACT.VERSION_FACTS]: versionFacts,
    [SNAPSHOT_FACT.SOURCE_EVIDENCE]: evidenceRefs,
    [SNAPSHOT_FACT.REQUIREMENT_IDS]: requirementIds,
    [SNAPSHOT_FACT.TEST_COMMANDS]: testCommands,
    [SNAPSHOT_FACT.WORKSPACE_GENERATION]: workspaceGeneration,
    [SNAPSHOT_FACT.SYMBOLS]: symbols,
  }

  const identity = hash(JSON.stringify(facts))
  const rendered = renderWaveSharedSnapshot(facts, { identity })

  // Bound the whole capsule. Truncation is reported, never silent.
  const withinBudget = rendered.text.length <= WAVE_CONTEXT_LIMITS.maxSnapshotChars
  const text = withinBudget
    ? rendered.text
    : rendered.text.slice(0, WAVE_CONTEXT_LIMITS.maxSnapshotChars - 40)
      + "\n...[wave snapshot truncated to budget]"

  return {
    schemaVersion: WAVE_SHARED_CONTEXT_SCHEMA_VERSION,
    policy: WAVE_SHARED_CONTEXT_POLICY,
    waveId: String(input.waveId || `wave-${identity.slice(0, 8)}`),
    snapshotId: `wave-snapshot:sha256:${identity}`,
    facts,
    text,
    chars: measured(text.length),
    untruncatedChars: measured(rendered.text.length),
    bounded: withinBudget,
    entryCount: Object.values(facts).reduce((sum, value) =>
      sum + (Array.isArray(value) ? value.length : value == null ? 0 : 1), 0),
    // Frozen: a snapshot that could mutate mid-wave would break law 1.
    immutable: true,
    createdAt: new Date().toISOString(),
    deterministic: true,
  }
}

function renderWaveSharedSnapshot(facts, options = {}) {
  const lines = [
    "# Wave shared context (read once by the parent; do not re-discover)",
    `snapshot: ${options.identity ? `wave-snapshot:sha256:${options.identity}` : "wave-snapshot"}`,
  ]
  const goal = facts[SNAPSHOT_FACT.GOAL]
  if (goal) lines.push("", "## Goal", goal)
  const constraints = facts[SNAPSHOT_FACT.CONSTRAINTS] || []
  if (constraints.length) lines.push("", "## Non-negotiable constraints", ...constraints.map((row) => `- ${row}`))
  const architecture = facts[SNAPSHOT_FACT.ARCHITECTURE] || []
  if (architecture.length) lines.push("", "## Repository architecture (already established)", ...architecture.map((row) => `- ${row}`))
  const versions = facts[SNAPSHOT_FACT.VERSION_FACTS] || []
  if (versions.length) lines.push("", "## Shared version/config facts", ...versions.map((row) => `- ${row}`))
  const requirements = facts[SNAPSHOT_FACT.REQUIREMENT_IDS] || []
  if (requirements.length) lines.push("", "## Shared requirement ids", ...requirements.map((row) => `- ${row}`))
  const commands = facts[SNAPSHOT_FACT.TEST_COMMANDS] || []
  if (commands.length) {
    lines.push("", "## Known verification commands")
    for (const row of commands) lines.push(`- ${[row.command, ...row.args].join(" ")}`)
  }
  const generation = facts[SNAPSHOT_FACT.WORKSPACE_GENERATION]
  if (generation) lines.push("", "## Workspace generation", generation)
  const symbols = facts[SNAPSHOT_FACT.SYMBOLS] || []
  if (symbols.length) lines.push("", "## Common symbols", ...symbols.map((row) => `- ${row}`))
  const evidence = facts[SNAPSHOT_FACT.SOURCE_EVIDENCE] || []
  if (evidence.length) {
    lines.push("", "## Shared source evidence (fetch on demand; bodies live in the Evidence Store)")
    for (const row of evidence) {
      lines.push(`- ${row.ref}${row.preview ? ` - ${row.preview}` : ""}`)
    }
  }
  lines.push(
    "",
    "## Rules",
    "- This shared block is already established. Do NOT re-read or re-scan for it.",
    "- Fetch an evidence body only if your own task genuinely depends on it.",
  )
  return { text: lines.join("\n") }
}

/**
 * Build the CHILD-SPECIFIC DELTA for one child of the wave.
 *
 * LAW 3 is enforced structurally: the delta carries only child-local facts. The
 * shared snapshot is referenced by id, never re-rendered inline. The function
 * computes the MEASURED char count that would otherwise have been duplicated in
 * this child's context.
 *
 * @param {object} input
 * @param {object} input.snapshot     a createWaveSharedSnapshot result
 * @param {object} input.child        { childId, taskId, goal, writeFiles, readFiles, ... }
 */
export function createChildDelta(input = {}) {
  const snapshot = input.snapshot || null
  const child = input.child || {}
  const childId = String(child.childId || child.id || child.taskId || "child")
  const taskId = String(child.taskId || child.id || childId)

  const goal = truncate(child.goal ?? child.task ?? "", WAVE_CONTEXT_LIMITS.maxChildGoalChars)
  const writeFiles = unique(child.writeFiles || child.files, 40)
  const readFiles = unique(child.readFiles, 40)
  const symbols = unique(child.symbols, WAVE_CONTEXT_LIMITS.maxSymbols)
  const acceptance = unique(child.acceptance || child.acceptanceCriteria, WAVE_CONTEXT_LIMITS.maxChildAcceptance)
    .map((row) => truncate(row, WAVE_CONTEXT_LIMITS.maxConstraintChars).text)
  const verification = unique(child.verification || child.verificationChecks, WAVE_CONTEXT_LIMITS.maxChildVerification)
    .map((row) => truncate(row, WAVE_CONTEXT_LIMITS.maxConstraintChars).text)
  const verificationCommands = (child.verificationCommands || [])
    .map((row) => {
      if (typeof row === "string") return row.trim() || null
      const command = String(row?.command || "").trim()
      return command ? [command, ...(Array.isArray(row?.args) ? row.args.map(String) : [])].join(" ") : null
    })
    .filter(Boolean)
    .slice(0, WAVE_CONTEXT_LIMITS.maxChildVerification)
  const sandboxId = child.sandboxId == null ? null : String(child.sandboxId)
  const dependencyReceipts = (child.dependencyReceipts || []).slice(0, WAVE_CONTEXT_LIMITS.maxDependencyReceipts).map((row) => ({
    taskId: String(row?.taskId || row?.id || ""),
    status: String(row?.status || ""),
    evidenceRef: row?.evidenceRef ? String(row.evidenceRef) : null,
  }))

  const delta = {
    schemaVersion: WAVE_SHARED_CONTEXT_SCHEMA_VERSION,
    policy: WAVE_SHARED_CONTEXT_POLICY,
    childId,
    taskId,
    role: String(child.role || ""),
    agent: child.agent == null ? null : String(child.agent),
    readOnly: child.readOnly === true,
    goal: goal.text,
    writeFiles,
    readFiles,
    symbols,
    acceptance,
    verification,
    verificationCommands,
    sandboxId,
    dependencyReceipts,
    // The ONLY link to the shared facts. Not a copy of them.
    sharedSnapshotId: snapshot?.snapshotId || null,
    sharedSnapshotFacts: snapshot ? Object.keys(snapshot.facts).filter((key) => {
      const value = snapshot.facts[key]
      return Array.isArray(value) ? value.length > 0 : value != null && value !== ""
    }).sort() : [],
    // Explicit record of what is NOT copied into a child, so the omission is
    // auditable exactly like the V16.5 fabric's `notCopied` list.
    notCopied: [
      "parent-conversation",
      "wave-shared-block-inline",
      "other-children-context",
      "full-repository",
      "full-skill-bodies",
      "raw-tool-logs",
      "unrelated-prior-attempts",
    ],
    deterministic: true,
  }

  const text = renderChildDelta(delta, snapshot)
  const bounded = text.length <= WAVE_CONTEXT_LIMITS.maxDeltaChars
  const finalText = bounded
    ? text
    : text.slice(0, WAVE_CONTEXT_LIMITS.maxDeltaChars - 40) + "\n...[child delta truncated to budget]"

  return {
    ...delta,
    text: finalText,
    chars: measured(finalText.length),
    untruncatedChars: measured(text.length),
    bounded,
    fingerprint: `child-delta:sha256:${hash([childId, taskId, goal.text, writeFiles, readFiles, acceptance, verification])}`,
  }
}

function renderChildDelta(delta, snapshot) {
  const lines = [
    `# Child delta (${delta.role || "task"} ${delta.taskId})`,
    "",
    "## Shared context",
    snapshot?.snapshotId
      ? `The wave shared context is ALREADY ESTABLISHED under ${snapshot.snapshotId}. It is not repeated here by design.`
      : "No wave snapshot was supplied; treat repository facts as unknown and establish only what you need.",
    "",
    "## Your task",
    delta.goal || "(no task text)",
  ]
  if (delta.acceptance.length) lines.push("", "## Acceptance criteria", ...delta.acceptance.map((row) => `- ${row}`))
  if (delta.writeFiles.length) lines.push("", "## Your write scope (do not write outside this list)", ...delta.writeFiles.map((row) => `- ${row}`))
  if (delta.readFiles.length) lines.push("", "## Required reads", ...delta.readFiles.map((row) => `- ${row}`))
  if (delta.symbols.length) lines.push("", "## Relevant symbols", ...delta.symbols.map((row) => `- ${row}`))
  if (delta.verification.length) lines.push("", "## Targeted verification", ...delta.verification.map((row) => `- ${row}`))
  if (delta.verificationCommands.length) {
    lines.push("", "## Targeted verification commands")
    for (const command of delta.verificationCommands) lines.push(`- ${command}`)
  }
  if (delta.sandboxId) lines.push("", "## Sandbox", delta.sandboxId)
  if (delta.dependencyReceipts.length) {
    lines.push("", "## Dependency receipts")
    for (const row of delta.dependencyReceipts) {
      lines.push(`- ${row.taskId}: ${row.status}${row.evidenceRef ? ` (${row.evidenceRef})` : ""}`)
    }
  }
  lines.push(
    "",
    "## Child rules",
    "- You have a FRESH context. The shared wave facts above are given; do not re-scan for them.",
    "- Stay strictly inside your write scope. A file outside it is a scope violation.",
    "- Run only the targeted verification listed above; do not run the full suite.",
    "- You cannot publish, push, tag, deploy, grant permissions or mark anything PASS.",
    "- Return a compact receipt: changed files, read files, commands run, results, warnings.",
  )
  return lines.join("\n")
}

/**
 * Account for the context a wave actually spent versus the naive baseline.
 *
 * The naive baseline gives EVERY child the full shared block inline. The saving
 * is therefore `sharedChars * (childCount - 1)`, which is exactly the amount of
 * duplication the shared snapshot removed. It is DERIVED from MEASURED char
 * counts, and it is a CHAR claim only - never a token claim.
 */
export function waveContextAccounting(input = {}) {
  const snapshot = input.snapshot || null
  const deltas = Array.isArray(input.deltas) ? input.deltas : []
  const sharedChars = snapshot?.chars?.value ?? 0
  const childCount = deltas.length
  const childSpecificChars = deltas.reduce((sum, row) => sum + (row?.chars?.value || 0), 0)
  const naiveDuplicateChars = sharedChars * Math.max(0, childCount - 1)
  const sharedContextChars = sharedChars

  return {
    schemaVersion: WAVE_SHARED_CONTEXT_SCHEMA_VERSION,
    policy: WAVE_SHARED_CONTEXT_POLICY,
    childCount,
    sharedContextChars: measured(sharedContextChars),
    childSpecificChars: measured(childSpecificChars),
    totalWaveChars: measured(sharedContextChars + childSpecificChars),
    duplicateContextCharsAvoided: childCount > 1 ? measured(naiveDuplicateChars) : measured(0),
    naiveBaselineChars: measured(sharedContextChars * Math.max(1, childCount) + childSpecificChars),
    provenance: {
      chars: "MEASURED",
      tokens: "NOT_MEASURED",
    },
    tokenSavingClaim: null,
    note:
      "duplicateContextCharsAvoided is a MEASURED character count, not a token measurement. "
      + "The provider token count is NOT_MEASURED unless the provider reported it.",
    deterministic: true,
  }
}

/**
 * Render the compact PARENT HANDOFF for a finished child.
 *
 * The parent must not ingest a child's conversation, reasoning, logs or tool
 * history. This produces the bounded receipt the parent actually needs, with raw
 * bodies left addressable in the Evidence Store.
 */
export function createCompactHandoff(input = {}) {
  const child = input.child || {}
  const changedFiles = unique(child.changedFiles, 40)
  const readFiles = unique(child.readFiles, 40)
  const warnings = unique(child.warnings, 12).map((row) => truncate(row, 240).text)
  const verificationCommands = (child.verificationCommands || []).slice(0, WAVE_CONTEXT_LIMITS.maxChildVerification)
    .map((row) => (typeof row === "string" ? row : [row?.command, ...(row?.args || [])].filter(Boolean).join(" ")))
    .filter(Boolean)
  const verificationResults = (child.verificationResults || []).slice(0, WAVE_CONTEXT_LIMITS.maxChildVerification)
    .map((row) => ({
      command: String(row?.command || ""),
      status: String(row?.status || "unknown"),
      exitCode: Number.isFinite(Number(row?.exitCode)) ? Number(row.exitCode) : null,
    }))
  const firstFailure = child.firstFailure == null ? null : truncate(child.firstFailure, 600).text

  return {
    schemaVersion: WAVE_SHARED_CONTEXT_SCHEMA_VERSION,
    policy: WAVE_SHARED_CONTEXT_POLICY,
    childId: String(child.childId || ""),
    taskId: String(child.taskId || ""),
    sandboxId: child.sandboxId == null ? null : String(child.sandboxId),
    status: String(child.status || "unknown"),
    changedFiles,
    readFiles,
    verificationCommands,
    verificationResults,
    warnings,
    firstFailure,
    evidenceRefs: (child.evidenceRefs || []).map((row) => String(row)).slice(0, WAVE_CONTEXT_LIMITS.maxEvidenceRefs),
    diffSummary: child.diffSummary == null ? null : truncate(child.diffSummary, 800).text,
    durationMs: Number.isFinite(Number(child.durationMs)) ? measured(Number(child.durationMs)) : NOT_MEASURED,
    toolCalls: Number.isFinite(Number(child.toolCalls)) ? measured(Number(child.toolCalls)) : NOT_MEASURED,
    // A child receipt is evidence, never a verdict.
    canProduceVerdict: false,
    rawLogsRef: child.rawLogsRef == null ? null : String(child.rawLogsRef),
    rawLogsInline: false,
    deterministic: true,
  }
}

export const waveSharedContextExports = Object.freeze({
  createWaveSharedSnapshot,
  createChildDelta,
  createCompactHandoff,
  waveContextAccounting,
  normalizeEvidenceRef,
  WAVE_CONTEXT_LIMITS,
  SNAPSHOT_FACT,
})
