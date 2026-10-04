// V16.6 canonical DeepSeek reasoning policy.
//
// ONE module owns two things that V16.5 scattered across the adapter, the lane
// and the role tables:
//
//   1. `UES_REASONING_MODE` semantics (economy | balanced | deepseek-first)
//   2. the per-task DeepSeek TURN BUDGET that replaces V16.5's
//      `maxConsultations = 1` rule
//
// Turn budgeting rules (V16.6 §5):
//   - easy task        -> 0 turns. Trivial work never opens a provider.
//   - normal task      -> bounded, ~2
//   - hard task        -> bounded, ~4
//   - very hard task   -> cap (policy ceiling 6, never unlimited)
//   - no infinite loop: turns are counted, ceiling-checked and clamped
//
// Safety clamps are inherited from V16.3 and MUST NOT be relaxed here:
//   lib/web-reasoning-lane.mjs bounds maxConsultations to 3 and
//   maxFollowUps to 2 (hard max). The policy ceiling is therefore a
//   never-exceeded upper bound; `effectiveMaxTurns` reports what the lane will
//   actually allow after those safety clamps (5 for a very hard task).
//
// This module is also the ONLY place that converts a reasoning mode into turn
// counts, so the adapter, the lane and the controller cannot drift apart.

import { PROVENANCE, derived, measured } from "./measurement-provenance.mjs"

export const DEEPSEEK_REASONING_SCHEMA_VERSION = 1

/** Frozen mode vocabulary. Invalid input never maps to `off`. */
export const REASONING_MODE = Object.freeze({
  ECONOMY: "economy",
  BALANCED: "balanced",
  DEEPSEEK_FIRST: "deepseek-first",
})

export const REASONING_MODES = Object.freeze(Object.values(REASONING_MODE))

/** Frozen task complexity vocabulary. */
export const COMPLEXITY = Object.freeze({
  EASY: "easy",
  NORMAL: "normal",
  HARD: "hard",
  VERY_HARD: "very-hard",
})

export const COMPLEXITIES = Object.freeze(Object.values(COMPLEXITY))

/** Participation describes HOW MUCH of the run the reasoning thread may touch. */
export const PARTICIPATION = Object.freeze({
  NONE: "none",
  ON_DEMAND: "on-demand",
  PHASE_GATED: "phase-gated",
  PHASE_GATED_EARLY: "phase-gated-early",
})

// The V16.3 safety bounds owned by lib/web-reasoning-lane.mjs. V16.6 must
// never exceed them (relaxing them would weaken a correctness limit).
export const LANE_SAFETY_BOUNDS = Object.freeze({
  maxConsultations: 3,
  maxFollowUps: 2,
})

export const TURN_POLICY_CEILING = 6

// The ONLY turn table. Keys are `reasoningMode -> complexity`.
// Values are total turns for one task (a turn = one consultation OR one
// bounded delta follow-up).
/** @type {Readonly<Record<string, Readonly<Record<string, number>>>>} */
const TURN_POLICY_TABLE = Object.freeze({
  [REASONING_MODE.ECONOMY]: Object.freeze({
    [COMPLEXITY.EASY]: 0,
    [COMPLEXITY.NORMAL]: 0,
    [COMPLEXITY.HARD]: 2,
    [COMPLEXITY.VERY_HARD]: 3,
  }),
  [REASONING_MODE.BALANCED]: Object.freeze({
    [COMPLEXITY.EASY]: 0,
    [COMPLEXITY.NORMAL]: 2,
    [COMPLEXITY.HARD]: 4,
    [COMPLEXITY.VERY_HARD]: 6,
  }),
  [REASONING_MODE.DEEPSEEK_FIRST]: Object.freeze({
    [COMPLEXITY.EASY]: 0,
    [COMPLEXITY.NORMAL]: 3,
    [COMPLEXITY.HARD]: 4,
    [COMPLEXITY.VERY_HARD]: 6,
  }),
})

/** @type {Readonly<Record<string, string>>} */
const PARTICIPATION_TABLE = Object.freeze({
  [REASONING_MODE.ECONOMY]: PARTICIPATION.ON_DEMAND,
  [REASONING_MODE.BALANCED]: PARTICIPATION.PHASE_GATED,
  [REASONING_MODE.DEEPSEEK_FIRST]: PARTICIPATION.PHASE_GATED_EARLY,
})

// Accepted aliases. The mode is lower-cased and underscored before matching so
// `deepseek_first`, `DeepSeek-First` and `deepseekfirst` all normalize.
/** @type {Readonly<Record<string, string>>} */
const MODE_ALIASES = Object.freeze({
  economy: REASONING_MODE.ECONOMY,
  "economy-mode": REASONING_MODE.ECONOMY,
  balanced: REASONING_MODE.BALANCED,
  "deepseek-first": REASONING_MODE.DEEPSEEK_FIRST,
  deepseek_first: REASONING_MODE.DEEPSEEK_FIRST,
  deepseekfirst: REASONING_MODE.DEEPSEEK_FIRST,
  "deepseek": REASONING_MODE.DEEPSEEK_FIRST,
})

function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Resolve `UES_REASONING_MODE`.
 *
 * Contract:
 *   - missing          -> balanced (the documented default)
 *   - known alias      -> the canonical mode
 *   - invalid value    -> balanced, with `normalized:false` and the raw value
 *     recorded. It NEVER silently becomes `off`: turning external reasoning off
 *     is exclusively `UES_WEB_REASONING_MODE=off` (escalation component).
 */
export function resolveReasoningMode(env = process.env) {
  const raw = String(env?.UES_REASONING_MODE ?? "").trim()
  if (!raw) {
    return {
      schemaVersion: DEEPSEEK_REASONING_SCHEMA_VERSION,
      mode: REASONING_MODE.BALANCED,
      source: "default",
      raw: "",
      normalized: true,
      invalidValue: null,
    }
  }
  const key = raw.toLowerCase().replace(/\s+/g, "-")
  const mode = MODE_ALIASES[key] || MODE_ALIASES[raw.toLowerCase()]
  if (mode) {
    return {
      schemaVersion: DEEPSEEK_REASONING_SCHEMA_VERSION,
      mode,
      source: "env:UES_REASONING_MODE",
      raw,
      normalized: true,
      invalidValue: null,
    }
  }
  return {
    schemaVersion: DEEPSEEK_REASONING_SCHEMA_VERSION,
    mode: REASONING_MODE.BALANCED,
    source: "env:UES_REASONING_MODE",
    raw,
    normalized: false,
    invalidValue: raw,
  }
}

/**
 * Normalize an externally supplied complexity label. Unknown labels are
 * reported as `unknown` so the caller can fall back to a derived classification
 * instead of silently treating the task as easy.
 */
export function normalizeComplexity(value) {
  const key = String(value || "").trim().toLowerCase().replace(/_/g, "-")
  if (COMPLEXITIES.includes(key)) return key
  if (key === "very-hard" || key === "veryhard") return COMPLEXITY.VERY_HARD
  if (key === "moderate" || key === "medium") return COMPLEXITY.NORMAL
  if (key === "trivial" || key === "simple") return COMPLEXITY.EASY
  return "unknown"
}

function splitTurns(maxTurns) {
  // Consultations and follow-ups are distributed so that a turn budget always
  // degrades into lane-legal counts. Follow-ups stay within the V16.3 hard max
  // of 2 and consultations within the lane's bound of 3.
  const consultations = clampInt(Math.ceil(maxTurns / 2), 0, 0, LANE_SAFETY_BOUNDS.maxConsultations)
  const followUps = clampInt(maxTurns - consultations, 0, 0, LANE_SAFETY_BOUNDS.maxFollowUps)
  return { consultations, followUps }
}

/**
 * Compute the canonical DeepSeek turn budget for one task.
 *
 * @param {object} input
 * @param {string} input.complexity         easy|normal|hard|very-hard (or alias)
 * @param {string} input.reasoningMode      economy|balanced|deepseek-first
 * @param {string} [input.webReasoningMode] off|auto|force (escalation component)
 * @param {string} [input.advisoryWeight]   consult|avoid|neutral (learner, optional)
 * @param {number} [input.learnerSamples]   samples behind advisoryWeight
 * @param {string} [input.complexityBasis]  runtime-evidence|repository-structure|verifier-evidence|task-text
 * @param {string[]} [input.reasons]
 */
export function resolveDeepSeekTurnBudget(input = {}) {
  const reasoningMode = REASONING_MODES.includes(String(input.reasoningMode || ""))
    ? String(input.reasoningMode)
    : REASONING_MODE.BALANCED
  const rawComplexity = normalizeComplexity(input.complexity)
  const complexity = rawComplexity === "unknown" ? COMPLEXITY.NORMAL : rawComplexity
  const webMode = ["off", "auto", "force"].includes(String(input.webReasoningMode || ""))
    ? String(input.webReasoningMode)
    : "auto"
  const reasons = [...(input.reasons || [])].map(String).slice(0, 12)
  const table = TURN_POLICY_TABLE[reasoningMode] || TURN_POLICY_TABLE[REASONING_MODE.BALANCED]

  let maxTurns = table[complexity]
  if (!Number.isFinite(maxTurns)) maxTurns = TURN_POLICY_TABLE[REASONING_MODE.BALANCED][COMPLEXITY.NORMAL]

  let budgetProvenance = PROVENANCE.DERIVED
  if (maxTurns === 0) reasons.push(`turn-budget:${reasoningMode}/${complexity}=0`)

  // Escalation component wins on the negative side: off disables everything.
  if (webMode === "off") {
    maxTurns = 0
    reasons.push("web-reasoning-mode=off")
    budgetProvenance = PROVENANCE.DERIVED
  }

  // FORCE is an explicit user instruction configured by the same operator who
  // owns UES_WEB_REASONING_MODE. It raises a floor of one turn; it does not
  // bypass the ceiling.
  if (webMode === "force" && maxTurns < 1 && webMode !== "off") {
    maxTurns = 1
    reasons.push("web-reasoning-mode=force floor=1")
  }

  // Advisor benefit learner (V16.6 §14). Observational only: it moves the turn
  // count by at most one, needs the learner's minimum sample size, and can
  // never turn external reasoning on for an easy task or push past the ceiling.
  const weight = String(input.advisoryWeight || "neutral")
  const learnerSamples = clampInt(input.learnerSamples, 0, 0, 10_000)
  const learnerActive = weight === "consult" || weight === "avoid"
  if (learnerActive && learnerSamples >= 8 && complexity !== COMPLEXITY.EASY && webMode !== "off") {
    const delta = weight === "consult" ? 1 : -1
    const next = clampInt(maxTurns + delta, 0, 0, TURN_POLICY_CEILING)
    if (next !== maxTurns) {
      reasons.push(`advisory-learner:${weight}:${maxTurns}->${next}`)
      maxTurns = next
    }
  }

  // Policy ceiling: never unlimited, never above the frozen cap.
  const uncapped = maxTurns
  maxTurns = clampInt(maxTurns, 0, 0, TURN_POLICY_CEILING)
  if (uncapped > TURN_POLICY_CEILING) reasons.push(`ceiling-clamped:${uncapped}->${TURN_POLICY_CEILING}`)

  const { consultations, followUps } = splitTurns(maxTurns)
  const effectiveMaxTurns = consultations + followUps
  const clampedByLaneSafety = effectiveMaxTurns < maxTurns
  if (clampedByLaneSafety) {
    reasons.push(`lane-safety-clamped:${maxTurns}->${effectiveMaxTurns}`)
  }

  return {
    schemaVersion: DEEPSEEK_REASONING_SCHEMA_VERSION,
    policy: "deepseek-turn-budget-v16-6",
    mode: reasoningMode,
    participation: PARTICIPATION_TABLE[reasoningMode] || PARTICIPATION.PHASE_GATED,
    complexity,
    complexityLabelKnown: rawComplexity !== "unknown",
    complexityBasis: String(input.complexityBasis || "task-text"),
    webReasoningMode: webMode,
    maxTurns,
    effectiveMaxTurns,
    maxConsultations: consultations,
    maxFollowUps: followUps,
    policyCeiling: TURN_POLICY_CEILING,
    clampedByLaneSafety,
    reasons,
    measurements: {
      policyMaxTurns: derived(maxTurns),
      effectiveMaxTurns: derived(effectiveMaxTurns),
      learnerSamples: measured(learnerSamples),
    },
    provenance: budgetProvenance,
  }
}

/**
 * Conservative split helper used when only a policy ceiling is known (for
 * example when hydrating a lane before the task complexity is classified).
 */
export function laneLimitsForTurns(maxTurns) {
  const turns = clampInt(maxTurns, 0, 0, TURN_POLICY_CEILING)
  const { consultations, followUps } = splitTurns(turns)
  return { maxConsultations: consultations, maxFollowUps: followUps, effectiveMaxTurns: consultations + followUps }
}

export function turnBudgetFingerprint(budget) {
  const row = budget || {}
  return [
    row.schemaVersion,
    row.mode,
    row.complexity,
    row.webReasoningMode,
    row.maxTurns,
    row.effectiveMaxTurns,
    row.maxConsultations,
    row.maxFollowUps,
  ].join("|")
}

export const turnBudgetProvenance = derived
