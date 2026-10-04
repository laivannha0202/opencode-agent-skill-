// V16.3 Phase B, steps 10, 11 and 14: the Decision Packet.
//
// The packet is the single artifact that leaves the machine, so it is built
// under three independent constraints:
//
//   1. BOUNDED. Every section has its own budget and the whole packet has a
//      ceiling. The builder reports an estimate BEFORE anything is sent, and
//      degrades by ranking/compacting low-value evidence -- never by silently
//      truncating a MUST / MUST_NOT constraint.
//   2. RELEVANT. Repository map, files and evidence are ranked inputs; unrelated
//      source, build output, node_modules, generated artifacts and stale logs are
//      not merely deprioritised, they are dropped by an explicit filter.
//   3. SECRET-FREE. Redaction runs on the assembled packet, so a secret that
//      arrives inside a diff, a snippet or a test log cannot leave the machine.

import { createHash } from "node:crypto"
import { redactSecrets, redactStructure } from "./secret-redaction.mjs"
import { externalTrustContract } from "./browser-security.mjs"

export const DECISION_PACKET_SCHEMA_VERSION = 1

export const DECISION_PACKET_SECTION = Object.freeze({
  ORIGINAL_TASK: "originalTask",
  REQUIREMENT_SUMMARY: "requirementSummary",
  ARCHITECTURE_MAP: "repositoryArchitectureMap",
  RELEVANT_SUBSYSTEMS: "relevantSubsystems",
  RELEVANT_FILES: "relevantFiles",
  DEPENDENCY_GRAPH: "dependencyAndChangeGraph",
  SNIPPETS: "exactRelevantSnippets",
  CURRENT_DIFF: "currentDiff",
  FAILING_EVIDENCE: "failingTestRuntimeEvidence",
  PREVIOUS_ATTEMPTS: "previousAttempts",
  UNRESOLVED_QUESTIONS: "unresolvedQuestions",
  CONSTRAINTS: "constraintsMustNot",
  VERIFICATION: "verificationExpectations",
})

// Section order is FIXED. The provider sees the same packet shape every time,
// which is what makes the content hash comparable across runs and lets a follow
// up send only the delta.
export const DECISION_PACKET_SECTION_ORDER = Object.freeze([
  DECISION_PACKET_SECTION.ORIGINAL_TASK,
  DECISION_PACKET_SECTION.REQUIREMENT_SUMMARY,
  DECISION_PACKET_SECTION.CONSTRAINTS,
  DECISION_PACKET_SECTION.VERIFICATION,
  DECISION_PACKET_SECTION.ARCHITECTURE_MAP,
  DECISION_PACKET_SECTION.RELEVANT_SUBSYSTEMS,
  DECISION_PACKET_SECTION.RELEVANT_FILES,
  DECISION_PACKET_SECTION.DEPENDENCY_GRAPH,
  DECISION_PACKET_SECTION.SNIPPETS,
  DECISION_PACKET_SECTION.CURRENT_DIFF,
  DECISION_PACKET_SECTION.FAILING_EVIDENCE,
  DECISION_PACKET_SECTION.PREVIOUS_ATTEMPTS,
  DECISION_PACKET_SECTION.UNRESOLVED_QUESTIONS,
])

// Sections whose content is a hard requirement of the task. When the budget is
// tight these are the sections that are never compacted away.
const ESSENTIAL_SECTIONS = new Set([
  DECISION_PACKET_SECTION.ORIGINAL_TASK,
  DECISION_PACKET_SECTION.REQUIREMENT_SUMMARY,
  DECISION_PACKET_SECTION.CONSTRAINTS,
  DECISION_PACKET_SECTION.VERIFICATION,
])

export const DEFAULT_DECISION_PACKET_BUDGET = Object.freeze({
  maxPacketChars: 48_000,
  maxFiles: 24,
  maxSnippets: 12,
  maxEvidence: 10,
  maxDiffChars: 12_000,
  maxSectionChars: 6_000,
  maxSnippetChars: 1_600,
  maxEvidenceChars: 2_000,
})

// Paths that must never appear in a packet, regardless of how relevant the task
// looks. An exclusion list is the honest form of "do not send the repository".
const EXCLUDED_PATH_PATTERNS = [
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)(?:dist|build|out|coverage|\.next|\.nuxt|target|vendor)(\/|$)/i,
  /(^|\/)\.ues-(?:cache|traces|work|learning|memory|evals)(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)(?:\.env|\.env\.[a-z]+|.*\.pem|.*\.key|id_rsa|id_ed25519)$/i,
  /(^|\/)\.(?:npmrc|pypirc|netrc|aws\/credentials)$/i,
  /\.(?:log|lock|map|min\.js|min\.css|tgz|tar\.gz|zip)$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
]

export function isExcludedPacketPath(path = "") {
  const value = String(path || "").replaceAll("\\", "/")
  if (!value) return true
  return EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(value))
}

// The builder cannot know what is relevant -- retrieval does. So relevance is an
// EXPLICIT input: a row marked `relevant: false` (or `exclude: true`) is dropped
// and counted, rather than being silently carried because it happened to be in
// the input array. This is what makes "unrelated source is not sent" a checkable
// property instead of a promise.
export function isRelevantPacketRow(row) {
  if (typeof row === "string") return true
  if (!row || typeof row !== "object") return false
  if (row.relevant === false) return false
  if (row.exclude === true) return false
  if (row.irrelevant === true) return false
  return true
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function clip(text, maxChars) {
  const value = String(text ?? "")
  if (value.length <= maxChars) return { text: value, truncated: false, chars: value.length }
  // A truncated snippet keeps a head and a tail: the signature is usually at the
  // top and the failure context at the bottom, and a head-only clip routinely
  // deletes the error line that made the snippet worth sending.
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head - 24
  return {
    text: `${value.slice(0, head)}\n...[${value.length - maxChars} chars elided]...\n${value.slice(-tail)}`,
    truncated: true,
    chars: value.length,
  }
}

function asRows(value, max) {
  return (Array.isArray(value) ? value : [])
    .filter((row) => row !== null && row !== undefined && row !== "")
    .slice(0, max)
}

/** @type {Map<string, any>} */
const PACKET_CACHE = new Map()
const PACKET_CACHE_LIMIT = 64

export function clearDecisionPacketCache() {
  PACKET_CACHE.clear()
}

// Content hash over the parts that should invalidate the packet. Sections the
// user cannot influence (ordering, provider id) are deliberately excluded so
// the same repository state always hashes the same.
export function decisionPacketFingerprint(packet = {}) {
  const material = JSON.stringify({
    task: packet.sections?.[DECISION_PACKET_SECTION.ORIGINAL_TASK] ?? null,
    requirements: packet.sections?.[DECISION_PACKET_SECTION.REQUIREMENT_SUMMARY] ?? null,
    constraints: packet.sections?.[DECISION_PACKET_SECTION.CONSTRAINTS] ?? null,
    verification: packet.sections?.[DECISION_PACKET_SECTION.VERIFICATION] ?? null,
    map: packet.sections?.[DECISION_PACKET_SECTION.ARCHITECTURE_MAP] ?? null,
    subsystems: packet.sections?.[DECISION_PACKET_SECTION.RELEVANT_SUBSYSTEMS] ?? null,
    files: packet.sections?.[DECISION_PACKET_SECTION.RELEVANT_FILES] ?? null,
    graph: packet.sections?.[DECISION_PACKET_SECTION.DEPENDENCY_GRAPH] ?? null,
    snippets: packet.sections?.[DECISION_PACKET_SECTION.SNIPPETS] ?? null,
    diff: packet.sections?.[DECISION_PACKET_SECTION.CURRENT_DIFF] ?? null,
    evidence: packet.sections?.[DECISION_PACKET_SECTION.FAILING_EVIDENCE] ?? null,
    attempts: packet.sections?.[DECISION_PACKET_SECTION.PREVIOUS_ATTEMPTS] ?? null,
    questions: packet.sections?.[DECISION_PACKET_SECTION.UNRESOLVED_QUESTIONS] ?? null,
  })
  return createHash("sha256").update(material).digest("hex").slice(0, 32)
}

export function estimatePacketChars(packet = {}) {
  return JSON.stringify(packet.sections || {}).length
}

/**
 * V16.6.1: the size the PROVIDER ACTUALLY RECEIVES.
 *
 * The v16.6 budget was enforced against `JSON.stringify(sections).length`
 * while the outbound artifact is `renderDecisionPacket(...)`, which adds the
 * envelope header, the per-section `## name` labels and the indentation the
 * renderer adds to structured values. `withinBudget: true` therefore described
 * a payload that was never sent. Both numbers are reported now: the JSON
 * estimate and the real rendered size.
 */
export function renderedPacketChars(packet = {}) {
  return renderDecisionPacket(packet).length
}

/** Split a constraint list without ever splitting one constraint's text. */
function clipConstraintList(rows, maxChars) {
  const kept = [];
  let used = 2;
  let dropped = 0;
  for (const row of rows) {
    const asText = JSON.stringify(row);
    const candidate = used + asText.length + 1;
    if (candidate > maxChars) {
      dropped += 1;
      continue;
    }
    kept.push(row);
    used = candidate;
  }
  if (!kept.length && rows.length) {
    // At least ONE constraint always survives: dropping every MUST/MUST_NOT and
    // reporting success is the one outcome this module must never produce.
    kept.push(rows[0]);
    dropped = Math.max(0, rows.length - 1);
  }
  return { rows: kept, dropped };
}

function cacheKey(fingerprint, budget) {
  return `${fingerprint}:${budget.maxPacketChars}:${budget.maxFiles}:${budget.maxSnippets}:${budget.maxEvidence}:${budget.maxDiffChars}`
}

function readCache(key) {
  const row = PACKET_CACHE.get(key)
  if (!row) return null
  // Move-to-front: the cache is tiny and bounded, and the most recent packet is
  // the one a follow-up will compare against.
  PACKET_CACHE.delete(key)
  PACKET_CACHE.set(key, row)
  return row
}

function writeCache(key, value) {
  PACKET_CACHE.set(key, value)
  while (PACKET_CACHE.size > PACKET_CACHE_LIMIT) {
    const oldest = PACKET_CACHE.keys().next().value
    PACKET_CACHE.delete(oldest)
  }
}

/**
 * Build a bounded, redacted Decision Packet.
 *
 * `input` supplies the already-ranked context (repo map, files, snippets, diff,
 * evidence). The builder does not fetch anything itself: retrieval quality is
 * the caller's contract, and this module's contract is that whatever arrives is
 * filtered, budgeted, redacted and fingerprinted.
 */
export function buildDecisionPacket(input = {}, options = {}) {
  const budget = {
    maxPacketChars: boundedInt(options.maxPacketChars, DEFAULT_DECISION_PACKET_BUDGET.maxPacketChars, 2_000, 2_000_000),
    maxFiles: boundedInt(options.maxFiles, DEFAULT_DECISION_PACKET_BUDGET.maxFiles, 1, 200),
    maxSnippets: boundedInt(options.maxSnippets, DEFAULT_DECISION_PACKET_BUDGET.maxSnippets, 1, 100),
    maxEvidence: boundedInt(options.maxEvidence, DEFAULT_DECISION_PACKET_BUDGET.maxEvidence, 1, 100),
    maxDiffChars: boundedInt(options.maxDiffChars, DEFAULT_DECISION_PACKET_BUDGET.maxDiffChars, 500, 400_000),
    maxSectionChars: boundedInt(options.maxSectionChars, DEFAULT_DECISION_PACKET_BUDGET.maxSectionChars, 500, 200_000),
    maxSnippetChars: boundedInt(options.maxSnippetChars, DEFAULT_DECISION_PACKET_BUDGET.maxSnippetChars, 100, 40_000),
    maxEvidenceChars: boundedInt(options.maxEvidenceChars, DEFAULT_DECISION_PACKET_BUDGET.maxEvidenceChars, 100, 40_000),
  }

  const task = String(input.originalTask || "").trim()
  const requirements = asRows(input.requirements, 40)
  const constraints = asRows(input.constraints, 40)
  const verification = asRows(input.verification, 40)

  // --- relevance filter ------------------------------------------------------
  const inputFiles = asRows(input.relevantFiles, 400)
  const relevantFiles = inputFiles.filter(isRelevantPacketRow)
  // The two drop reasons are counted SEPARATELY. Merging them produced a
  // report that claimed zero path exclusions while the node_modules row was
  // being dropped, which is exactly the kind of quiet drift the `excluded`
  // block exists to prevent.
  const filesDroppedByRelevance = inputFiles.length - relevantFiles.length
  const filesAll = relevantFiles.filter((row) => !isExcludedPacketPath(row?.path ?? row))
  const filesDroppedByPath = relevantFiles.length - filesAll.length
  const files = filesAll.slice(0, budget.maxFiles)
  const allowedPaths = new Set(files.map((row) => String(row?.path ?? row)))

  const inputSnippets = asRows(input.snippets, 200)
  const snippetsAll = inputSnippets.filter((row) => {
    if (!isRelevantPacketRow(row)) return false
    const path = String(row?.path ?? "")
    if (path && isExcludedPacketPath(path)) return false
    // A snippet for a file the packet does not carry is exactly the unrelated
    // source the exclusion is meant to keep out.
    if (path && allowedPaths.size > 0 && !allowedPaths.has(path)) return false
    return true
  })
  const snippets = snippetsAll.slice(0, budget.maxSnippets).map((row) => {
    const clipped = clip(row?.text ?? row?.content ?? "", budget.maxSnippetChars)
    return {
      path: row?.path ?? null,
      symbol: row?.symbol ?? null,
      lines: row?.lines ?? null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      text: clipped.text,
      truncated: clipped.truncated,
    }
  })
  const evidence = asRows(input.evidence, 200)
    .slice(0, budget.maxEvidence)
    .map((row) => {
      const clipped = clip(row?.text ?? row?.message ?? JSON.stringify(row ?? ""), budget.maxEvidenceChars)
      return {
        kind: row?.kind ?? "runtime",
        source: row?.source ?? null,
        text: clipped.text,
        truncated: clipped.truncated,
      }
    })

  const diffClipped = clip(input.diff ?? "", budget.maxDiffChars)

  /** @type {Record<string, any>} */
  const sections = {
    [DECISION_PACKET_SECTION.ORIGINAL_TASK]: task,
    [DECISION_PACKET_SECTION.REQUIREMENT_SUMMARY]: requirements,
    [DECISION_PACKET_SECTION.ARCHITECTURE_MAP]: input.repoMap ?? null,
    [DECISION_PACKET_SECTION.RELEVANT_SUBSYSTEMS]: asRows(input.subsystems, 30),
    [DECISION_PACKET_SECTION.RELEVANT_FILES]: files.map((row) => (typeof row === "string" ? row : {
      path: row?.path ?? null,
      role: row?.role ?? null,
      reason: row?.reason ?? null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
    })),
    [DECISION_PACKET_SECTION.DEPENDENCY_GRAPH]: asRows(input.dependencyGraph, 60),
    [DECISION_PACKET_SECTION.SNIPPETS]: snippets,
    [DECISION_PACKET_SECTION.CURRENT_DIFF]: { text: diffClipped.text, truncated: diffClipped.truncated, chars: diffClipped.chars },
    [DECISION_PACKET_SECTION.FAILING_EVIDENCE]: evidence,
    [DECISION_PACKET_SECTION.PREVIOUS_ATTEMPTS]: asRows(input.previousAttempts, 12),
    [DECISION_PACKET_SECTION.UNRESOLVED_QUESTIONS]: asRows(input.unresolvedQuestions, 20),
    [DECISION_PACKET_SECTION.CONSTRAINTS]: constraints,
    [DECISION_PACKET_SECTION.VERIFICATION]: verification,
  }

  // --- budget enforcement ---------------------------------------------------
  const compacted = applyBudget(sections, budget)

  const draft = {
    schemaVersion: DECISION_PACKET_SCHEMA_VERSION,
    kind: "ues-decision-packet",
    provider: String(options.provider || "deepseek-web"),
    sections: compacted.sections,
    budget,
    budgetReport: {
      ...compacted.report,
      // `rendered` is recomputed below against the REDACTED packet; the value
      // recorded here is the pre-redaction measurement so a redaction that
      // changed the size is visible rather than hidden.
      preRedactionRenderedChars: compacted.report.renderedChars,
    },
    excluded: {
      excludedPaths: Math.max(0, filesDroppedByPath),
      relevanceFilteredFiles: Math.max(0, filesDroppedByRelevance),
      excludedSnippets: inputSnippets.length - snippetsAll.length,
      excludedEvidence: Math.max(0, asRows(input.evidence, 200).length - evidence.length),
      excludedFiles: Math.max(0, filesAll.length - files.length),
    },
    trustLevel: "untrusted-external",
    ...externalTrustContract("decision-packet-outbound"),
  }

  // --- redaction (after assembly, so nothing escapes) -----------------------
  const scrubbed = redactStructure(draft, { maxDepth: 8, maxKeys: 4_000 })
  const packet = scrubbed.value
  // V16.6.1: the fingerprint is computed BEFORE rendering so the rendered
  // payload carries the real fingerprint. Rendering first emitted
  // `fingerprint=unknown` into the outbound text and made the measured
  // rendered size disagree with a re-render of the same packet.
  const fingerprint = decisionPacketFingerprint(packet)
  const chars = estimatePacketChars(packet)
  const rendered = renderDecisionPacket({ ...packet, fingerprint })

  const key = cacheKey(fingerprint, budget)
  const cached = readCache(key)
  if (!cached) writeCache(key, { fingerprint, chars, builtAtMs: 0 })
  const cacheHit = Boolean(cached)

  return {
    ...packet,
    fingerprint,
    cacheHit,
    cacheHits: cacheHit ? 1 : 0,
    chars,
    renderedChars: rendered.length,
    rendered,
    // V16.6.1: the claim is re-evaluated against the payload that actually goes
    // out, and any disagreement is reported instead of being smoothed over.
    budgetReport: {
      ...packet.budgetReport,
      renderedChars: rendered.length,
      withinBudget: rendered.length <= Number(packet.budget?.maxPacketChars || Number.MAX_SAFE_INTEGER),
      basis: "rendered-outbound-payload",
    },
  }
}

// Rank -> compact -> drop, per section, in that order. Essential sections get a
// larger allowance and are never dropped; only non-essential sections shrink.
function applyBudget(sections, budget) {
  const nonEssential = Object.keys(sections).length * budget.maxSectionChars + 8_000
  const essentialOnly = Object.keys(sections).length * Math.floor(budget.maxSectionChars / 3) + 4_000
  const overBudget = nonEssential > budget.maxPacketChars
  const report = {
    mode: overBudget ? "compacted" : "full",
    compactedSections: [],
    droppedSections: [],
    withinBudget: true,
  }

  const next = {}
  for (const name of DECISION_PACKET_SECTION_ORDER) {
    const value = sections[name]
    const essential = ESSENTIAL_SECTIONS.has(name)
    if (essential) {
      // V16.6.1: an essential list (requirements / MUST / MUST_NOT / verification
      // expectations) is compacted by DROPPING WHOLE rows, never by clipping a
      // row's text. The previous `clip(asText, maxSectionChars)` produced a
      // single string containing the first part of one constraint and the middle
      // of the next: a semantically altered constraint that still looked
      // present.
      if (Array.isArray(value)) {
        if (JSON.stringify(value).length <= budget.maxSectionChars) {
          next[name] = value
        } else {
          const compacted = clipConstraintList(value, budget.maxSectionChars)
          next[name] = compacted.rows
          report.compactedSections.push(name)
          report.droppedConstraints = (report.droppedConstraints || 0) + compacted.dropped
        }
        continue
      }
      const asText = typeof value === "string" ? value : JSON.stringify(value)
      if (asText.length > budget.maxSectionChars) {
        const clipped = clip(asText, budget.maxSectionChars)
        next[name] = Array.isArray(value) ? [clipped.text] : clipped.text
        report.compactedSections.push(name)
      } else {
        next[name] = value
      }
      continue
    }
    const asText = JSON.stringify(value ?? null)
    if (asText.length <= budget.maxSectionChars) {
      next[name] = value
      continue
    }
    // Compact by reducing list length first, then clipping the last survivor.
    if (Array.isArray(value) && value.length > 1) {
      let rows = value
      while (rows.length > 1 && JSON.stringify(rows).length > budget.maxSectionChars) {
        rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)))
      }
      next[name] = rows
      report.compactedSections.push(name)
      continue
    }
    if (asText === "null" || asText === '""' || asText === "[]") {
      next[name] = value
      continue
    }
    next[name] = clip(asText, budget.maxSectionChars).text
    report.compactedSections.push(name)
  }

  // Hard ceiling: while over budget, shed the lowest-value non-essential
  // sections. NEVER the original task, requirements, constraints or
  // verification expectations.
  const shedOrder = [
    DECISION_PACKET_SECTION.PREVIOUS_ATTEMPTS,
    DECISION_PACKET_SECTION.UNRESOLVED_QUESTIONS,
    DECISION_PACKET_SECTION.DEPENDENCY_GRAPH,
    DECISION_PACKET_SECTION.ARCHITECTURE_MAP,
    DECISION_PACKET_SECTION.SNIPPETS,
    DECISION_PACKET_SECTION.CURRENT_DIFF,
    DECISION_PACKET_SECTION.FAILING_EVIDENCE,
    DECISION_PACKET_SECTION.RELEVANT_SUBSYSTEMS,
    DECISION_PACKET_SECTION.RELEVANT_FILES,
  ]
  let cursor = 0
  while (estimatePacketChars({ sections: next }) > budget.maxPacketChars && cursor < shedOrder.length) {
    const victim = shedOrder[cursor]
    if (!ESSENTIAL_SECTIONS.has(victim) && next[victim] !== null && next[victim] !== undefined) {
      next[victim] = null
      report.droppedSections.push(victim)
    }
    cursor += 1
  }

  const finalChars = estimatePacketChars({ sections: next })
  report.estimatedChars = finalChars
  report.essentialFloorChars = essentialOnly
  // V16.6.1: the budget is judged on the payload that leaves the machine.
  const finalRendered = renderedPacketChars({ provider: "budget-probe", fingerprint: "budget-probe", sections: next })
  report.renderedChars = finalRendered
  report.withinBudget = finalRendered <= budget.maxPacketChars
  report.basis = "rendered-outbound-payload"
  if (!report.withinBudget) {
    // Shed the lowest-value non-essential sections until the RENDERED payload
    // fits. Essential sections are never a shedding candidate, so this is
    // reported honestly rather than looping forever.
    const renderAfterShed = () => renderedPacketChars({ provider: "budget-probe", fingerprint: "budget-probe", sections: next })
    let shedCursor = 0
    while (renderAfterShed() > budget.maxPacketChars && shedCursor < shedOrder.length) {
      const victim = shedOrder[shedCursor];
      shedCursor += 1
      if (ESSENTIAL_SECTIONS.has(victim)) continue
      if (next[victim] === null || next[victim] === undefined) continue
      next[victim] = null
      report.droppedSections.push(victim);
    }
    report.renderedChars = renderAfterShed()
    report.estimatedChars = estimatePacketChars({ sections: next })
    report.withinBudget = report.renderedChars <= budget.maxPacketChars
  }
  // An essential floor larger than the requested ceiling is an EXPLICIT
  // outcome, never a silent clip: either the tier was raised, or the caller is
  // told the essential content did not fit.
  report.essentialFloorExceedsTier = essentialOnly > budget.maxPacketChars
  if (report.essentialFloorExceedsTier) {
    report.withinBudget = false
    report.violations = ["essential-floor-exceeds-tier"]
  }
  return { sections: next, report }
}

export function renderDecisionPacket(packet = {}) {
  const sections = packet.sections || {}
  const lines = [
    "[UES DECISION PACKET]",
    `provider=${packet.provider || "deepseek-web"} fingerprint=${packet.fingerprint || "unknown"}`,
    "You are a CONSULTANT. You do not execute anything and you do not decide PASS/FAIL.",
    "",
  ]
  for (const name of DECISION_PACKET_SECTION_ORDER) {
    const value = sections[name]
    if (value === null || value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    lines.push(`## ${name}`)
    lines.push(typeof value === "string" ? value : JSON.stringify(value, null, 1))
    lines.push("")
  }
  lines.push("[END UES DECISION PACKET]")
  return lines.join("\n")
}

/**
 * Follow-up DELTA. Sends only what changed since the packet the provider already
 * saw, which is the whole point of sending a packet at all: a re-send of the
 * full context for every verifier failure is how a consultation becomes more
 * expensive than the task.
 */
export function buildFollowUpDelta(previous = {}, next = {}, options = {}) {
  const budgetChars = boundedInt(options.maxDeltaChars, 16_000, 1_000, 400_000)
  const previousSections = previous.sections || {}
  const nextSections = next.sections || {}
  /** @type {Record<string, {before: string, after: string, changed: boolean}>} */
  const changes = {}
  let unchanged = 0
  for (const name of DECISION_PACKET_SECTION_ORDER) {
    const before = JSON.stringify(previousSections[name] ?? null)
    const after = JSON.stringify(nextSections[name] ?? null)
    const changed = before !== after
    if (changed) changes[name] = { before, after, changed: true }
    else unchanged += 1
  }
  const changedNames = Object.keys(changes)

  if (!changedNames.length) {
    return {
      schemaVersion: DECISION_PACKET_SCHEMA_VERSION,
      kind: "ues-decision-packet-delta",
      changed: false,
      reason: previous.fingerprint === next.fingerprint ? "identical-fingerprint" : "no-section-changed",
      changedSections: [],
      // Uniform shape: the unchanged branch carries the same keys as the changed
      // one, so a caller can read `savedChars`/`sections` without first testing
      // `changed`. An unchanged delta saved nothing and moved nothing.
      sections: {},
      chars: 0,
      savedChars: 0,
      droppedSections: 0,
      unchangedSections: DECISION_PACKET_SECTION_ORDER.length,
      previousFingerprint: previous.fingerprint || null,
      fingerprint: next.fingerprint || null,
      trustLevel: "untrusted-external",
    }
  }

  const deltaSections = {}
  let chars = 0
  let dropped = 0
  /** @type {string[]} */
  const omittedChangedSections = []
  for (const name of changedNames) {
    const entry = `${changes[name].after}`
    if (chars + entry.length > budgetChars) {
      dropped += 1
      omittedChangedSections.push(name)
      continue
    }
    chars += entry.length
    deltaSections[name] = JSON.parse(entry)
  }
  const sentSections = Object.keys(deltaSections)

  return {
    schemaVersion: DECISION_PACKET_SCHEMA_VERSION,
    kind: "ues-decision-packet-delta",
    changed: true,
    // V16.6.1: `changedSections` is exactly what was SENT. It used to list
    // every section that differed, including the ones dropped by the budget,
    // so a consumer could believe it had received evidence it never got.
    changedSections: sentSections,
    // Changed but not sent: the caller must decide whether a delta that omits a
    // CRITICAL section may be sent at all.
    omittedChangedSections,
    criticalSectionsOmitted: omittedChangedSections.filter((name) => ESSENTIAL_SECTIONS.has(name)),
    // A delta that omits an essential section must not be presented as a
    // faithful update of the conversation.
    misleading: omittedChangedSections.length > 0,
    droppedSections: dropped,
    unchangedSections: unchanged,
    sections: deltaSections,
    chars,
    savedChars: Math.max(0, (previous.chars || 0) - chars),
    previousFingerprint: previous.fingerprint || null,
    fingerprint: next.fingerprint || null,
    trustLevel: "untrusted-external",
    ...externalTrustContract("decision-packet-delta-outbound"),
  }
}

// Redaction-aware text rendering, used before anything is handed to a provider.
export function renderRedactedPrompt(text, options = {}) {
  const result = redactSecrets(String(text ?? ""), options)
  return { text: result.text, redacted: result.redacted, hits: result.hits }
}
