// V16.12 Incremental Verification Planner V2.
//
// WHY THIS MODULE EXISTS
//
// V16.10 already owns the verification LADDER: `planVerificationLadder` and
// `runVerificationLadder` pick the cheapest sufficient rung (reuse -> static ->
// affected -> suite -> independent). V16.12 must NOT create a second
// verification authority. What V16.12 adds on top is a PLANNER that answers the
// task-shape question the ladder does not:
//
//   "Given HOW BIG this change is, what is the SMALLEST verification plan that
//    still proves it - and when must it escalate?"
//
// This module is a pure composition layer over the existing owners:
//
//   * `planVerificationLadder`  (V16.10)  - the rung ordering + strength law
//   * `requiredStrength`        (V16.10)  - the minimum evidence strength
//   * `resolveAffectedTests`    (existing) - the affected-test set
//   * `findReusableReceipt`     (V16.12)  - the receipt-cache R0 check
//   * `shapeTestOutput`         (V16.10)  - the compact failure delta
//
// LAWS
//
//   1. ONE AUTHORITY. This planner never invents a rung order; it reads the
//      ladder's. It only maps task SHAPE to a policy the ladder already accepts.
//   2. FALSE NEGATIVES ARE DANGEROUS. When affected-test confidence is low or the
//      change touches shared/multi-module surface, the planner escalates to a
//      broader rung. It never silently narrows.
//   3. FAILURE FEEDBACK IS COMPACT. A failure returns a structured delta (failed
//      rung, failed tests, first assertion, diagnostic, recommended next target),
//      never thousands of passing lines.
//   4. FINAL RELEASE IS NEVER PLANNED AWAY. A `finalRelease` plan always names
//      the full suite AND the release verifier; receipt reuse is disabled.

import {
  planVerificationLadder,
  requiredStrength,
  VERIFICATION_RUNG,
  EVIDENCE_STRENGTH,
} from "./verification-ladder-v16-10.mjs"
import { shapeTestOutput } from "./tool-output-budgeter-v16-10.mjs"
import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const INCREMENTAL_VERIFICATION_SCHEMA_VERSION = 1
export const INCREMENTAL_VERIFICATION_POLICY = "incremental-verification-v16-12"

// Task shapes. The shape selects a policy; the ladder selects the rung.
export const TASK_SHAPE = Object.freeze({
  TINY: "TINY",
  NORMAL: "NORMAL",
  DEEP: "DEEP",
  RELEASE: "RELEASE",
})

export const FAST_PATH = Object.freeze({
  TINY_FAST_PATH: "TINY_FAST_PATH",
  NORMAL_PATH: "NORMAL_PATH",
  DEEP_PATH: "DEEP_PATH",
  RELEASE_PATH: "RELEASE_PATH",
})

// Shared/multi-module surface markers that force escalation regardless of the
// naive file count. These are the surfaces where a narrow test set is most
// likely to produce a false negative.
const SHARED_SURFACE_RE = /(^|\/)(index|main|runtime|orchestrator|scheduler|coordinator|policy|task-policy|safety|permission-policy|workspace-state-owner|execution-coordinator)\.(?:mjs|cjs|js|ts)$/i

/**
 * Classify a task's SHAPE from its declared surface. Deterministic and
 * conservative: when the signal is ambiguous the shape is the LARGER one.
 *
 * @param {object} input
 * @param {string[]} [input.changedFiles]
 * @param {string} [input.risk]            "low" | "medium" | "high" | "critical"
 * @param {boolean} [input.docsOnly]
 * @param {boolean} [input.crossModule]    caller-declared cross-module change
 * @param {boolean} [input.finalRelease]   the final release candidate
 * @param {boolean} [input.verifierFailed] a verifier already failed once
 */
export function classifyTaskShape(input = {}) {
  if (input.finalRelease === true) return TASK_SHAPE.RELEASE
  const changed = [...new Set((input.changedFiles || []).map(String))]
  const risk = String(input.risk || "").toLowerCase()
  const docsOnly = input.docsOnly === true
  const crossModule = input.crossModule === true
  const verifierFailed = input.verifierFailed === true

  if (risk === "high" || risk === "critical") return TASK_SHAPE.DEEP
  if (crossModule || verifierFailed) return TASK_SHAPE.DEEP
  if (changed.some((file) => SHARED_SURFACE_RE.test(file))) return TASK_SHAPE.DEEP
  if (docsOnly && changed.length <= 2) return TASK_SHAPE.TINY
  if (changed.length === 0) return TASK_SHAPE.TINY
  if (changed.length === 1) return TASK_SHAPE.TINY
  if (changed.length <= 3) return TASK_SHAPE.NORMAL
  return TASK_SHAPE.DEEP
}

/** Map a shape to the ladder policy the V16.10 planner already understands. */
export function shapePolicy(shape, input = {}) {
  const docsOnly = input.docsOnly === true
  switch (shape) {
    case TASK_SHAPE.TINY:
      return { risk: "low", executionProfile: "fast", docsOnly, singleFileBounded: true }
    case TASK_SHAPE.NORMAL:
      return { risk: "medium", executionProfile: "fast", docsOnly: false }
    case TASK_SHAPE.DEEP:
      return { risk: "high", executionProfile: "standard", docsOnly: false }
    case TASK_SHAPE.RELEASE:
      return { risk: "critical", executionProfile: "standard", docsOnly: false, requiredEvidenceStrength: EVIDENCE_STRENGTH.BEHAVIOR }
    default:
      return { risk: "high", executionProfile: "standard" }
  }
}

/** Map a shape to its fast path label. */
export function shapeFastPath(shape) {
  switch (shape) {
    case TASK_SHAPE.TINY: return FAST_PATH.TINY_FAST_PATH
    case TASK_SHAPE.NORMAL: return FAST_PATH.NORMAL_PATH
    case TASK_SHAPE.DEEP: return FAST_PATH.DEEP_PATH
    case TASK_SHAPE.RELEASE: return FAST_PATH.RELEASE_PATH
    default: return FAST_PATH.NORMAL_PATH
  }
}

/**
 * Plan verification for a task. PURE. Composes the V16.10 ladder; never runs a
 * test. Returns the target rung, the full escalation path, the fast path, and
 * the receipt-cache posture.
 */
export function planIncrementalVerification(input = {}) {
  const shape = input.shape || classifyTaskShape(input)
  const policy = shapePolicy(shape, input)
  const changedFiles = [...new Set((input.changedFiles || []).map(String))]
  const ladder = planVerificationLadder({ policy, changedFiles, independentVerifierAvailable: input.independentVerifierAvailable === true })
  const finalRelease = shape === TASK_SHAPE.RELEASE

  // Escalation path: the rungs from the target upward, in ladder order.
  const targetIndex = ladder.rungs.findIndex((row) => row.rung === ladder.targetRung)
  const escalationPath = ladder.rungs
    .slice(targetIndex < 0 ? 0 : targetIndex)
    .filter((row) => row.applicable && row.rung !== VERIFICATION_RUNG.REUSE)
    .map((row) => row.rung)

  return {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    policy: INCREMENTAL_VERIFICATION_POLICY,
    shape,
    fastPath: shapeFastPath(shape),
    requiredStrength: ladder.requiredStrength,
    targetRung: ladder.targetRung,
    escalationPath,
    changedFiles,
    // TINY/NORMAL must not run a full suite during implementation. Only DEEP and
    // RELEASE may; RELEASE always does.
    allowFullSuiteDuringImplementation: shape === TASK_SHAPE.DEEP || finalRelease,
    allowReleaseVerify: finalRelease,
    // The receipt cache is consulted during development; it is DISABLED at the
    // final release, where the suite and release verifier must run fresh.
    receiptReuseEnabled: !finalRelease,
    finalRelease,
    ladder,
    deterministic: true,
  }
}

/**
 * Check whether a fresh receipt can satisfy the plan's target rung WITHOUT
 * running anything. Delegates the actual lookup to the V16.12 receipt cache.
 *
 * @param {string} root
 * @param {object} plan  a planIncrementalVerification result
 * @param {object} input { gateName, command, args, cwd, ... }
 * @param {(root: string, input: object, options: object) => Promise<any>} findReceipt
 */
export async function checkReceiptReuse(root, plan, input = {}, findReceipt) {
  if (!plan.receiptReuseEnabled) {
    return { reusable: false, reason: "final-release-mode-disables-reuse", provenance: NOT_MEASURED }
  }
  if (typeof findReceipt !== "function") {
    return { reusable: false, reason: "no-receipt-lookup-provided", provenance: NOT_MEASURED }
  }
  const receipt = await findReceipt(root, input, {}).catch(() => null)
  if (!receipt?.reusable) {
    return { reusable: false, reason: "no-fresh-matching-receipt", provenance: NOT_MEASURED }
  }
  return { reusable: true, reason: "fresh-matching-receipt", receipt, provenance: measured(1) }
}

/**
 * Build a compact failure delta from a raw test/verification log. Reuses the
 * V16.10 Tool Output Budgeter so a failure never resends thousands of passing
 * lines.
 *
 * @param {string} rawLog
 * @param {object} context { rung, command, handle, exitCode }
 */
export function buildFailureDelta(rawLog, context = {}) {
  const shaped = shapeTestOutput(String(rawLog || ""), {
    command: context.command || null,
    exitCode: context.exitCode ?? null,
    handle: context.handle || null,
  })
  const failures = /** @type {any} */ (shaped.failures) || {}
  const failedTests = failures.failedTests || []
  const firstAssertion = failures.firstAssertion || null
  return {
    schemaVersion: INCREMENTAL_VERIFICATION_SCHEMA_VERSION,
    policy: INCREMENTAL_VERIFICATION_POLICY,
    failedRung: context.rung || null,
    outcome: shaped.outcome,
    failedTests,
    firstAssertion,
    diagnostic: failures.rootError || firstAssertion,
    changedEvidence: failures.affectedFiles || [],
    recommendedNextTarget: recommendNextTarget(context.rung, shaped.outcome),
    text: shaped.text,
    // Honest: the raw log was reduced, so its size and handle are reported.
    rawChars: measured(String(rawLog || "").length),
    visibleChars: measured(shaped.text.length),
    expansion: shaped.expansion,
  }
}

/**
 * Recommend the next verification target after a failure. A failure escalates;
 * it never repeats the same rung blindly.
 */
export function recommendNextTarget(failedRung, outcome) {
  if (outcome !== "fail") return null
  switch (String(failedRung || "")) {
    case VERIFICATION_RUNG.STATIC: return VERIFICATION_RUNG.AFFECTED
    case VERIFICATION_RUNG.AFFECTED: return VERIFICATION_RUNG.SUITE
    case VERIFICATION_RUNG.REUSE: return VERIFICATION_RUNG.STATIC
    default: return VERIFICATION_RUNG.SUITE
  }
}

/**
 * Decide whether a plan may be considered SATISFIED by the evidence collected
 * so far. It NEVER invents a PASS: it only confirms that a satisfying rung
 * produced passing evidence. Mirrors the ladder's own law.
 */
export function planIsSatisfied(plan, evidence = {}) {
  const proven = String(evidence.provenStrength || EVIDENCE_STRENGTH.NONE)
  const rank = { none: 0, syntax: 1, unit: 2, behavior: 3, independent: 4 }
  const ok = (rank[proven] || 0) >= (rank[plan.requiredStrength] || 0)
  return {
    satisfied: ok && evidence.verdict === "PASS",
    provenStrength: proven,
    requiredStrength: plan.requiredStrength,
    reason: ok ? "evidence-meets-required-strength" : `claim requires ${plan.requiredStrength}; proven ${proven}`,
  }
}

export const incrementalVerificationExports = Object.freeze({
  classifyTaskShape,
  shapePolicy,
  shapeFastPath,
  planIncrementalVerification,
  checkReceiptReuse,
  buildFailureDelta,
  recommendNextTarget,
  planIsSatisfied,
  TASK_SHAPE,
  FAST_PATH,
})
