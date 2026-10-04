// V16.4 Slice D (part 2) / Phase 6: adaptive follow-up budget.
//
// Canonical default: maxFollowUps = 1. A second follow-up is allowed only when
// ALL of these hold:
//   - fresh local verifier evidence exists;
//   - its fingerprint differs from the previous one;
//   - the first follow-up did not resolve;
//   - expected benefit exceeds the cost threshold;
//   - submit budget allows;
//   - session is still healthy.
// Every external submit keeps zero automatic retry with explicit accounting.

export const FOLLOW_UP_BUDGET = Object.freeze({
  defaultMaxFollowUps: 1,
  hardMaxFollowUps: 2,
});

export function normalizeFollowUpBudget(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return FOLLOW_UP_BUDGET.defaultMaxFollowUps;
  return Math.max(0, Math.min(FOLLOW_UP_BUDGET.hardMaxFollowUps, Math.trunc(parsed)));
}

export function maySendSecondFollowUp(state = {}, evidence = {}) {
  const reasons = [];
  if (Number(state.followUpsSent || 0) < 1) {
    return { allowed: false, reason: "second-follow-up-requires-first", reasons: ["first-follow-up-not-sent"] };
  }
  if (!evidence.freshVerifierEvidence) reasons.push("no-fresh-verifier-evidence");
  if (!evidence.fingerprintChanged) reasons.push("evidence-fingerprint-unchanged");
  if (evidence.firstResolved) reasons.push("first-follow-up-resolved");
  if (!evidence.benefitExceedsCost) reasons.push("benefit-below-cost-threshold");
  if (!evidence.submitBudgetAllows) reasons.push("submit-budget-exhausted");
  if (!evidence.sessionHealthy) reasons.push("session-unhealthy");
  if (Number(state.followUpsSent || 0) >= FOLLOW_UP_BUDGET.hardMaxFollowUps) {
    reasons.push("hard-max-enforced");
  }
  if (reasons.length) return { allowed: false, reason: reasons[0], reasons };
  return { allowed: true, reason: "verified-delta-allows-second", reasons: [] };
}

/**
 * Account one external submit. Zero automatic retry: attempts are recorded
 * explicitly and the budget never auto-refills.
 */
export function accountExternalSubmit(ledger = { submitted: 0, budget: 1 }, count = 1) {
  const submitted = Number(ledger.submitted || 0) + Math.max(0, Math.trunc(count));
  const budget = Number(ledger.budget ?? 1);
  return {
    submitted,
    budget,
    remaining: Math.max(0, budget - submitted),
    exceeded: submitted > budget,
    automaticRetries: 0,
  };
}
