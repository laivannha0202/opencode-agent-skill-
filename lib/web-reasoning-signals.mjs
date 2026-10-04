// The web-reasoning signal vocabulary, in its own module.
//
// WHY THIS FILE EXISTS (V16.4). `lib/web-reasoning-escalation.mjs` is the
// production caller of `lib/web-reasoning-structural.mjs`, and the structural
// module needs these exact identifiers. When both imported each other directly,
// the cycle made `ESCALATION_SIGNAL` observable as uninitialised at
// module-evaluation time (`ReferenceError: Cannot access ... before
// initialization`), because `web-reasoning-structural.mjs` builds a module-level
// pattern table from them.
//
// Owning the vocabulary here breaks the cycle without duplicating a single
// string: `web-reasoning-escalation.mjs` re-exports both names, so every
// existing importer (`web-reasoning-lane.mjs`, the DeepSeek adapter, the
// accuracy validator, the tests) keeps the same import path.

// Signals that make an external second opinion worth its cost. Each is a
// POSITIVE trigger; the absence of all of them means Pi keeps the work.
export const ESCALATION_SIGNAL = Object.freeze({
  MULTI_SUBSYSTEM: "multi-subsystem-task",
  ARCHITECTURAL_UNCERTAINTY: "architectural-uncertainty",
  AMBIGUOUS_ROOT_CAUSE: "ambiguous-root-cause",
  VERIFIER_REPEATED_FAILURE: "verifier-repeated-failure",
  SEVERAL_PLAUSIBLE_FIXES: "several-plausible-fixes",
  LOW_CONFIDENCE: "low-local-confidence",
  LONG_HORIZON_SECOND_OPINION: "long-horizon-reasoning-second-opinion",
  BOUNDED_RECOVERY_EXHAUSTED: "local-bounded-recovery-exhausted",
})

// The inverse list exists because the cost of a needless consultation is real:
// latency, tokens, a browser session and an external dependency on a task that
// a local read would have closed. These are stated explicitly so the skip
// decision is auditable rather than implicit.
export const NON_ESCALATION_SIGNAL = Object.freeze({
  VERSION_BUMP: "version-bump",
  DOC_EDIT: "readme-or-doc-edit",
  TRIVIAL_ONE_FILE: "trivial-one-file-deterministic-fix",
  SYNTAX_ONLY: "simple-syntax-issue",
  ALREADY_GROUNDED: "already-grounded-low-risk-task",
})

// V16.4 grounded structural signals. They are distinct from the text signals
// above because they are produced by a measured quantity or a declared fact,
// never by a regex over the task text.
export const STRUCTURAL_SIGNAL = Object.freeze({
  MULTIPLE_CANDIDATE_FIXES: "multiple-candidate-fixes",
  ROOT_CAUSE_AMBIGUOUS: "root-cause-ambiguous",
  DIAGNOSTIC_CONFLICT: "diagnostic-conflict",
  RECOVERY_EXHAUSTED: "recovery-exhausted",
  LOW_RETRIEVAL_CONFIDENCE: "low-retrieval-confidence",
  MANY_EDIT_CANDIDATES: "many-edit-site-candidates",
  CROSS_LAYER_DEPENDENCY: "cross-layer-dependency",
  ARCHITECTURE_DECISION_REQUIRED: "architectural-decision-required",
})