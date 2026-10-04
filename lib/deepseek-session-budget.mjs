// V16.6 DeepSeek session intelligence - budget (part 1 of 4).
//
// Separates two things V16.5 conflated:
//
//   * the persistent browser/profile session (the automation surface, expensive
//     to start, safe to reuse, rotated on a bounded budget)
//   * the conversation session (the reasoning thread for ONE task, cheap to
//     start, must stay coherent, ended with the task)
//
// This module owns the budgets, rotation rules, context-window detection and
// session telemetry. It performs no I/O: the pool (lib/deepseek-session-pool.mjs)
// owns lifecycle, the resume capsule owns handoff.
//
// Bounds are conservative and never widened from task text.

import { PROVENANCE, derived, measured, NOT_MEASURED, estimateTokensFromChars } from "./measurement-provenance.mjs"

export const DEEPSEEK_SESSION_BUDGET_SCHEMA_VERSION = 1
export const DEEPSEEK_SESSION_POLICY = "deepseek-session-budget-v16-6"

// Conservative fallback when nothing can be detected. Labeled ESTIMATED
// everywhere it surfaces - this is a guess, never a measurement.
export const CONSERVATIVE_CONTEXT_TOKENS = 32_768
export const MIN_CONTEXT_TOKENS = 4_096
export const MAX_CONTEXT_TOKENS = 262_144

const SESSION_BUDGET = Object.freeze({
  maxTurnsBeforeRotation: 6,
  maxSessionChars: 160_000,
  maxSessionErrors: 3,
  idleExpireMs: 30 * 60 * 1000,
  maxConcurrentSessions: 2,
  hardMaxConcurrentSessions: 3,
  maxCacheEntriesPerTask: 64,
})

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function num(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Resolve the session budget from environment with hard ceilings.
 * An over-generous env value is clamped, never honored.
 */
export function resolveSessionBudget(env = process.env) {
  const raw = env || {}
  const maxTurnsBeforeRotation = int(raw.UES_DEEPSEEK_SESSION_MAX_TURNS, SESSION_BUDGET.maxTurnsBeforeRotation, 1, 8)
  const maxSessionChars = int(raw.UES_DEEPSEEK_SESSION_MAX_CHARS, SESSION_BUDGET.maxSessionChars, 8_000, 400_000)
  const maxSessionErrors = int(raw.UES_DEEPSEEK_SESSION_MAX_ERRORS, SESSION_BUDGET.maxSessionErrors, 1, 5)
  const idleExpireMs = int(raw.UES_DEEPSEEK_SESSION_IDLE_MS, SESSION_BUDGET.idleExpireMs, 60_000, 4 * 60 * 60 * 1000)
  const maxConcurrentSessions = Math.min(
    SESSION_BUDGET.hardMaxConcurrentSessions,
    int(raw.UES_DEEPSEEK_SESSION_MAX_CONCURRENT, SESSION_BUDGET.maxConcurrentSessions, 1, SESSION_BUDGET.hardMaxConcurrentSessions),
  )
  return {
    schemaVersion: DEEPSEEK_SESSION_BUDGET_SCHEMA_VERSION,
    policy: DEEPSEEK_SESSION_POLICY,
    maxTurnsBeforeRotation,
    maxSessionChars,
    maxSessionErrors,
    idleExpireMs,
    maxConcurrentSessions,
    hardMaxConcurrentSessions: SESSION_BUDGET.hardMaxConcurrentSessions,
    clamped: {
      turns: maxTurnsBeforeRotation !== Number(raw.UES_DEEPSEEK_SESSION_MAX_TURNS),
      chars: maxSessionChars !== Number(raw.UES_DEEPSEEK_SESSION_MAX_CHARS),
      concurrent: maxConcurrentSessions !== Number(raw.UES_DEEPSEEK_SESSION_MAX_CONCURRENT),
    },
  }
}

/**
 * Context-window detection: DETECTED -> OVERRIDE -> CONSERVATIVE-FALLBACK.
 *
 * `UES_DEEPSEEK_CONTEXT_TOKENS` accepts a number, `auto` (the default), or
 * `0`/`off` (force fallback). Nothing in this repo may hard-code 64K as if it
 * were known: the fallback is a conservative number that is always labeled
 * ESTIMATED.
 */
export function resolveContextWindowTokens(env = process.env, detected = null) {
  const raw = String(env?.UES_DEEPSEEK_CONTEXT_TOKENS ?? "auto").trim().toLowerCase()
  const detectedTokens = int(detected, 0, 0, MAX_CONTEXT_TOKENS)

  if (raw === "auto" || raw === "") {
    if (detectedTokens > 0) {
      const tokens = Math.max(MIN_CONTEXT_TOKENS, Math.min(MAX_CONTEXT_TOKENS, detectedTokens))
      return {
        source: "detected",
        provenance: PROVENANCE.MEASURED,
        tokens,
        normalized: true,
        raw,
        fallbackUsed: false,
      }
    }
    return {
      source: "conservative-fallback",
      provenance: PROVENANCE.ESTIMATED,
      tokens: CONSERVATIVE_CONTEXT_TOKENS,
      normalized: true,
      raw,
      fallbackUsed: true,
    }
  }

  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed > 0) {
    const tokens = Math.max(MIN_CONTEXT_TOKENS, Math.min(MAX_CONTEXT_TOKENS, Math.trunc(parsed)))
    return {
      source: "override",
      provenance: PROVENANCE.DERIVED,
      tokens,
      normalized: tokens === Math.trunc(parsed),
      raw,
      fallbackUsed: false,
    }
  }

  return {
    source: "conservative-fallback",
    provenance: PROVENANCE.ESTIMATED,
    tokens: CONSERVATIVE_CONTEXT_TOKENS,
    normalized: false,
    raw,
    fallbackUsed: true,
  }
}

/** A conversation thread for one task. Deterministic id by default. */
export function createConversationSession(input = {}) {
  const budget = input.budget || resolveSessionBudget(input.env)
  const id = String(input.id || `sess_${String(input.taskFingerprint || "task").slice(0, 12)}`)
  return {
    schemaVersion: DEEPSEEK_SESSION_BUDGET_SCHEMA_VERSION,
    policy: DEEPSEEK_SESSION_POLICY,
    id,
    taskFingerprint: String(input.taskFingerprint || ""),
    role: String(input.role || ""),
    phase: String(input.phase || ""),
    reasoningMode: String(input.reasoningMode || "balanced"),
    turnBudget: int(input.turnBudget, 0, 0, 8),
    turnsUsed: 0,
    inputChars: 0,
    outputChars: 0,
    errorCount: 0,
    rotations: 0,
    lastActiveAt: null,
    contextWindow: input.contextWindow || resolveContextWindowTokens(input.env, input.detectedContextTokens),
    budget,
    status: "open",
    closedReason: null,
    evidenceRefs: [],
    deltaCursor: 0,
  }
}

/**
 * Rotation decision for the persistent browser session.
 * Reasons are explicit so telemetry can explain WHY a new session started.
 */
export function shouldRotateSession(session, now = Date.now(), extra = {}) {
  const row = session || {}
  const budget = row.budget || resolveSessionBudget({})
  const reasons = []
  if (row.status === "closed") reasons.push("already-closed")
  if (Number(row.turnsUsed) >= budget.maxTurnsBeforeRotation) reasons.push("turn-budget-exhausted")
  if (Number(row.inputChars) + Number(row.outputChars) >= budget.maxSessionChars) reasons.push("session-size-exhausted")
  if (Number(row.errorCount) >= budget.maxSessionErrors) reasons.push("error-budget-exhausted")
  if (Number(extra.errors) >= budget.maxSessionErrors) reasons.push("error-budget-exhausted")
  const lastActive = Number(row.lastActiveAt || 0)
  if (lastActive > 0 && now - lastActive >= budget.idleExpireMs) reasons.push("idle-expired")
  if (extra.contextPressure === true) reasons.push("context-pressure")
  return {
    rotate: reasons.length > 0,
    reasons,
    budget: {
      maxTurnsBeforeRotation: budget.maxTurnsBeforeRotation,
      maxSessionChars: budget.maxSessionChars,
      maxSessionErrors: budget.maxSessionErrors,
      idleExpireMs: budget.idleExpireMs,
    },
    measured: {
      turnsUsed: measured(int(row.turnsUsed, 0, 0, 999)),
      sessionChars: measured(int(Number(row.inputChars || 0) + Number(row.outputChars || 0), 0, 0, 10_000_000)),
      errorCount: measured(int(row.errorCount, 0, 0, 99)),
    },
  }
}

/** Record one completed conversation turn against the session. */
export function recordSessionTurn(session, turn = {}) {
  const row = session
  if (!row || row.status !== "open") return session
  row.turnsUsed = int(row.turnsUsed, 0, 0, 999) + 1
  row.inputChars = int(row.inputChars, 0, 0, 10_000_000) + int(turn.inputChars, 0, 0, 5_000_000)
  row.outputChars = int(row.outputChars, 0, 0, 10_000_000) + int(turn.outputChars, 0, 0, 5_000_000)
  if (turn.error) row.errorCount = int(row.errorCount, 0, 0, 99) + 1
  row.lastActiveAt = Number.isFinite(turn.now) ? turn.now : Date.now()
  if (Array.isArray(turn.evidenceRefs)) {
    for (const ref of turn.evidenceRefs) {
      if (ref && !row.evidenceRefs.includes(ref)) row.evidenceRefs.push(ref)
    }
    if (row.evidenceRefs.length > 64) row.evidenceRefs = row.evidenceRefs.slice(-64)
  }
  return row
}

/** Close a conversation session with an explicit reason. */
export function closeConversationSession(session, reason = "task-complete") {
  const row = session
  if (!row) return row
  row.status = "closed"
  row.closedReason = String(reason || "task-complete")
  return row
}

/**
 * Session telemetry. Only MEASURED / DERIVED values; anything we cannot
 * observe is explicitly NOT_MEASURED instead of guessed.
 */
export function sessionTelemetry(session, options = {}) {
  const row = session || {}
  const inputChars = int(row.inputChars, 0, 0, 10_000_000)
  const outputChars = int(row.outputChars, 0, 0, 10_000_000)
  const turns = int(row.turnsUsed, 0, 0, 999)
  const tokens = row.contextWindow?.tokens || CONSERVATIVE_CONTEXT_TOKENS
  const uniqueEvidence = Array.isArray(row.evidenceRefs) ? row.evidenceRefs.length : 0
  return {
    policy: DEEPSEEK_SESSION_POLICY,
    sessionId: row.id || null,
    status: row.status || "unknown",
    closedReason: row.closedReason || null,
    turns: measured(turns),
    inputChars: measured(inputChars),
    outputChars: measured(outputChars),
    // Token counts are ESTIMATED from measured chars, returned directly so the
    // `.value` is a number and the ESTIMATED label is not shadowed by a
    // wrapping DERIVED one.
    inputTokens: estimateTokensFromChars(inputChars),
    outputTokens: estimateTokensFromChars(outputChars),
    errorCount: measured(int(row.errorCount, 0, 0, 99)),
    rotations: measured(int(row.rotations, 0, 0, 99)),
    uniqueEvidenceRefs: measured(uniqueEvidence),
    duplicatesAvoided: derived(Math.max(0, Number(options.duplicatesAvoided) || 0)),
    cacheHits: measured(int(options.cacheHits, 0, 0, 99_999)),
    cacheMisses: measured(int(options.cacheMisses, 0, 0, 99_999)),
    contextWindowTokens: row.contextWindow
      ? { value: tokens, provenance: row.contextWindow.provenance, source: row.contextWindow.source }
      : NOT_MEASURED,
    latencyMs: options.latencyMs === undefined ? NOT_MEASURED : measured(Number(options.latencyMs)),
    tokensSaved: NOT_MEASURED,
    provenance: {
      policy: DEEPSEEK_SESSION_POLICY,
      measuredAt: null,
      note: "chars->tokens conversions are estimates; token/latency savings are never inferred",
    },
  }
}

/** LRU pruning for in-memory session records. Never grows past the budget. */
export function pruneSessions(sessions, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const maxEntries = int(options.maxEntries, 8, 1, 32)
  const list = Array.isArray(sessions) ? sessions : []
  const keep = []
  const evicted = []
  const sorted = [...list].sort((a, b) => Number(b.lastActiveAt || 0) - Number(a.lastActiveAt || 0))
  for (const row of sorted) {
    const idle = Number(row.lastActiveAt || 0) > 0 && now - Number(row.lastActiveAt) >= (row.budget?.idleExpireMs ?? SESSION_BUDGET.idleExpireMs)
    const closedExpired = row.status === "closed" && now - Number(row.lastActiveAt || 0) >= 5 * 60 * 1000
    if (idle || closedExpired) {
      evicted.push({ id: row.id, reason: idle ? "idle-expired" : "closed-expired" })
      continue
    }
    if (keep.length >= maxEntries) {
      evicted.push({ id: row.id, reason: "capacity" })
      continue
    }
    keep.push(row)
  }
  return { sessions: keep, evicted }
}

export const DEEPSEEK_SESSION_BUDGET_EXPORTS = Object.freeze([
  "resolveSessionBudget",
  "resolveContextWindowTokens",
  "createConversationSession",
  "shouldRotateSession",
  "recordSessionTurn",
  "closeConversationSession",
  "sessionTelemetry",
  "pruneSessions",
])
