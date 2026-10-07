// V16.9 shared context ledger.
//
// WHY THIS MODULE EXISTS
//
// The advisor and the executor already share facts: the Decision Packet, the
// resume capsule, the evidence deltas. But nothing owns the question "what has
// the advisor ALREADY seen?" across turns. V16.8 re-sent the full context on
// every follow-up and relied on the provider to notice nothing changed; the
// freshness gate could only say "something changed", not "here is the part that
// changed".
//
// This module is the single ledger of shared context for one advisor lifecycle.
// It does not re-implement change detection: `lib/seen-context-ledger.mjs`
// already owns the hash/state/line-delta primitive. This module wraps it with
// the advisor-facing contract:
//
//   * a bounded, per-lifecycle record of every context block the advisor saw;
//   * a `planShare()` that returns ONLY the blocks worth sending and the
//     already-seen blocks that must be skipped;
//   * an honest `savedChars` count that is MEASURED (character lengths), never a
//     fabricated token estimate.
//
// It owns NO budget, NO authority and NO escalation rule.

import {
  lineDelta,
  observeSeenContext,
  resetSeenContextLedger,
  seenContextLedgerStats,
} from "./seen-context-ledger.mjs"
import { measured } from "./measurement-provenance.mjs"

export const SHARED_CONTEXT_LEDGER_SCHEMA_VERSION = 1
export const SHARED_CONTEXT_LEDGER_POLICY = "shared-context-ledger-v16-9"

// Context that is UNCHANGED must not be re-sent: the advisor already has it.
// NEW and CHANGED blocks are always worth sending. STALE (past TTL) is treated
// as NEW because the advisor's view can no longer be trusted.
const SEND_STATES = new Set(["NEW", "CHANGED", "STALE"])

function boundedChars(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * One context block to consider sharing. `key` is a stable identity (e.g.
 * "diff", "plan", "verifier-output"); `text` is the current content.
 */
function normalizeBlock(block) {
  if (block == null) return null
  const key = String(block.key ?? block.id ?? "").trim()
  if (!key) return null
  return {
    key,
    kind: String(block.kind || "context"),
    text: String(block.text ?? ""),
    pinned: block.pinned === true,
  }
}

/**
 * Create a shared context ledger bound to one advisor lifecycle `scope`.
 */
export function createSharedContextLedger(options = {}) {
  const baseScope = String(options.scope || "shared-context")
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const maxEntries = boundedChars(options.maxEntries, 256, 16, 4096)
  const ttlMs = boundedChars(options.ttlMs, 30 * 60_000, 1000, 24 * 60 * 60_000)
  let observations = 0
  let sentBlocks = 0
  let skippedBlocks = 0
  let measuredSavedChars = 0
  // V16.9 epoch: an EPOCH is a hard invalidation barrier. When the workspace is
  // mutated (a write lands) the previous evidence can no longer be trusted, so
  // the epoch advances and every subsequent observation is against a fresh,
  // EMPTY namespace. Reuse is therefore impossible until the advisor has been
  // shown the post-mutation bytes at least once. The epoch is part of the
  // scope key, so it can never collide with the pre-mutation record.
  let epoch = 0
  let lastBumpReason = null
  const scopeOf = () => (epoch === 0 ? baseScope : `${baseScope}#e${epoch}`)

  /**
   * Observe one block and return its state plus a bounded delta of what changed
   * since the advisor last saw this key.
   */
  function observe(block, observeOptions = {}) {
    const normalized = normalizeBlock(block)
    if (!normalized) return { ok: false, reason: "invalid-block" }
    observations += 1
    const observation = observeSeenContext(scopeOf(), normalized.key, normalized.text, {
      now: Number(now()),
      ttlMs,
      maxEntries,
      pinned: normalized.pinned,
    })
    const delta = observation.state === "CHANGED" && typeof observation.previousText === "string"
      ? lineDelta(observation.previousText, normalized.text, { maxChars: observeOptions.maxDeltaChars })
      : null
    return {
      ok: true,
      key: normalized.key,
      kind: normalized.kind,
      state: observation.state,
      hash: observation.hash,
      chars: observation.chars,
      previousChars: observation.previousChars,
      deltaText: delta?.changed ? delta.text : null,
      deltaChars: delta?.changed ? String(delta.text).length : 0,
    }
  }

  /**
   * Plan what to share for a set of blocks.
   *
   * Returns `toSend` (NEW/CHANGED/STALE blocks, each with the text to send) and
   * `skipped` (UNCHANGED blocks the advisor already has). `savedChars` is the
   * sum of the SKIPPED blocks' character lengths - a MEASURED quantity, not a
   * token estimate.
   */
  function planShare(blocks = [], planOptions = {}) {
    const toSend = []
    const skipped = []
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const result = observe(block, planOptions)
      if (!result.ok) continue
      if (SEND_STATES.has(result.state)) {
        toSend.push({ ...result, text: normalizeBlock(block).text })
        sentBlocks += 1
      } else {
        skipped.push(result)
        skippedBlocks += 1
        measuredSavedChars += Number(result.chars || 0)
      }
    }
    return {
      schemaVersion: SHARED_CONTEXT_LEDGER_SCHEMA_VERSION,
      policy: SHARED_CONTEXT_LEDGER_POLICY,
      scope: scopeOf(),
      toSend,
      skipped,
      toSendChars: toSend.reduce((sum, row) => sum + Number(row.chars || 0), 0),
      savedChars: measuredSavedChars,
      savedCharsProvenance: measured(measuredSavedChars),
      // tokens/chars is an approximation; it is deliberately NOT computed here
      // so no caller can mistake a character saving for a token saving.
      savedTokens: null,
      savedTokensProvenance: "NOT_MEASURED",
    }
  }

  /** Record that a block was actually delivered to the advisor. */
  function markDelivered(key) {
    return observeSeenContext(scopeOf(), String(key), "", { now: Number(now()), ttlMs, maxEntries, pinned: true })
  }

  return {
    schemaVersion: SHARED_CONTEXT_LEDGER_SCHEMA_VERSION,
    policy: SHARED_CONTEXT_LEDGER_POLICY,
    get scope() {
      return scopeOf()
    },
    observe,
    planShare,
    markDelivered,
    /**
     * Advance the invalidation epoch. Call this after a workspace mutation (a
     * write lands) so no evidence from BEFORE the write can be reused: the next
     * observation for any key is NEW against an empty namespace.
     */
    bumpEpoch(reason = "mutation") {
      epoch += 1
      lastBumpReason = String(reason)
      return epoch
    },
    reset() {
      resetSeenContextLedger(scopeOf())
    },
    state() {
      return {
        schemaVersion: SHARED_CONTEXT_LEDGER_SCHEMA_VERSION,
        policy: SHARED_CONTEXT_LEDGER_POLICY,
        scope: scopeOf(),
        baseScope,
        epoch,
        lastBumpReason,
        observations,
        sentBlocks,
        skippedBlocks,
        savedChars: measured(measuredSavedChars),
        ledger: seenContextLedgerStats(scopeOf()),
      }
    },
  }
}
