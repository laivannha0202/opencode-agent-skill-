// V16.3 Phase A, steps 4 and 5: stale-element recovery and locator quality.
//
// A stale locator is the single most common browser failure and the easiest way
// to cause real damage: the click lands on whatever now occupies that position.
// So recovery is *identity-first*. The pipeline is fixed:
//
//   failure -> fresh semantic snapshot -> re-resolve -> compare identity -> 1 retry
//
// and it stops at any of these, which is where the value is:
//
//   - the fresh snapshot cannot establish target identity with confidence
//   - target semantics changed (name/role/accessible description drifted)
//   - the action carries an external side effect
//   - the fresh snapshot shows the state may already have been applied
//
// Locator ranking lives here too, so a recovery can never "recover" onto a worse
// selector than the one that just failed.

import { createHash } from "node:crypto"
import { BROWSER_ACTION_CLASS } from "./browser-action-taxonomy.mjs"

export const LOCATOR_STRATEGY = Object.freeze({
  ROLE_AND_NAME: "role-and-accessible-name",
  TEST_ID: "data-testid",
  STABLE_ID: "stable-id",
  SEMANTIC_SELECTOR: "stable-semantic-selector",
  BOUNDED_CSS: "bounded-css",
  LABEL_TEXT: "label-text",
})

// Ordered best -> worst. Index in this array IS the priority; the forbidden
// strategies are ranked below every bounded strategy so they can never win a
// comparison, and `chooseLocatorStrategy` refuses them outright.
export const LOCATOR_PRIORITY = Object.freeze([
  LOCATOR_STRATEGY.ROLE_AND_NAME,
  LOCATOR_STRATEGY.TEST_ID,
  LOCATOR_STRATEGY.LABEL_TEXT,
  LOCATOR_STRATEGY.STABLE_ID,
  LOCATOR_STRATEGY.SEMANTIC_SELECTOR,
  LOCATOR_STRATEGY.BOUNDED_CSS,
])

export const LOCATOR_FORBIDDEN = Object.freeze([
  "raw-coordinates",
  "magic-element-index",
  "nth-child",
  "volatile-generated-class",
])

const VOLATILE_CLASS =
  /^(?:css-[a-z0-9]{4,}|sc-[A-Za-z0-9]{5,}|emotion-[a-z0-9]{4,}|jsx-\d+|jss\d+|tw-[A-Za-z0-9]{6,})/i

const VOLATILE_HASH = /[0-9a-f]{8,}/i

// Volatility is checked per CLASS TOKEN, not only at the start of the whole
// selector. A generated class almost never leads a selector -- it is usually
// the second or third compound (`div.wrapper.css-1a2b3c4d5`) -- so anchoring on
// the selector head let exactly the selectors that matter through.
function hasVolatileClassToken(selector) {
  const tokens = String(selector || "").match(/\.[A-Za-z0-9_-]+/g) || []
  for (const token of tokens) {
    const name = token.slice(1)
    if (!name) continue
    if (VOLATILE_CLASS.test(name)) return true
    if (VOLATILE_HASH.test(name)) return true
  }
  return false
}

export const STALE_RECOVERY_REASON = Object.freeze({
  ALLOWED: "stale-recovery-allowed",
  NOT_STALE: "failure-is-not-stale-locator",
  EXTERNAL_SIDE_EFFECT: "external-side-effect-never-recovered",
  IDENTITY_LOW_CONFIDENCE: "target-identity-below-confidence-threshold",
  IDENTITY_CONTRADICTED: "target-identity-contradicted",
  SEMANTICS_CHANGED: "target-semantics-changed",
  STATE_MAY_HAVE_APPLIED: "snapshot-shows-state-may-have-applied",
  ALREADY_RECOVERED: "bounded-recovery-already-used",
  NO_SNAPSHOT: "no-fresh-snapshot-available",
})

export const DEFAULT_IDENTITY_CONFIDENCE = 0.75

export function normalizeLocatorStrategy(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-")
}

export function locatorStrategyRank(strategy) {
  const normalized = normalizeLocatorStrategy(strategy)
  const priority = /** @type {readonly string[]} */ (LOCATOR_PRIORITY)
  if (LOCATOR_FORBIDDEN.includes(normalized)) return Number.MAX_SAFE_INTEGER
  const index = priority.indexOf(normalized)
  return index === -1 ? priority.length : index
}

export function isForbiddenLocatorStrategy(strategy) {
  return LOCATOR_FORBIDDEN.includes(normalizeLocatorStrategy(strategy))
}

export function locatorQuality(input = {}) {
  const strategy = normalizeLocatorStrategy(input.strategy)
  if (LOCATOR_FORBIDDEN.includes(strategy)) {
    return { schemaVersion: 1, strategy, allowed: false, rank: locatorStrategyRank(strategy), reason: "forbidden-locator-strategy" }
  }
  const rank = locatorStrategyRank(strategy)
  const priority = /** @type {readonly string[]} */ (LOCATOR_PRIORITY)
  const css = String(input.selector || input.css || "")
  const volatile = strategy === LOCATOR_STRATEGY.BOUNDED_CSS && hasVolatileClassToken(css)
  if (rank >= priority.length || volatile) {
    return { schemaVersion: 1, strategy, allowed: false, rank, reason: volatile ? "volatile-generated-class" : "unsupported-locator-strategy" }
  }
  return { schemaVersion: 1, strategy, allowed: true, rank, reason: "allowed" }
}

// Highest-priority allowed candidate wins. Coordinates, indexes and volatile
// classes are dropped before ranking, so a caller cannot smuggle them in by
// listing them first. When nothing survives, the refusal reason is the most
// SPECIFIC one seen -- "volatile-generated-class" is actionable, and collapsing
// it into "no-allowed-locator-strategy" hides the actual defect.
export function chooseLocatorStrategy(candidates = []) {
  const evaluated = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const strategy = typeof candidate === "string"
      ? { strategy: candidate, selector: null }
      : candidate || {}
    return locatorQuality(strategy)
  })
  const rows = evaluated.filter((row) => row.allowed).sort((a, b) => a.rank - b.rank)
  if (rows.length) return { ...rows[0], reason: "locator-priority" }
  const specific = evaluated.find((row) => row.reason === "volatile-generated-class")
    || evaluated.find((row) => row.reason !== "forbidden-locator-strategy" && row.reason !== "unsupported-locator-strategy")
  if (specific) return { schemaVersion: 1, strategy: null, rank: null, allowed: false, reason: specific.reason }
  return { schemaVersion: 1, strategy: null, rank: null, allowed: false, reason: "no-allowed-locator-strategy" }
}

// A fingerprint over the *identity* of a target, never over its position. Two
// snapshots of the same logical control share a fingerprint even though their
// coordinates and element indexes differ, which is what makes identity
// comparison meaningful across a re-render.
export function locatorFingerprint(input = {}) {
  const source = input || {}
  const parts = [
    source.action || "",
    source.strategy || "",
    source.role || "",
    source.accessibleName || source.name || "",
    source.testId || "",
    source.id || "",
    source.stableSelector || "",
    source.text || "",
  ].map((part) => String(part || "").trim().replace(/\s+/g, " ").toLowerCase())
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24)
}

function describeTarget(target = {}) {
  return {
    role: String(target.role || "").trim().toLowerCase(),
    name: String(target.accessibleName || target.name || "").trim().replace(/\s+/g, " ").toLowerCase(),
    testId: String(target.testId || "").trim(),
    id: String(target.id || "").trim(),
  }
}

// Identity comparison returns both a verdict and *why*, because the reason is
// what the execution receipt records and what a human reads to decide whether
// the recovery was legitimate.
export function compareTargetIdentity(before = {}, after = {}, options = {}) {
  const threshold = Math.max(0, Math.min(1, Number(options.confidenceThreshold ?? DEFAULT_IDENTITY_CONFIDENCE)))
  const a = describeTarget(before)
  const b = describeTarget(after)

  if (!b.role && !b.name && !b.testId && !b.id) {
    return { schemaVersion: 1, match: false, confidence: 0, reason: "after-snapshot-has-no-target-identity" }
  }

  const signals = []
  const contradictions = []
  let weight = 0
  let score = 0

  if (a.role && b.role) {
    weight += 0.3
    if (a.role === b.role) score += 0.3
    else {
      signals.push("role-changed")
      contradictions.push("role-changed")
    }
  }
  if (a.name && b.name) {
    weight += 0.4
    if (a.name === b.name) score += 0.4
    else {
      signals.push("accessible-name-changed")
      contradictions.push("accessible-name-changed")
    }
  }
  if (a.testId && b.testId) {
    weight += 0.2
    if (a.testId === b.testId) score += 0.2
    else {
      signals.push("test-id-changed")
      contradictions.push("test-id-changed")
    }
  }
  if (a.id && b.id) {
    weight += 0.1
    if (a.id === b.id) score += 0.1
    else signals.push("id-changed")
  }

  // Only the identity signals that exist on BOTH sides are evidence. An identity
  // with nothing comparable has weight 0 and therefore zero confidence: absence
  // of evidence is not weak evidence of a match.
  if (weight <= 0) {
    return { schemaVersion: 1, match: false, confidence: 0, reason: "no-comparable-identity-signals", signals, contradictions }
  }
  const confidence = Number((score / weight).toFixed(3))
  // A weighted average is the wrong decision rule for identity. A control whose
  // accessible name still reads "Save order" while its test id now reads
  // "delete-everything" scores 0.78 and would clear a 0.75 bar -- and the click
  // would land on a different control than the one that failed. So any
  // contradiction on a high-trust signal is an outright veto: identity must not
  // merely score well, it must not contradict itself.
  if (contradictions.length) {
    return {
      schemaVersion: 1,
      match: false,
      confidence,
      threshold,
      reason: "identity-contradicted",
      signals,
      contradictions,
    }
  }
  return {
    schemaVersion: 1,
    match: confidence >= threshold,
    confidence,
    threshold,
    reason: confidence >= threshold ? "identity-confirmed" : "identity-below-threshold",
    signals,
    contradictions,
  }
}

export function staleRecoveryDecision(input = {}) {
  const taxonomy = input.taxonomy || {}
  const actionClass = taxonomy.actionClass || BROWSER_ACTION_CLASS.INTERACTIVE
  const snapshot = input.freshSnapshot || null
  const identity = compareTargetIdentity(
    input.before || {},
    input.after || {},
    { confidenceThreshold: input.confidenceThreshold },
  )
  const confidence = identity.confidence

  const base = {
    schemaVersion: 1,
    recover: false,
    reason: "",
    steps: [],
    confidence,
    maxAttempts: 1,
    staleRecovered: false,
    // Present on EVERY return shape, not just the allow path. A caller that
    // reads `decision.locator` after a refusal must get `null`, never
    // `undefined` that happens to be truthy-checked away.
    locator: null,
    identity,
  }

  if (input.failureKind !== "stale-locator" && input.stale !== true) {
    return { ...base, reason: STALE_RECOVERY_REASON.NOT_STALE }
  }
  if (actionClass === BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT) {
    return { ...base, reason: STALE_RECOVERY_REASON.EXTERNAL_SIDE_EFFECT }
  }
  if (Number(input.staleRecoveryAttempts || 0) >= 1) {
    return { ...base, reason: STALE_RECOVERY_REASON.ALREADY_RECOVERED }
  }
  if (input.stateMayHaveApplied === true) {
    return { ...base, reason: STALE_RECOVERY_REASON.STATE_MAY_HAVE_APPLIED }
  }
  if (!snapshot) {
    return { ...base, reason: STALE_RECOVERY_REASON.NO_SNAPSHOT }
  }
  if (identity.signals.some((signal) => signal === "accessible-name-changed" || signal === "role-changed")) {
    return { ...base, reason: STALE_RECOVERY_REASON.SEMANTICS_CHANGED }
  }
  if (!identity.match) {
    return {
      ...base,
      reason: identity.contradictions?.length
        ? "target-identity-contradicted"
        : "target-identity-below-confidence-threshold",
    }
  }

  const locator = chooseLocatorStrategy(input.locatorCandidates || [])
  if (!locator.allowed) {
    return { ...base, reason: locator.reason, locator }
  }

  return {
    ...base,
    recover: true,
    reason: STALE_RECOVERY_REASON.ALLOWED,
    locator,
    identity,
    steps: [
      "fresh-semantic-snapshot",
      "re-resolve-locator",
      "compare-target-identity",
      "single-bounded-retry",
    ],
  }
}