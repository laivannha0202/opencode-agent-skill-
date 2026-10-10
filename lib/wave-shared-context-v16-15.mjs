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
  // V16.16 canonical child capsule: stable shared prefix + child delta.
  maxSharedPrefixChars: 1_500,
  maxCapsuleChars: 5_500,
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

// ---------------------------------------------------------------------------
// V16.16 structural budgeting.
//
// A blind `text.slice(n)` can cut halfway through a file path, a verification
// command, an evidence ref or an acceptance criterion, and the child then
// executes a corrupted instruction. Structural packing instead fits WHOLE
// records: sections are mandatory or optional, optional sections are dropped
// WHOLE (lowest priority first), mandatory free prose may be mark-truncated,
// and mandatory path/command lists drop whole trailing ITEMS with an explicit
// omission count - never a mid-item cut, never silent.
//
// Hard invariant: the returned text (headers + notices + metadata included)
// never exceeds maxChars.
// ---------------------------------------------------------------------------

/**
 * Fit ordered sections into a hard char budget.
 *
 * @param {Array} sections  [{ title, lines, mandatory }] in render order
 * @param {object} options  { maxChars, omissionLabel }
 * @returns {{ text, omitted, bounded, untruncatedChars }}
 */
export function fitSections(sections = [], options = {}) {
  const maxChars = Math.max(64, Math.trunc(Number(options.maxChars) || 4_000))
  const omissionLabel = String(options.omissionLabel || "budget")
  const full = sections
    .map((section) => [section.title, ...(section.lines || [])].join("\n"))
    .join("\n")
  const untruncatedChars = full.length
  if (full.length <= maxChars) {
    return { text: full, omitted: [], bounded: true, untruncatedChars }
  }
  const omitted = []
  const live = sections.map((section) => ({ ...section, lines: [...(section.lines || [])] }))
  const render = (rows) => rows
    .map((section) => [section.title, ...section.lines].join("\n"))
    .join("\n")
  const isWriteScope = (section) => /write scope/i.test(String(section.title || ""))
  const isIdentity = (section) => /^# /.test(String(section.title || ""))
    || /run binding|shared context/i.test(String(section.title || ""))
  // 1. Drop whole OPTIONAL sections, lowest priority first (reverse render
  //    order among optional sections keeps mandatory order deterministic).
  const optionalIndexes = () => live
    .map((section, index) => ({ section, index }))
    .filter((row) => row.section.dropped !== true && row.section.mandatory !== true)
    .map((row) => row.index)
    .reverse()
  for (const index of optionalIndexes()) {
    if (render(live.filter((row) => !row.dropped)).length + 120 <= maxChars) break
    live[index].dropped = true
    omitted.unshift(live[index].title)
  }
  const visible = () => live.filter((row) => !row.dropped)
  // The omission notice is part of the budget. Detail lines are kept only
  // while they fit; otherwise a single compact summary line is used, so the
  // notice itself can never defeat convergence (dropping a 30-char line must
  // not add a 90-char notice line about it).
  const buildNotice = (renderLen = null) => {
    const bodyLen = renderLen == null ? render(visible()).length : renderLen
    const itemSections = visible().filter((row) => row.omittedItems)
    const itemTotal = itemSections.reduce((sum, row) => sum + (row.omittedItems || 0), 0)
    const titles = omitted.slice(0, 8).join("; ") || "none"
    const titlePart = titles.length > 120 ? `${titles.slice(0, 117)}...` : titles
    const compact = `\n...[${omissionLabel}: ${omitted.length} section(s), ${itemTotal} item(s) omitted whole; see run manifest]`
    const detail = `\n...[${omissionLabel}: omitted ${omitted.length} optional section(s): ${titlePart}]`
      + itemSections.map((row) => `\n...[${row.title}: ${row.omittedItems} trailing item(s) omitted whole; see run manifest]`).join("")
    if (bodyLen + detail.length <= maxChars) return detail
    return compact
  }
  // 2. Shorten free-prose blocks (goal/descriptions) with an explicit marker.
  //    Prose is the only content ever shortened mid-string, and it is marked.
  for (const section of visible()) {
    if (section.prose !== true || section.lines.length === 0) continue
    if (render(visible()).length + buildNotice(render(visible())).length <= maxChars) break
    const others = render(visible().filter((row) => row !== section)).length
    const room = Math.max(0, maxChars - others - buildNotice(others).length)
    const prose = section.lines.join("\n")
    if (prose.length > room) {
      section.lines = [prose.slice(0, Math.max(0, room - 18)) + "\n...[truncated]"]
      if (!omitted.includes(`${section.title} (prose shortened)`)) {
        omitted.unshift(`${section.title} (prose shortened)`)
      }
    }
  }
  // 3. While still over budget, drop WHOLE trailing lines: first from large
  //    non-write-scope mandatory lists (acceptance, verification), then from
  //    any remaining list, write scope last. Every dropped item is counted in
  //    the notice. A line is never cut mid-record.
  const dropCandidates = () => {
    const rows = visible().filter((row) => row.lines.length > 0)
    const nonScope = rows.filter((row) => !isWriteScope(row) && !isIdentity(row))
    const pool = nonScope.length ? nonScope : rows.filter((row) => !isIdentity(row))
    const fallback = pool.length ? pool : rows
    // Drop from the currently longest section first (deterministic by order).
    fallback.sort((a, b) => (b.lines.join("\n").length - a.lines.join("\n").length)
      || (visible().indexOf(a) - visible().indexOf(b)))
    return fallback[0] || null
  }
  let guard = 10_000
  while (render(visible()).length + buildNotice().length > maxChars && guard > 0) {
    guard -= 1
    const target = dropCandidates()
    if (!target) break
    // A single item longer than the whole budget cannot be kept whole; mark
    // it explicitly rather than cutting silently (pathological only).
    if (target.lines.length === 1 && target.lines[0].length > maxChars) {
      target.lines = [target.lines[0].slice(0, Math.max(0, maxChars - 40)) + " ...[item exceeds budget; see run manifest]"]
      target.omittedItems = (target.omittedItems || 0) + 1
      break
    }
    target.lines.pop()
    target.omittedItems = (target.omittedItems || 0) + 1
  }
  const notice = buildNotice()
  let text = render(visible())
  // Last resort: converge against a FRESH notice (the notice grows as items
  // are omitted, so a stale comparison can leave the total over budget).
  // Mandatory list lines are still never sliced: only whole lines are dropped
  // and only free prose is ever mark-shortened.
  let extra = 1_000
  let freshNotice = notice
  while (text.length + freshNotice.length > maxChars && extra > 0) {
    extra -= 1
    const overflow = text.length + freshNotice.length - maxChars
    const proseSection = visible().find((row) => row.prose === true)
    if (proseSection && proseSection.lines[0] && proseSection.lines[0].length > overflow + 20) {
      proseSection.lines[0] = proseSection.lines[0].slice(0, proseSection.lines[0].length - overflow - 20) + " ...[truncated]"
    } else {
      const target = dropCandidates()
      if (!target || target.lines.length === 0) break
      target.lines.pop()
      target.omittedItems = (target.omittedItems || 0) + 1
    }
    text = render(visible())
    freshNotice = buildNotice()
  }
  return { text: text + freshNotice, omitted, bounded: false, untruncatedChars }
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

  // V16.16 structural fit: whole optional sections are dropped before any
  // mandatory record is touched, and previews (optional) are stripped before
  // whole evidence-ref sections are dropped. Never a mid-record character cut.
  let fitted = fitSections(snapshotSections(facts, { identity }), {
    maxChars: WAVE_CONTEXT_LIMITS.maxSnapshotChars,
    omissionLabel: "wave snapshot truncated to budget",
  })
  if (fitted.bounded === false) {
    const withoutPreviews = fitSections(snapshotSections(facts, { identity, includePreviews: false }), {
      maxChars: WAVE_CONTEXT_LIMITS.maxSnapshotChars,
      omissionLabel: "wave snapshot truncated to budget",
    })
    if (withoutPreviews.text.length < fitted.text.length || withoutPreviews.bounded) fitted = withoutPreviews
  }
  const withinBudget = fitted.bounded
  const text = fitted.text

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

function snapshotSections(facts, options = {}) {
  const includePreviews = options.includePreviews !== false
  const sections = []
  sections.push({
    title: "# Wave shared context (read once by the parent; do not re-discover)",
    lines: [`snapshot: ${options.identity ? `wave-snapshot:sha256:${options.identity}` : "wave-snapshot"}`],
    mandatory: true,
  })
  const goal = facts[SNAPSHOT_FACT.GOAL]
  if (goal) sections.push({ title: "## Goal", lines: [goal], mandatory: true, prose: true })
  const constraints = facts[SNAPSHOT_FACT.CONSTRAINTS] || []
  if (constraints.length) sections.push({ title: "## Non-negotiable constraints", lines: constraints.map((row) => `- ${row}`), mandatory: true })
  const architecture = facts[SNAPSHOT_FACT.ARCHITECTURE] || []
  if (architecture.length) sections.push({ title: "## Repository architecture (already established)", lines: architecture.map((row) => `- ${row}`), mandatory: false })
  const versions = facts[SNAPSHOT_FACT.VERSION_FACTS] || []
  if (versions.length) sections.push({ title: "## Shared version/config facts", lines: versions.map((row) => `- ${row}`), mandatory: false })
  const requirements = facts[SNAPSHOT_FACT.REQUIREMENT_IDS] || []
  if (requirements.length) sections.push({ title: "## Shared requirement ids", lines: requirements.map((row) => `- ${row}`), mandatory: true })
  const commands = facts[SNAPSHOT_FACT.TEST_COMMANDS] || []
  if (commands.length) {
    sections.push({
      title: "## Known verification commands",
      lines: commands.map((row) => `- ${[row.command, ...row.args].join(" ")}`),
      mandatory: true,
    })
  }
  const generation = facts[SNAPSHOT_FACT.WORKSPACE_GENERATION]
  if (generation) sections.push({ title: "## Workspace generation", lines: [generation], mandatory: true })
  const symbols = facts[SNAPSHOT_FACT.SYMBOLS] || []
  if (symbols.length) sections.push({ title: "## Common symbols", lines: symbols.map((row) => `- ${row}`), mandatory: false })
  const evidence = facts[SNAPSHOT_FACT.SOURCE_EVIDENCE] || []
  if (evidence.length) {
    sections.push({
      title: "## Shared source evidence (fetch on demand; bodies live in the Evidence Store)",
      lines: evidence.map((row) => `- ${row.ref}${includePreviews && row.preview ? ` - ${row.preview}` : ""}`),
      mandatory: true,
    })
  }
  sections.push({
    title: "## Rules",
    lines: [
      "- This shared block is already established. Do NOT re-read or re-scan for it.",
      "- Fetch an evidence body only if your own task genuinely depends on it.",
    ],
    mandatory: true,
  })
  return sections
}

function renderWaveSharedSnapshot(facts, options = {}) {
  const sections = snapshotSections(facts, options)
  return { text: sections.map((section) => [section.title, ...section.lines].join("\n")).join("\n") }
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
  // V16.16 structural fit: whole optional sections first, then prose
  // shortening, then whole trailing list items with an explicit count. A
  // mandatory path/command/evidence-ref is never cut mid-record.
  const fitted = fitSections(childDeltaSections(delta, snapshot), {
    maxChars: WAVE_CONTEXT_LIMITS.maxDeltaChars,
    omissionLabel: "child delta truncated to budget",
  })

  const finalText = fitted.text
  const bounded = fitted.bounded

  return {
    ...delta,
    text: finalText,
    chars: measured(finalText.length),
    untruncatedChars: measured(text.length),
    bounded,
    omittedSections: fitted.omitted,
    fingerprint: `child-delta:sha256:${hash([childId, taskId, goal.text, writeFiles, readFiles, acceptance, verification])}`,
  }
}

function childDeltaSections(delta, snapshot) {
  const sections = []
  sections.push({
    title: `# Child delta (${delta.role || "task"} ${delta.taskId})`,
    lines: [],
    mandatory: true,
  })
  sections.push({
    title: "## Shared context",
    lines: [
      snapshot?.snapshotId
        ? `The wave shared context is ALREADY ESTABLISHED under ${snapshot.snapshotId}. It is not repeated here by design.`
        : "No wave snapshot was supplied; treat repository facts as unknown and establish only what you need.",
    ],
    mandatory: true,
  })
  sections.push({
    title: "## Your task",
    lines: [delta.goal || "(no task text)"],
    mandatory: true,
    prose: true,
  })
  if (delta.acceptance.length) sections.push({ title: "## Acceptance criteria", lines: delta.acceptance.map((row) => `- ${row}`), mandatory: true })
  if (delta.writeFiles.length) sections.push({ title: "## Your write scope (do not write outside this list)", lines: delta.writeFiles.map((row) => `- ${row}`), mandatory: true })
  if (delta.readFiles.length) sections.push({ title: "## Required reads", lines: delta.readFiles.map((row) => `- ${row}`), mandatory: false })
  if (delta.symbols.length) sections.push({ title: "## Relevant symbols", lines: delta.symbols.map((row) => `- ${row}`), mandatory: false })
  if (delta.verification.length) sections.push({ title: "## Targeted verification", lines: delta.verification.map((row) => `- ${row}`), mandatory: true })
  if (delta.verificationCommands.length) {
    sections.push({
      title: "## Targeted verification commands",
      lines: delta.verificationCommands.map((command) => `- ${command}`),
      mandatory: true,
    })
  }
  if (delta.sandboxId) sections.push({ title: "## Sandbox", lines: [delta.sandboxId], mandatory: true })
  if (delta.dependencyReceipts.length) {
    sections.push({
      title: "## Dependency receipts",
      lines: delta.dependencyReceipts.map((row) => `- ${row.taskId}: ${row.status}${row.evidenceRef ? ` (${row.evidenceRef})` : ""}`),
      mandatory: true,
    })
  }
  sections.push({
    title: "## Child rules",
    lines: [
      "- You have a FRESH context. The shared wave facts above are given; do not re-scan for them.",
      "- Stay strictly inside your write scope. A file outside it is a scope violation.",
      "- Run only the targeted verification listed above; do not run the full suite.",
      "- You cannot publish, push, tag, deploy, grant permissions or mark anything PASS.",
      "- Return a compact receipt: changed files, read files, commands run, results, warnings.",
    ],
    mandatory: true,
  })
  return sections
}

function renderChildDelta(delta, snapshot) {
  // Kept for receipt comparability: the full unbounded render. Production
  // prompts use the structurally fitted `text` on the delta object.
  const sections = childDeltaSections(delta, snapshot)
  return sections.map((section) => [section.title, ...section.lines].join("\n")).join("\n")
}

/**
 * V16.16 canonical child capsule: what a production child ACTUALLY receives.
 *
 * V16.15's delta carries only `sharedSnapshotId`, and the production prompt
 * then repeated the task JSON and the parent goal through SEPARATE paths -
 * so the child either never received the shared facts or received the same
 * facts twice. This function is the ONE canonical assembly the production
 * caller uses:
 *
 *   stable wave prefix (small mandatory shared facts INLINE, bounded)
 *   + canonical child delta (child-local facts, reference to the snapshot)
 *   + run binding footer (volatile ids LAST, never in the stable prefix)
 *
 * Delivery classes:
 *   A. Small mandatory facts are INLINED (goal, constraints, requirement ids,
 *      verification commands, workspace generation, evidence REF lines).
 *   B. Large shared evidence travels as Evidence Store REFS (no bodies); the
 *      child fetches a body on demand only if its task genuinely needs it.
 *
 * The capsule contains every field a safe execution needs: task id, role,
 * goal, write/read files, acceptance, verification commands, dependency
 * receipts, snapshot identity, workspace/run identity and scope restriction.
 * Total model-visible chars never exceed maxCapsuleChars (headers + notices
 * + metadata included). `canProduceVerdict` is always false.
 */
const CAPSULE_PREFIX_TITLES = new Set([
  "# Wave shared context (read once by the parent; do not re-discover)",
  "## Goal",
  "## Non-negotiable constraints",
  "## Shared requirement ids",
  "## Known verification commands",
  "## Workspace generation",
  "## Shared source evidence (fetch on demand; bodies live in the Evidence Store)",
  "## Rules",
])

export function buildCanonicalChildCapsule(input = {}) {
  const snapshot = input.snapshot || null
  const child = input.child || {}
  const run = input.run || {}
  const maxChars = Math.max(
    1_000,
    Math.min(32_768, Math.trunc(Number(input.maxChars) || WAVE_CONTEXT_LIMITS.maxCapsuleChars)),
  )

  const delta = createChildDelta({ snapshot, child })

  const prefixSections = snapshot
    ? snapshotSections(snapshot.facts || {}, {
      identity: String(snapshot.snapshotId || "").replace(/^wave-snapshot:sha256:/, ""),
      includePreviews: false,
    }).filter((section) => CAPSULE_PREFIX_TITLES.has(section.title))
    : [{
      title: "## Shared context",
      lines: ["No wave snapshot was supplied; treat repository facts as unknown and establish only what you need."],
      mandatory: true,
    }]

  const deltaSections = childDeltaSections(delta, snapshot).map((section) => {
    if (section.title !== "## Shared context" || !snapshot?.snapshotId) return section
    return {
      ...section,
      lines: [
        `The wave shared facts are inlined ABOVE under the wave prefix (${snapshot.snapshotId}). Do not re-scan for them.`,
      ],
      mandatory: true,
    }
  })

  const runId = run.runId == null ? null : String(run.runId)
  const waveId = run.waveId == null ? (snapshot?.waveId || null) : String(run.waveId)
  const footer = {
    title: "## Run binding (volatile; below the stable prefix by design)",
    lines: [
      `- task: ${delta.taskId}`,
      `- role: ${delta.role || "task"}`,
      runId ? `- run: ${runId}` : null,
      waveId ? `- wave: ${waveId}` : null,
      snapshot?.snapshotId ? `- snapshot: ${snapshot.snapshotId}` : null,
      delta.sandboxId ? `- sandbox: ${delta.sandboxId}` : null,
      snapshot?.facts?.[SNAPSHOT_FACT.WORKSPACE_GENERATION]
        ? `- workspace generation: ${snapshot.facts[SNAPSHOT_FACT.WORKSPACE_GENERATION]}`
        : null,
      "- scope restriction: write ONLY the files listed under Your write scope. A file outside it is a scope violation.",
    ].filter(Boolean),
    mandatory: true,
  }

  const fitted = fitSections([...prefixSections, ...deltaSections, footer], {
    maxChars,
    omissionLabel: "child capsule truncated to budget",
  })

  const prefixChars = prefixSections.reduce((sum, section) =>
    sum + section.title.length + section.lines.reduce((inner, line) => inner + line.length, 0), 0)

  return {
    schemaVersion: WAVE_SHARED_CONTEXT_SCHEMA_VERSION,
    policy: WAVE_SHARED_CONTEXT_POLICY,
    capsule: true,
    childId: delta.childId,
    taskId: delta.taskId,
    role: delta.role,
    readOnly: delta.readOnly,
    snapshotId: snapshot?.snapshotId || null,
    runId,
    waveId,
    sandboxId: delta.sandboxId,
    // The delta is embedded, not referenced-into-nowhere: the child can
    // resolve everything it needs from this text plus on-demand evidence refs.
    delta,
    sharedPrefixChars: measured(prefixChars),
    text: fitted.text,
    chars: measured(fitted.text.length),
    bounded: fitted.bounded,
    omittedSections: fitted.omitted,
    sharedSnapshotFacts: delta.sharedSnapshotFacts,
    notCopied: delta.notCopied,
    canProduceVerdict: false,
    deterministic: true,
  }
}

/**
 * V16.17 (§7) FAIL-CLOSED CHILD CAPSULE FALLBACK.
 *
 * `buildCanonicalChildCapsule` can throw on a pathological snapshot/delta. The
 * pre-V16.17 production caller caught that failure and fell back to the raw
 * child delta, whose ONLY link to the shared facts is `sharedSnapshotId` - a
 * reference the child cannot resolve (it never received the snapshot). That
 * recreated the V16.16 starvation bug: the child was told the shared context
 * was "already established" while holding none of it.
 *
 * This fallback NEVER references a snapshot the child cannot resolve. It
 * INLINE-RENDERS the shared facts the wave already established, plus the child
 * delta, into a bounded text. It is deliberately self-contained and total:
 * it never throws and always returns a usable capsule, so a capsule-builder
 * failure degrades to a slightly larger prompt - never to a starving child.
 */
export function buildFallbackChildCapsule(input = {}) {
  const snapshot = input?.snapshot || null
  const child = input?.child || {}
  const run = input?.run || {}
  const maxChars = Math.max(
    1_000,
    Math.min(32_768, Math.trunc(Number(input?.maxChars) || WAVE_CONTEXT_LIMITS.maxCapsuleChars)),
  )
  let delta = null
  try {
    delta = createChildDelta({ snapshot, child })
  } catch {
    delta = null
  }
  // Inline the shared facts WITHOUT relying on a resolvable snapshot id. When
  // no snapshot was supplied, say so explicitly instead of pointing at one.
  let sharedSections = []
  try {
    sharedSections = snapshot
      ? snapshotSections(snapshot.facts || {}, {
        identity: String(snapshot.snapshotId || "").replace(/^wave-snapshot:sha256:/, ""),
        includePreviews: false,
      }).filter((section) => CAPSULE_PREFIX_TITLES.has(section.title))
      : [{
        title: "# Wave shared context (inline fallback)",
        lines: ["No wave snapshot was supplied; treat repository facts as unknown and establish only what you need."],
        mandatory: true,
      }]
  } catch {
    sharedSections = [{
      title: "# Wave shared context (inline fallback)",
      lines: ["The wave shared block could not be assembled; establish only the facts your task requires."],
      mandatory: true,
    }]
  }
  let deltaSections = []
  try {
    deltaSections = delta ? childDeltaSections(delta, snapshot) : []
  } catch {
    deltaSections = []
  }
  const childId = delta?.childId || String(child.childId || child.taskId || "child")
  const taskId = delta?.taskId || String(child.taskId || childId)
  const footer = {
    title: "## Run binding (inline fallback)",
    lines: [
      `- task: ${taskId}`,
      delta?.role ? `- role: ${delta.role}` : null,
      run?.runId ? `- run: ${String(run.runId)}` : null,
      run?.waveId ? `- wave: ${String(run.waveId)}` : null,
      // Deliberately do NOT emit a snapshot reference the child cannot resolve.
      "- scope restriction: write ONLY the files listed under Your write scope. A file outside it is a scope violation.",
    ].filter(Boolean),
    mandatory: true,
  }
  let text = ""
  try {
    const fitted = fitSections([...sharedSections, ...deltaSections, footer], {
      maxChars,
      omissionLabel: "child capsule (inline fallback) truncated to budget",
    })
    text = fitted.text
  } catch {
    // Last-resort: a compact but still self-describing capsule. Still no
    // unresolvable snapshot reference.
    const goal = String(child?.goal ?? "").slice(0, 400)
    text = [
      "# Child capsule (inline fallback)",
      `- task: ${taskId}`,
      goal ? `## Your task\n${goal}` : null,
    ].filter(Boolean).join("\n")
  }
  return {
    schemaVersion: WAVE_SHARED_CONTEXT_SCHEMA_VERSION,
    policy: WAVE_SHARED_CONTEXT_POLICY,
    capsule: true,
    fallback: true,
    inlineSharedFacts: true,
    childId,
    taskId,
    role: delta?.role || String(child?.role || ""),
    readOnly: delta?.readOnly === true,
    // No snapshot ID is surfaced: the child has the facts inline, not a ref.
    snapshotId: null,
    runId: run?.runId == null ? null : String(run.runId),
    waveId: run?.waveId == null ? (snapshot?.waveId || null) : String(run.waveId),
    sandboxId: delta?.sandboxId ?? null,
    delta,
    text,
    chars: measured(text.length),
    bounded: true,
    canProduceVerdict: false,
    deterministic: true,
  }
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
      "duplicateContextCharsAvoided compares MEASURED char counts against a HYPOTHETICAL "
      + "naive baseline (every child inlining the shared block). The char counts are MEASURED; "
      + "the comparison - and any saving read from it - is DERIVED, never a provider-token measurement. "
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
  buildCanonicalChildCapsule,
  buildFallbackChildCapsule,
  fitSections,
  createCompactHandoff,
  waveContextAccounting,
  normalizeEvidenceRef,
  WAVE_CONTEXT_LIMITS,
  SNAPSHOT_FACT,
})
