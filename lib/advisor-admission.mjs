// V16.9 adaptive admission.
//
// WHY THIS MODULE EXISTS
//
// V16.7/V16.8 decide escalation ONCE, before the advisor is called, and never
// revisit it. Two consequences:
//
//   1. A task that Pi can prove locally still pays for a consultation when the
//      static signal list happens to fire (a false positive that costs a
//      browser session, latency and tokens).
//   2. After the LOCAL VERIFIER rejects the advisor's advice, the lane simply
//      gives up. The verifier just produced the single strongest signal in the
//      system - "the advice was wrong" - and nothing consumes it.
//
// Adaptive admission is the owner of the ADMISSION decision across the whole
// lifecycle. It does NOT replace the escalation router: it CALLS
// `decideWebEscalation()` for the base signal decision and composes two proven
// primitives that already exist and must not be re-implemented:
//
//   * `lib/followup-budget.mjs`  - may a second follow-up be sent?
//   * `lib/advisor-benefit-learner.mjs` - is consulting historically worth it?
//
// It adds ONLY what does not exist yet:
//
//   * a closed ROUTE vocabulary (LOCAL_DETERMINISTIC / PI_ONLY /
//     PI_PLUS_ADVISOR / ADVISOR_RETRY) so the controller has one decision;
//   * a deterministic FEATURE EXTRACTOR over measured/declared inputs (never
//     prose) that scores how much an external opinion is expected to help;
//   * RE-SCORING after verifier feedback, which can de-escalate (drop the
//     advisor) or request ONE bounded retry.
//
// It NEVER grants the advisor authority. It cannot make the verifier pass, it
// cannot disable a security gate, and every route it returns still passes
// through the Decision Barrier and the Pre-write Fence.

import { WEB_ESCALATION_MODE, decideWebEscalation } from "./web-reasoning-escalation.mjs"
import { advisorWeight, ADVISOR_WEIGHT } from "./advisor-benefit-learner.mjs"
import { FOLLOW_UP_BUDGET, maySendSecondFollowUp } from "./followup-budget.mjs"

export const ADVISOR_ADMISSION_SCHEMA_VERSION = 1
export const ADVISOR_ADMISSION_POLICY = "advisor-admission-v16-9"

/** The single closed route vocabulary the controller acts on. */
export const ADMISSION_ROUTE = Object.freeze({
  LOCAL_DETERMINISTIC: "local-deterministic",
  PI_ONLY: "pi-only",
  PI_PLUS_ADVISOR: "pi-plus-advisor",
  ADVISOR_RETRY: "advisor-retry",
})

/** Reasons are closed literals: no task text or provider prose leaks through. */
export const ADMISSION_REASON = Object.freeze({
  DETERMINISTIC_PROOF: "deterministic-local-proof",
  MODE_OFF: "advisor-disabled",
  NO_SIGNAL: "no-escalation-signal",
  NEGATIVE_BENEFIT: "historically-not-beneficial",
  SIGNAL_PRESENT: "escalation-signal-present",
  BENEFIT_WEIGHT: "historically-beneficial",
  VERIFIER_REJECTED: "verifier-rejected-advice",
  VERIFIER_ACCEPTED: "verifier-accepted-advice",
  RETRY_BUDGET_AVAILABLE: "retry-budget-available",
  RETRY_BUDGET_EXHAUSTED: "retry-budget-exhausted",
  DEESCALATED_BY_VERIFIER: "deescalated-by-verifier-feedback",
})

// Cost/benefit thresholds. They are deliberately coarse integers so the score
// is auditable by hand and never depends on floating-point edge cases.
const FEATURE_WEIGHTS = Object.freeze({
  subsystems: 3,
  ambiguity: 4,
  failedAttempts: 2,
  plausibleFixes: 2,
  retrievalConfidenceLow: 3,
  crossLayer: 3,
  architectureDecision: 4,
  verifierRepeatedFailure: 4,
})

const ADMISSION_THRESHOLD = 6
const DEESCALATION_THRESHOLD = -4

function boundedCount(value, max = 16) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return Math.min(max, Math.trunc(parsed))
}

/**
 * Extract a deterministic feature vector from MEASURED/DECLARED inputs only.
 * Prose is never parsed here: the escalation router already owns text signals.
 *
 * The canonical field names match `scoreStructuralEvidence()` in
 * `web-reasoning-structural.mjs` (`affectedSubsystems`, `verifierRetries`, ...)
 * so a caller can pass ONE input object to both. The shorter aliases are
 * accepted for readability at the call site.
 */
export function extractAdmissionFeatures(input = {}) {
  const metrics = input.metrics || {}
  const features = {
    subsystems: boundedCount(input.affectedSubsystems ?? input.subsystems ?? metrics.affectedSubsystems, 16),
    ambiguity: boundedCount(input.ambiguity ?? metrics.ambiguity, 8),
    failedAttempts: boundedCount(input.verifierRetries ?? input.failedAttempts ?? metrics.failedAttempts, 8),
    plausibleFixes: boundedCount(input.multipleCandidateFixes ?? input.plausibleFixes ?? metrics.plausibleFixes, 8),
    retrievalConfidenceLow: input.retrievalConfidenceLow === true
      || (Number.isFinite(Number(input.retrievalConfidence)) && Number(input.retrievalConfidence) < 0.4)
      || metrics.retrievalConfidenceLow === true,
    crossLayer: input.crossLayer === true || input.crossLayerDependency === true || metrics.crossLayer === true,
    architectureDecision: input.architectureDecision === true || input.architecturalDecisionRequired === true || metrics.architectureDecision === true,
    verifierRepeatedFailure: input.verifierRepeatedFailure === true || Number(input.verifierRetries || 0) >= 2 || metrics.verifierRepeatedFailure === true,
  }
  let score = 0
  if (features.subsystems >= 2) score += FEATURE_WEIGHTS.subsystems * (features.subsystems - 1)
  score += FEATURE_WEIGHTS.ambiguity * features.ambiguity
  score += FEATURE_WEIGHTS.failedAttempts * features.failedAttempts
  if (features.plausibleFixes >= 2) score += FEATURE_WEIGHTS.plausibleFixes * (features.plausibleFixes - 1)
  if (features.retrievalConfidenceLow) score += FEATURE_WEIGHTS.retrievalConfidenceLow
  if (features.crossLayer) score += FEATURE_WEIGHTS.crossLayer
  if (features.architectureDecision) score += FEATURE_WEIGHTS.architectureDecision
  if (features.verifierRepeatedFailure) score += FEATURE_WEIGHTS.verifierRepeatedFailure
  return { features, score }
}

/**
 * Decide admission for one task. Deterministic and synchronous.
 *
 * @param {object} input  same shape the escalation router accepts, plus:
 *   @param {object} [input.verifierFeedback] { rejected, accepted, repeatedFailure }
 *   @param {object} [input.followUpState]    { followUpsSent }
 *   @param {object} [input.learnerSample]    key for the benefit learner
 */
export function decideAdmission(input = {}) {
  const mode = String(input.mode || WEB_ESCALATION_MODE.AUTO)

  // 1. A deterministic local proof always wins. Nothing external is admitted.
  if (input.deterministicProven === true && mode !== WEB_ESCALATION_MODE.FORCE) {
    return admit(ADMISSION_ROUTE.LOCAL_DETERMINISTIC, ADMISSION_REASON.DETERMINISTIC_PROOF, {
      mode,
      score: 0,
      features: null,
    })
  }

  // 2. The escalation router owns the base signal decision.
  const escalation = decideWebEscalation({ ...input, mode })
  const { features, score } = extractAdmissionFeatures(input)

  // 3. Historical benefit is a NUDGE, never an override of an explicit signal.
  const weight = input.learnerSample ? advisorWeight(input.learnerSample) : { weight: ADVISOR_WEIGHT.NEUTRAL, reason: "no-sample" }

  if (!escalation.escalate) {
    return admit(ADMISSION_ROUTE.PI_ONLY, escalation.reason === "web-reasoning-disabled" ? ADMISSION_REASON.MODE_OFF : ADMISSION_REASON.NO_SIGNAL, {
      mode,
      score,
      features,
      escalation,
      weight,
    })
  }

  // 4. Escalation fired. A negative historical weight DE-ESCALATES an AUTO
  // decision: the signal said "maybe", the measured history says "no". FORCE is
  // an operator instruction and is never de-escalated by history.
  if (mode === WEB_ESCALATION_MODE.AUTO && weight.weight === ADVISOR_WEIGHT.LOCAL) {
    return admit(ADMISSION_ROUTE.PI_ONLY, ADMISSION_REASON.NEGATIVE_BENEFIT, { mode, score, features, escalation, weight })
  }

  // Escalation fired and history did not veto it. The route is always
  // PI_PLUS_ADVISOR here; the only variation is the REASON, which records
  // whether the measured benefit weight or the signal itself drove admission.
  const reason = mode === WEB_ESCALATION_MODE.FORCE
    ? ADMISSION_REASON.SIGNAL_PRESENT
    : weight.weight === ADVISOR_WEIGHT.CONSULT
      ? ADMISSION_REASON.BENEFIT_WEIGHT
      : ADMISSION_REASON.SIGNAL_PRESENT
  return admit(ADMISSION_ROUTE.PI_PLUS_ADVISOR, reason, { mode, score, features, escalation, weight })
}

/**
 * RE-SCORE after the local verifier ran. This is the new lifecycle step: the
 * verifier is the strongest available signal, and its verdict now feeds the
 * NEXT admission instead of being thrown away.
 *
 * @param {object} previous the decision from `decideAdmission`
 * @param {object} feedback { rejected, accepted, repeatedFailure }
 * @param {object} [state]  { followUpsSent, firstResolved, ... } for retry budget
 */
export function rescoreAfterVerifier(previous, feedback = {}, state = {}) {
  const base = previous || { route: ADMISSION_ROUTE.PI_PLUS_ADVISOR, score: 0, features: null }
  const rejected = feedback.rejected === true
  const accepted = feedback.accepted === true

  if (accepted && !rejected) {
    // Verified advice: the consultation paid off. Record and stay escalated only
    // if the caller explicitly wants continuity; otherwise the work is done.
    return {
      ...base,
      route: ADMISSION_ROUTE.PI_ONLY,
      reason: ADMISSION_REASON.VERIFIER_ACCEPTED,
      rescored: true,
      delta: DEESCALATION_THRESHOLD,
      feedback: { rejected: false, accepted: true },
    }
  }

  if (!rejected) {
    return { ...base, rescored: false, feedback: { rejected: false, accepted: false } }
  }

  // Verifier REJECTED the advice. Ask the retry budget (owned by
  // `followup-budget.mjs`) whether ONE more consult is justified. An explicit
  // caller override for `benefitExceedsCost` wins over the score heuristic, so
  // a caller that measured the benefit can veto a retry the score would allow.
  const benefitExceedsCost = state.benefitExceedsCost !== undefined
    ? state.benefitExceedsCost === true
    : (base.score >= ADMISSION_THRESHOLD || base.features?.verifierRepeatedFailure === true)
  const budget = maySendSecondFollowUp(
    { followUpsSent: Number(state.followUpsSent || 0) },
    {
      freshVerifierEvidence: true,
      fingerprintChanged: state.fingerprintChanged !== false,
      firstResolved: false,
      benefitExceedsCost,
      submitBudgetAllows: state.submitBudgetAllows !== false,
      sessionHealthy: state.sessionHealthy !== false,
    },
  )
  if (budget.allowed) {
    return {
      ...base,
      route: ADMISSION_ROUTE.ADVISOR_RETRY,
      reason: ADMISSION_REASON.RETRY_BUDGET_AVAILABLE,
      rescored: true,
      retry: { allowed: true, hardMax: FOLLOW_UP_BUDGET.hardMaxFollowUps },
      feedback: { rejected: true, accepted: false },
    }
  }
  return {
    ...base,
    route: ADMISSION_ROUTE.PI_ONLY,
    reason: ADMISSION_REASON.DEESCALATED_BY_VERIFIER,
    rescored: true,
    retry: { allowed: false, blockedBy: budget.reasons },
    feedback: { rejected: true, accepted: false },
  }
}

function admit(route, reason, extra) {
  return {
    schemaVersion: ADVISOR_ADMISSION_SCHEMA_VERSION,
    kind: "ues-v16-9-admission",
    policy: ADVISOR_ADMISSION_POLICY,
    route,
    reason,
    consultAdvisor: route === ADMISSION_ROUTE.PI_PLUS_ADVISOR || route === ADMISSION_ROUTE.ADVISOR_RETRY,
    retryAdvisor: route === ADMISSION_ROUTE.ADVISOR_RETRY,
    // Admission never grants authority: it is a routing decision, not a pass.
    mayProducePass: false,
    mayGrantPermissions: false,
    isToolInvocation: false,
    rescored: false,
    ...extra,
  }
}
