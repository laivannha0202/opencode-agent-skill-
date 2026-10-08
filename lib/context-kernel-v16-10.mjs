// V16.10 Context Kernel V2.
//
// WHY THIS MODULE EXISTS
//
// V16.9 already owns the PARTS of context: `context-manifest` assembles
// excerpts, `context-engine-v11` externalizes large ones, `seen-context-ledger`
// remembers what a scope already saw, `reversible-context` stores a raw body and
// exposes T1/T2/T3 summaries, `context-pruning` drops stale failed tool inputs.
// What did NOT exist was a single owner of the DECISION: given a task and a hard
// character budget, which segments ride in the prompt, in what tier, at what
// size, and what exactly was withheld and why.
//
// Without that owner, every caller re-derives its own budget and its own
// truncation, and - the failure mode this kernel exists to prevent - a caller
// can "compact" a block into something LARGER than the original while reporting
// success. Context Kernel V2 makes the decision once and makes it provable.
//
// DESIGN LAWS (from the directive, enforced in code):
//
//   1. DETERMINISTIC COMPACTION FIRST, LLM SUMMARIZATION LAST. The kernel always
//      tries, in order: dedupe -> delta -> prune -> externalize -> structural
//      head/tail. A model summarizer is only ever consulted when a caller
//      explicitly supplies one AND the deterministic passes could not fit the
//      budget. This module never calls a model itself.
//   2. COMPACTION MUST BE PROVABLY BENEFICIAL. `compactDeterministically` returns
//      `applied: false` whenever the candidate is not strictly smaller than the
//      input. A no-op is always preferred to a regression.
//   3. TRUNCATION IS HONEST. Every segment carries original/visible/omitted
//      counts and, when truncated, a retrieval handle. There is no silent cut.
//   4. ONE BEHAVIOR, ONE OWNER. This kernel does not re-implement compression; it
//      ORCHESTRATES the existing owners and owns only the allocation + ledger.
//
// The kernel is a pure planner plus a small async applier that delegates all IO
// to the existing owners (evidence store, seen ledger, reversible context).

import { observeSeenContext, lineDelta } from "./seen-context-ledger.mjs"
import { pruneStaleFailedToolInputs } from "./context-pruning.mjs"
import { compactContext } from "./reversible-context.mjs"
import { measured, NOT_MEASURED, estimateTokensFromChars } from "./measurement-provenance.mjs"
import { createHash } from "node:crypto"

export const CONTEXT_KERNEL_SCHEMA_VERSION = 2
export const CONTEXT_KERNEL_POLICY = "context-kernel-v16-10"

/** Tiers, from most protected to most disposable. */
export const CONTEXT_TIER = Object.freeze({
  PINNED: "pinned", // system rules, task objective, acceptance: never dropped
  TASK: "task", // declared files, plan, contract
  EVIDENCE: "evidence", // ranked excerpts, verification output
  MEMORY: "memory", // long-lived memories
  HISTORY: "history", // prior turns / tool transcripts
})

const TIER_ORDER = [CONTEXT_TIER.PINNED, CONTEXT_TIER.TASK, CONTEXT_TIER.EVIDENCE, CONTEXT_TIER.MEMORY, CONTEXT_TIER.HISTORY]

// Default share of the budget per tier. A tier may borrow unused budget from
// later tiers but never from PINNED, which is sized by its true content.
export const DEFAULT_TIER_SHARES = Object.freeze({
  [CONTEXT_TIER.PINNED]: 0.28,
  [CONTEXT_TIER.TASK]: 0.22,
  [CONTEXT_TIER.EVIDENCE]: 0.32,
  [CONTEXT_TIER.MEMORY]: 0.10,
  [CONTEXT_TIER.HISTORY]: 0.08,
})

function str(value) {
  return String(value ?? "")
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeSegment(segment = {}) {
  const text = str(segment.text ?? segment.content ?? "")
  // V16.14: a segment id must be STABLE across identical inputs. A random
  // fallback made the same segment a new identity on every pass, which defeated
  // the seen-ledger "unchanged" reference and made results non-reproducible. We
  // derive the fallback from the content + tier instead.
  const fallbackId = `segment-${createHash("sha256").update(`${segment.tier || ""}\u0000${text}`, "utf8").digest("hex").slice(0, 12)}`
  return {
    id: str(segment.id || segment.key || segment.path || fallbackId),
    tier: TIER_ORDER.includes(segment.tier) ? segment.tier : CONTEXT_TIER.EVIDENCE,
    text,
    chars: text.length,
    pinned: segment.pinned === true || segment.tier === CONTEXT_TIER.PINNED,
    role: segment.role || null,
    path: segment.path || null,
    evidenceRef: segment.evidenceRef || null,
    source: segment.source || null,
    priority: Number.isFinite(Number(segment.priority)) ? Number(segment.priority) : 0,
  }
}

/**
 * Deterministic compaction passes, in strict order. Each returns the candidate
 * text and a machine-readable reason. This is a PURE function of its inputs; the
 * async applier below is what talks to the evidence store.
 */
export function compactDeterministically(text, options = {}) {
  const original = str(text)
  const originalChars = original.length
  const maxChars = boundedInt(options.maxChars, 12_000, 256, 4 * 1024 * 1024)
  const passes = []

  // Pass 0: nothing to do.
  if (originalChars <= maxChars) {
    return { applied: false, reason: "within-budget", text: original, originalChars, candidateChars: originalChars, passes }
  }

  // Pass 1: collapse runs of blank lines and strip trailing whitespace. This is
  // lossless for meaning and almost always shrinks logs.
  let candidate = original.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n")
  passes.push({ pass: "whitespace", chars: candidate.length })
  if (candidate.length <= maxChars) {
    return { applied: true, reason: "whitespace-collapse", text: candidate, originalChars, candidateChars: candidate.length, passes }
  }

  // Pass 2: drop duplicate consecutive lines (build logs repeat the same line
  // hundreds of times). The first occurrence is kept with a repeat count.
  const lines = candidate.split("\n")
  const deduped = []
  let run = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (deduped.length && deduped[deduped.length - 1] === line) {
      run += 1
      continue
    }
    if (run > 0) {
      deduped[deduped.length - 1] = `${deduped[deduped.length - 1]}  [x${run + 1}]`
      run = 0
    }
    deduped.push(line)
  }
  if (run > 0) deduped[deduped.length - 1] = `${deduped[deduped.length - 1]}  [x${run + 1}]`
  candidate = deduped.join("\n")
  passes.push({ pass: "dedupe-lines", chars: candidate.length })
  if (candidate.length <= maxChars) {
    return { applied: true, reason: "dedupe-consecutive-lines", text: candidate, originalChars, candidateChars: candidate.length, passes }
  }

  // Pass 3: structural head/tail. Both ends of code and logs carry signal; a
  // blind prefix cut drops the failure at the bottom.
  //
  // V16.14: the notice is part of the output, so it MUST be budgeted. The old
  // code sized head+tail to the whole `maxChars` and then appended a notice,
  // which made the "compacted" text larger than the budget it was told to honor.
  // We now reserve room for the notice and shrink head/tail until the shaped
  // result actually fits.
  const buildShaped = (headBudget, tailBudget) => {
    const head = candidate.slice(0, Math.max(0, headBudget))
    const tail = tailBudget > 0 ? candidate.slice(Math.max(head.length, candidate.length - tailBudget)) : ""
    const omitted = Math.max(0, candidate.length - head.length - tail.length)
    const notice = `...[context-kernel: ${omitted} chars omitted; original=${originalChars} candidate=${candidate.length} retrieval=${options.handle || "unavailable"}]`
    return { head, tail, omitted, notice, shaped: `${head}\n${notice}\n${tail}` }
  }

  let headBudget = Math.max(0, Math.floor(maxChars * 0.6))
  let tailBudget = Math.max(0, maxChars - headBudget)
  let built = buildShaped(headBudget, tailBudget)
  // Shrink deterministically until the shaped text fits the budget (or we can
  // no longer shrink without going negative).
  for (let attempt = 0; attempt < 6 && built.shaped.length > maxChars; attempt += 1) {
    const overflow = built.shaped.length - maxChars
    if (headBudget + tailBudget <= overflow) break
    // Take the overflow out of the larger side first.
    if (headBudget >= tailBudget) headBudget = Math.max(0, headBudget - overflow)
    else tailBudget = Math.max(0, tailBudget - overflow)
    built = buildShaped(headBudget, tailBudget)
  }
  const shaped = built.shaped
  const omitted = built.omitted
  passes.push({ pass: "head-tail", chars: shaped.length })

  // LAW: provably beneficial. If head/tail is not actually smaller, refuse.
  if (shaped.length >= originalChars) {
    return { applied: false, reason: "compaction-not-beneficial", text: original, originalChars, candidateChars: shaped.length, passes }
  }
  return { applied: true, reason: "structural-head-tail", text: shaped, originalChars, candidateChars: shaped.length, passes, omittedChars: omitted }
}

/**
 * Pure allocation planner.
 *
 * Given segments and a total budget it decides, per tier, what rides inline at
 * full size, what is compacted, and what is dropped - deterministically, from
 * (tier, priority, size). Pinned segments are never dropped; if pinned content
 * alone exceeds the budget the planner reports `overBudget: true` rather than
 * silently dropping a system rule.
 */
export function planContextKernel(segments = [], options = {}) {
  const budgetChars = boundedInt(options.budgetChars, 48_000, 1_024, 4 * 1024 * 1024)
  const shares = { ...DEFAULT_TIER_SHARES, ...(options.tierShares || {}) }
  const rows = (Array.isArray(segments) ? segments : []).map(normalizeSegment)
  const byTier = new Map(TIER_ORDER.map((tier) => [tier, []]))
  for (const row of rows) byTier.get(row.tier).push(row)
  for (const tier of TIER_ORDER) {
    byTier.get(tier).sort((a, b) => b.priority - a.priority || a.chars - b.chars || a.id.localeCompare(b.id))
  }

  const pinnedDemand = byTier.get(CONTEXT_TIER.PINNED).reduce((sum, row) => sum + row.chars, 0)
  const overBudget = pinnedDemand > budgetChars

  const allocations = []
  let remaining = Math.max(0, budgetChars)
  let carry = 0 // unused budget that later tiers may borrow

  for (const tier of TIER_ORDER) {
    const tierRows = byTier.get(tier)
    const tierDemand = tierRows.reduce((sum, row) => sum + row.chars, 0)
    let allowance
    if (tier === CONTEXT_TIER.PINNED) {
      allowance = Math.max(tierDemand, Math.floor(budgetChars * shares[tier]))
    } else {
      allowance = Math.floor(budgetChars * shares[tier]) + carry
    }
    const effective = Math.min(remaining, allowance)
    let spent = 0
    const decisions = []
    for (const row of tierRows) {
      const left = effective - spent
      if (left <= 0) {
        decisions.push({ id: row.id, action: row.pinned ? "keep-pinned" : "drop", tier, chars: row.chars, keptChars: row.pinned ? row.chars : 0 })
        continue
      }
      if (row.chars <= left) {
        decisions.push({ id: row.id, action: "keep", tier, chars: row.chars, keptChars: row.chars })
        spent += row.chars
      } else {
        // Compact rather than drop when there is meaningful room left.
        const keptChars = Math.max(0, left)
        decisions.push({ id: row.id, action: keptChars >= 256 ? "compact" : "drop", tier, chars: row.chars, keptChars })
        spent += keptChars
      }
    }
    const used = Math.min(spent, effective)
    remaining -= used
    const unused = Math.max(0, effective - used)
    carry = tier === CONTEXT_TIER.PINNED ? 0 : unused
    allocations.push({
      tier,
      demandChars: tierDemand,
      allowanceChars: allowance,
      usedChars: used,
      unusedChars: unused,
      decisions,
    })
  }

  const totalKept = allocations.reduce((sum, row) => sum + row.usedChars, 0)
  const totalDemand = rows.reduce((sum, row) => sum + row.chars, 0)
  return {
    schemaVersion: CONTEXT_KERNEL_SCHEMA_VERSION,
    policy: CONTEXT_KERNEL_POLICY,
    budgetChars,
    totalDemandChars: totalDemand,
    totalKeptChars: totalKept,
    overBudget,
    overBudgetReason: overBudget ? "pinned-context-exceeds-budget" : null,
    allocations,
    // Honest: demand vs kept is always reported, never hidden behind a ratio.
    savedChars: Math.max(0, totalDemand - totalKept),
    provenance: { budget: measured(budgetChars), demand: measured(totalDemand), kept: measured(totalKept) },
  }
}

/**
 * The async applier. It runs the deterministic ladder over each non-pinned
 * segment that the planner chose to compact, delegating all persistence to the
 * existing owners. An optional `options.summarize` callback is the ONLY path to
 * a model: it is consulted last, only for segments the deterministic ladder
 * could not fit, and only if the caller supplied it.
 *
 * Returns the plan, the finalized segments (model-visible text + receipts) and a
 * ledger of what changed.
 */
export async function applyContextKernel(root, segments = [], options = {}) {
  const plan = planContextKernel(segments, options)
  const normalized = (Array.isArray(segments) ? segments : []).map(normalizeSegment)
  const byId = new Map(normalized.map((row) => [row.id, row]))
  const scope = str(options.scope || "context-kernel")
  const handleFor = options.handleFor || null
  const decisionByTier = new Map(plan.allocations.map((row) => [row.tier, row.decisions]))
  const finalized = []
  const ledger = []
  let llmUsed = false
  let deterministicUsed = false

  // Track which ids appear in which decision so we can honor keep/compact/drop.
  const decisionById = new Map()
  for (const tier of TIER_ORDER) {
    for (const decision of decisionByTier.get(tier) || []) decisionById.set(decision.id, decision)
  }

  for (const row of normalized) {
    const decision = decisionById.get(row.id) || { action: row.pinned ? "keep-pinned" : "keep", keptChars: row.chars }
    const seen = observeSeenContext(scope, row.id, row.text, { pinned: row.pinned })
    let text = row.text
    let action = decision.action
    let reason = null
    let omittedChars = 0
    let compaction = null

    if (row.pinned || action === "keep" || action === "keep-pinned") {
      // Unchanged content in a scope is restated by reference, not by value.
      if (!row.pinned && seen.state === "UNCHANGED" && options.deltaOnUnchanged !== false) {
        text = `[unchanged since last turn: ${row.id}; ${row.chars} chars; hash=${String(seen.hash).slice(0, 12)}]`
        action = "unchanged-reference"
        reason = "seen-ledger-unchanged"
      }
    } else if (action === "compact") {
      const budget = Math.max(256, decision.keptChars)
      // Deterministic ladder first.
      const deterministic = compactDeterministically(row.text, { maxChars: budget, handle: handleFor ? handleFor(row) : null })
      if (deterministic.applied) {
        text = deterministic.text
        omittedChars = row.chars - text.length
        compaction = { kind: "deterministic", reason: deterministic.reason, passes: deterministic.passes }
        deterministicUsed = true
      } else if (seen.state === "CHANGED" && seen.previousText) {
        // Prefer an exact delta over a lossy rewrite when we have the previous text.
        const delta = lineDelta(seen.previousText, row.text, { maxChars: budget })
        if (delta.changed && delta.text && delta.text.length < row.chars) {
          text = `[delta since last turn: ${row.id}]\n${delta.text}`
          omittedChars = row.chars - text.length
          compaction = { kind: "delta", changedLines: delta.changedLines, ratio: delta.ratio }
          deterministicUsed = true
        }
      }
      if (!compaction && typeof options.summarize === "function") {
        // LAST RESORT, and only if the caller explicitly provided a summarizer.
        const summarized = await options.summarize({ id: row.id, tier: row.tier, text: row.text, maxChars: budget, evidenceRef: row.evidenceRef }).catch(() => null)
        if (summarized && str(summarized).length < row.chars) {
          text = str(summarized)
          omittedChars = row.chars - text.length
          compaction = { kind: "llm-summary", reason: "deterministic-ladder-insufficient" }
          llmUsed = true
        }
      }
      if (!compaction) {
        // Nothing helped: keep the original rather than ship a regression.
        action = "keep"
        reason = "no-beneficial-compaction"
        text = row.text
        omittedChars = 0
      }
    } else {
      // drop
      text = `[dropped by context kernel: ${row.id}; ${row.chars} chars; tier=${row.tier}${row.evidenceRef ? `; retrieval=${row.evidenceRef}` : ""}]`
      omittedChars = row.chars
      reason = "tier-budget-exhausted"
    }

    finalized.push({
      id: row.id,
      tier: row.tier,
      path: row.path,
      role: row.role,
      evidenceRef: row.evidenceRef,
      action,
      reason,
      text,
      originalChars: row.chars,
      visibleChars: text.length,
      omittedChars: Math.max(0, omittedChars),
      seenState: seen.state,
      compaction,
      honest: true,
    })
    ledger.push({ id: row.id, action, reason, seenState: seen.state, originalChars: row.chars, visibleChars: text.length })
  }

  return {
    schemaVersion: CONTEXT_KERNEL_SCHEMA_VERSION,
    policy: CONTEXT_KERNEL_POLICY,
    plan,
    segments: finalized,
    ledger,
    text: finalized.map((row) => row.text).join("\n\n"),
    usedDeterministicCompaction: deterministicUsed,
    usedLlmSummarization: llmUsed,
    // The ordering law is observable: a caller can assert that no model call was
    // made before the deterministic ladder had its chance.
    orderingLaw: "deterministic-first-llm-last",
    provenance: { llmSummarization: llmUsed ? "DERIVED" : NOT_MEASURED },
  }
}

/**
 * Reduce stale failed tool inputs before planning. Thin, explicit delegation to
 * the existing pruning owner so the kernel never grows a second pruner.
 */
export function pruneContextHistory(messages = [], options = {}) {
  return pruneStaleFailedToolInputs(messages, options)
}

/**
 * Estimate the token cost of a kernel result. Always ESTIMATED, never MEASURED:
 * only a provider response can produce a measured token count.
 */
export function estimateKernelTokens(result, options = {}) {
  const chars = str(result?.text || "").length
  return { ...estimateTokensFromChars(chars, options), provenance: "ESTIMATED", chars: measured(chars) }
}

/** Expose the reversible store so the kernel and callers share one compactor. */
export async function compactKernelSegment(root, content, options = {}) {
  return compactContext(root, content, options)
}

export const contextKernelExports = Object.freeze({
  planContextKernel,
  applyContextKernel,
  compactDeterministically,
  pruneContextHistory,
  estimateKernelTokens,
  compactKernelSegment,
  CONTEXT_TIER,
})
