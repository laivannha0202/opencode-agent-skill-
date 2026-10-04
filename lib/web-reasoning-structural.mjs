// V16.4 Slice C: structural escalation V2 (evidence-first routing).
//
// Priority: (1) runtime evidence, (2) repository structure, (3) verifier
// history, (4) task textual signal. Vietnamese keyword signals are a fallback
// only and NEVER override grounded structural evidence.
//
// The signal vocabulary lives in `lib/web-reasoning-signals.mjs`, not in
// `web-reasoning-escalation.mjs`: the escalation router imports THIS module in
// production, so importing the enums back from the router would be a cycle that
// leaves them uninitialised when this module's pattern table is built.

import {
  ESCALATION_SIGNAL,
  NON_ESCALATION_SIGNAL,
  STRUCTURAL_SIGNAL,
} from "./web-reasoning-signals.mjs";

export { STRUCTURAL_SIGNAL };

const VI_FALLBACK_PATTERNS = [
  [/không rõ nguyên nhân|không chắc nguyên nhân/i, ESCALATION_SIGNAL.AMBIGUOUS_ROOT_CAUSE],
  [/nhiều cách sửa|nhiều phương án/i, ESCALATION_SIGNAL.SEVERAL_PLAUSIBLE_FIXES],
  [/lỗi nhiều module|lỗi nhiều tầng/i, ESCALATION_SIGNAL.MULTI_SUBSYSTEM],
  [/kiểm tra kiến trúc/i, ESCALATION_SIGNAL.ARCHITECTURAL_UNCERTAINTY],
  [/vẫn lỗi|test vẫn fail/i, ESCALATION_SIGNAL.VERIFIER_REPEATED_FAILURE],
  [/không chắc|cần ý kiến thứ hai/i, ESCALATION_SIGNAL.LOW_CONFIDENCE],
];

export function detectVietnameseFallbackSignals(text = "") {
  const found = [];
  for (const [pattern, signal] of VI_FALLBACK_PATTERNS) {
    if (pattern.test(String(text))) found.push(signal);
  }
  return [...new Set(found)];
}

/**
 * Score grounded structural evidence. Deterministic and auditable.
 * Returns { signals, grounded } where grounded=true means structural evidence
 * alone justifies escalation regardless of text.
 */
export function scoreStructuralEvidence(input = {}) {
  const signals = [];
  if (Number(input.affectedSubsystems || 0) >= 3) signals.push(ESCALATION_SIGNAL.MULTI_SUBSYSTEM);
  if (Number(input.verifierRetries || 0) >= 2) signals.push(ESCALATION_SIGNAL.VERIFIER_REPEATED_FAILURE);
  const confidence = Number(input.localConfidence ?? 1);
  if (Number.isFinite(confidence) && confidence < 0.5) signals.push(ESCALATION_SIGNAL.LOW_CONFIDENCE);
  if (Number(input.multipleCandidateFixes || 0) >= 2) signals.push(STRUCTURAL_SIGNAL.MULTIPLE_CANDIDATE_FIXES);
  if (input.rootCauseAmbiguous === true) signals.push(STRUCTURAL_SIGNAL.ROOT_CAUSE_AMBIGUOUS);
  if (input.diagnosticConflict === true) signals.push(STRUCTURAL_SIGNAL.DIAGNOSTIC_CONFLICT);
  if (input.recoveryExhausted === true) signals.push(STRUCTURAL_SIGNAL.RECOVERY_EXHAUSTED);
  const retrieval = Number(input.retrievalConfidence ?? 1);
  if (Number.isFinite(retrieval) && retrieval < 0.4) signals.push(STRUCTURAL_SIGNAL.LOW_RETRIEVAL_CONFIDENCE);
  if (Number(input.editSiteCandidates || 0) >= 4) signals.push(STRUCTURAL_SIGNAL.MANY_EDIT_CANDIDATES);
  if (input.crossLayerDependency === true) signals.push(STRUCTURAL_SIGNAL.CROSS_LAYER_DEPENDENCY);
  if (input.architecturalDecisionRequired === true) signals.push(STRUCTURAL_SIGNAL.ARCHITECTURE_DECISION_REQUIRED);
  return { signals: [...new Set(signals)], grounded: signals.length > 0 };
}

/**
 * Evidence-first routing matrix. Structural evidence wins over text.
 * `textSignals` = signals from regex/text; `nonEscalation` = skip signals.
 */
export function routeWithStructuralEvidence({ structural = [], textSignals = [], nonEscalation = [], groundedSkip = false } = {}) {
  const structuralUnique = [...new Set(structural)];
  // Grounded structural escalation beats a textual skip unless the caller
  // asserted an explicit grounded fact (version bump / doc edit already
  // verified locally).
  if (structuralUnique.length > 0 && !groundedSkip) {
    return { escalate: true, basis: "structural-evidence", signals: structuralUnique };
  }
  if (groundedSkip) return { escalate: false, basis: "grounded-skip", signals: [] };
  const skip = (nonEscalation || []).some((s) =>
    s === NON_ESCALATION_SIGNAL.ALREADY_GROUNDED ||
    s === NON_ESCALATION_SIGNAL.VERSION_BUMP ||
    s === NON_ESCALATION_SIGNAL.DOC_EDIT);
  if (skip) return { escalate: false, basis: "text-skip", signals: [] };
  const text = [...new Set(textSignals || [])];
  if (text.length > 0) return { escalate: true, basis: "text-signal", signals: text };
  return { escalate: false, basis: "no-signal", signals: [] };
}
