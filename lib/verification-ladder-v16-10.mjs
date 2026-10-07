// V16.10 Verification Ladder.
//
// WHY THIS MODULE EXISTS
//
// The runtime already owns the PIECES of verification: `verification-broker`
// reuses a fresh receipt, `fast-static-verification` runs diagnostics on a
// changed file, `affected-tests` finds the tests a change touches,
// `verification-plan` names the project-native commands, and
// `fast-verification-gate` decides whether a fast bounded run may pass. What did
// NOT exist was a single owner of the QUESTION a run asks before it verifies:
//
//   "What is the CHEAPEST evidence that can still prove THIS claim?"
//
// Without that owner, a run either over-verifies (running the whole suite for a
// one-line comment change) or - far worse - under-verifies and then reports a
// PASS it did not earn. This module is that owner.
//
// THE LADDER (cheapest rung first)
//
//   R0 REUSE        a fresh receipt whose workspace fingerprint matches now
//   R1 STATIC       diagnostics on the changed files (types/lint/syntax)
//   R2 AFFECTED     the targeted tests for the changed files
//   R3 SUITE        the project-native full test command
//   R4 INDEPENDENT  a separate verifier's receipt (never self-issued)
//
// LAWS
//
//   1. CHEAPEST SUFFICIENT RUNG WINS. The planner returns the lowest rung whose
//      evidence strength is >= the strength the claim requires. It never runs a
//      stronger rung when a weaker one already suffices.
//   2. A RUNG IS ONLY SKIPPED WHEN PROVEN UNAVAILABLE. If R1 static evidence is
//      incomplete, the ladder escalates - it does not pretend the rung passed.
//   3. NO PROMOTION WITHOUT EVIDENCE. A rung's `satisfied` flag is only ever set
//      from a receipt that passed at the current fingerprint. Absence of
//      evidence is `unverified`, never `passed`.
//   4. HONEST VERDICT. `verdict` is PASS only when a satisfying rung produced
//      passing evidence; otherwise UNVERIFIED or FAIL. There is no "probably".
//   5. ONE OWNER. The ladder ORCHESTRATES the existing verifiers; it does not
//      run tests itself and does not re-implement fingerprint comparison.

import { findReusableVerification } from "./verification-broker.mjs"
import { collectFastStaticEvidence } from "./fast-static-verification.mjs"
import { resolveAffectedTests } from "./affected-tests.mjs"
import { runtimeWorkspaceFingerprint } from "./workspace-fingerprint.mjs"
import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const VERIFICATION_LADDER_SCHEMA_VERSION = 1
export const VERIFICATION_LADDER_POLICY = "verification-ladder-v16-10"

/** The rungs, cheapest first. Order is the ladder; never reorder casually. */
export const VERIFICATION_RUNG = Object.freeze({
  REUSE: "reuse",
  STATIC: "static",
  AFFECTED: "affected-tests",
  SUITE: "full-suite",
  INDEPENDENT: "independent-verifier",
})

export const RUNG_ORDER = [
  VERIFICATION_RUNG.REUSE,
  VERIFICATION_RUNG.STATIC,
  VERIFICATION_RUNG.AFFECTED,
  VERIFICATION_RUNG.SUITE,
  VERIFICATION_RUNG.INDEPENDENT,
]

/**
 * Evidence STRENGTH each rung can prove. A claim states the minimum strength it
 * requires; the ladder picks the cheapest rung that meets or exceeds it.
 *
 *   syntax  - the code parses / has no static errors        (R1)
 *   unit    - the targeted tests for the change pass         (R2)
 *   behavior- the project's own suite passes                 (R3)
 *   independent - a verifier other than the author confirms  (R4)
 */
export const EVIDENCE_STRENGTH = Object.freeze({
  NONE: "none",
  SYNTAX: "syntax",
  UNIT: "unit",
  BEHAVIOR: "behavior",
  INDEPENDENT: "independent",
})

const STRENGTH_RANK = Object.freeze({
  [EVIDENCE_STRENGTH.NONE]: 0,
  [EVIDENCE_STRENGTH.SYNTAX]: 1,
  [EVIDENCE_STRENGTH.UNIT]: 2,
  [EVIDENCE_STRENGTH.BEHAVIOR]: 3,
  [EVIDENCE_STRENGTH.INDEPENDENT]: 4,
})

const RUNG_STRENGTH = Object.freeze({
  [VERIFICATION_RUNG.REUSE]: null, // reuse adopts the strength of the receipt it reuses
  [VERIFICATION_RUNG.STATIC]: EVIDENCE_STRENGTH.SYNTAX,
  [VERIFICATION_RUNG.AFFECTED]: EVIDENCE_STRENGTH.UNIT,
  [VERIFICATION_RUNG.SUITE]: EVIDENCE_STRENGTH.BEHAVIOR,
  [VERIFICATION_RUNG.INDEPENDENT]: EVIDENCE_STRENGTH.INDEPENDENT,
})

/**
 * Infer the minimum evidence strength a task requires from its declared policy.
 * Deterministic and conservative: an unclassified task requires BEHAVIOR, not
 * SYNTAX, because "we don't know" must never mean "weaker is fine".
 */
export function requiredStrength(policy = {}) {
  if (policy.requiredEvidenceStrength && STRENGTH_RANK[policy.requiredEvidenceStrength] != null) {
    return policy.requiredEvidenceStrength
  }
  const risk = String(policy.risk || "").toLowerCase()
  const profile = String(policy.executionProfile || "").toLowerCase()
  if (policy.docsOnly === true) return EVIDENCE_STRENGTH.SYNTAX
  if (risk === "low" && profile === "fast") return EVIDENCE_STRENGTH.SYNTAX
  if (policy.verificationRequired === false) return EVIDENCE_STRENGTH.NONE
  if (risk === "high" || risk === "critical") return EVIDENCE_STRENGTH.BEHAVIOR
  if (profile === "fast") return EVIDENCE_STRENGTH.UNIT
  return EVIDENCE_STRENGTH.BEHAVIOR
}

function rankOf(strength) {
  return STRENGTH_RANK[strength] ?? 0
}

/**
 * Plan the ladder for a task WITHOUT running anything. Pure: it reads policy and
 * changed files and returns the rung it intends to try first, plus the full
 * ordered plan. The applier below executes it.
 */
export function planVerificationLadder(input = {}) {
  const policy = input.policy || {}
  const required = input.requiredStrength || requiredStrength(policy)
  const changedFiles = [...new Set((input.changedFiles || []).map(String))]
  const singleFileBounded = policy.singleFileBounded === true
  const rungs = []
  for (const rung of RUNG_ORDER) {
    const strength = RUNG_STRENGTH[rung]
    const applicable =
      rung === VERIFICATION_RUNG.REUSE ? true
        : rung === VERIFICATION_RUNG.STATIC ? changedFiles.length > 0
          : rung === VERIFICATION_RUNG.AFFECTED ? changedFiles.length > 0
            : rung === VERIFICATION_RUNG.SUITE ? true
              : input.independentVerifierAvailable === true
    rungs.push({
      rung,
      strength,
      applicable,
      // A rung is a candidate when it is applicable AND strong enough for the
      // claim. The first candidate in ladder order is the one to try first.
      sufficient: applicable && (strength == null || rankOf(strength) >= rankOf(required)),
    })
  }
  const firstSufficient = rungs.find((row) => row.sufficient && row.rung !== VERIFICATION_RUNG.REUSE)
  return {
    schemaVersion: VERIFICATION_LADDER_SCHEMA_VERSION,
    policy: VERIFICATION_LADDER_POLICY,
    requiredStrength: required,
    changedFiles,
    singleFileBounded,
    rungs,
    // The cheapest rung that can prove the claim. REUSE is tried first always,
    // but it is not "sufficient" on its own - it only counts if a receipt exists.
    targetRung: firstSufficient ? firstSufficient.rung : VERIFICATION_RUNG.INDEPENDENT,
    escalationPolicy: "cheapest-sufficient-rung; escalate-only-when-proven-unavailable",
    deterministic: true,
  }
}

function nowMs() {
  return Date.now()
}

/**
 * Execute the ladder. Each rung is attempted in order; the ladder STOPS at the
 * first rung that produces passing evidence at the current fingerprint. A rung
 * that is applicable but cannot produce evidence is recorded as such and the
 * ladder escalates.
 *
 * `options.runRung` lets a caller inject the actual command execution for the
 * SUITE rung (the ladder never spawns a process itself). If it is absent, the
 * SUITE rung is reported as `unavailable` rather than assumed to pass.
 */
export async function runVerificationLadder(root, input = {}, options = {}) {
  root = options.root || root || process.cwd()
  const plan = planVerificationLadder(input)
  let fingerprint = String(options.workspaceFingerprint || "")
  if (!fingerprint || fingerprint === "unknown") {
    try {
      fingerprint = runtimeWorkspaceFingerprint(root)
    } catch {
      fingerprint = "unknown"
    }
  }

  const attempts = []
  let verdict = "UNVERIFIED"
  let provenStrength = EVIDENCE_STRENGTH.NONE
  let evidenceRef = null
  let satisfiedRung = null
  const startedAt = nowMs()

  // A rung only SATISFIES the claim when the strength it proves is at least the
  // strength the claim requires. A cheap rung that passes but is too weak is
  // recorded as `passed-insufficient` and the ladder keeps escalating - it must
  // never stop early on evidence that does not actually prove the claim.
  const accepts = (strength) => rankOf(strength) >= rankOf(plan.requiredStrength)

  for (const row of plan.rungs) {
    if (!row.applicable) {
      attempts.push({ rung: row.rung, status: "not-applicable", reason: "rung-not-applicable" })
      continue
    }

    if (row.rung === VERIFICATION_RUNG.REUSE) {
      const reusable = await tryReuse(root, input, fingerprint).catch(() => null)
      const reuseStrength = reusable?.passed ? (input.reuseStrength || EVIDENCE_STRENGTH.BEHAVIOR) : null
      if (reusable?.passed && accepts(reuseStrength)) {
        attempts.push(reusable.attempt)
        verdict = "PASS"
        satisfiedRung = row.rung
        provenStrength = reuseStrength
        evidenceRef = reusable.evidenceRef
        break
      }
      attempts.push(reusable?.attempt || { rung: row.rung, status: "miss", reason: "no-fresh-matching-receipt" })
      if (reusable?.passed) attempts[attempts.length - 1].status = "passed-insufficient"
      continue
    }

    if (row.rung === VERIFICATION_RUNG.STATIC) {
      const staticResult = await tryStatic(root, input, options).catch((error) => ({ attempt: { rung: row.rung, status: "error", reason: String(error?.message || error) }, passed: false }))
      if (staticResult.passed && accepts(EVIDENCE_STRENGTH.SYNTAX)) {
        attempts.push(staticResult.attempt)
        verdict = "PASS"
        satisfiedRung = row.rung
        provenStrength = EVIDENCE_STRENGTH.SYNTAX
        evidenceRef = staticResult.evidenceRef || null
        break
      }
      if (staticResult.passed) staticResult.attempt.status = "passed-insufficient"
      attempts.push(staticResult.attempt)
      continue
    }

    if (row.rung === VERIFICATION_RUNG.AFFECTED) {
      const affected = await tryAffected(root, input, fingerprint).catch((error) => ({ attempt: { rung: row.rung, status: "error", reason: String(error?.message || error) }, passed: false }))
      if (affected.passed && accepts(EVIDENCE_STRENGTH.UNIT)) {
        attempts.push(affected.attempt)
        verdict = "PASS"
        satisfiedRung = row.rung
        provenStrength = EVIDENCE_STRENGTH.UNIT
        evidenceRef = affected.evidenceRef || null
        break
      }
      if (affected.passed) affected.attempt.status = "passed-insufficient"
      attempts.push(affected.attempt)
      continue
    }

    if (row.rung === VERIFICATION_RUNG.SUITE) {
      if (typeof options.runSuite !== "function") {
        attempts.push({ rung: row.rung, status: "unavailable", reason: "no-suite-runner-provided" })
        continue
      }
      const suite = await options.runSuite({ plan, input, root }).catch((error) => ({ passed: false, reason: String(error?.message || error) }))
      const suitePassed = suite?.passed === true
      const suiteSufficient = suitePassed && accepts(EVIDENCE_STRENGTH.BEHAVIOR)
      attempts.push({
        rung: row.rung,
        status: suitePassed ? (suiteSufficient ? "passed" : "passed-insufficient") : "failed",
        reason: suite?.reason || null,
        command: suite?.command || null,
      })
      if (suiteSufficient) {
        verdict = "PASS"
        satisfiedRung = row.rung
        provenStrength = EVIDENCE_STRENGTH.BEHAVIOR
        evidenceRef = suite?.evidenceRef || null
        break
      }
      continue
    }

    if (row.rung === VERIFICATION_RUNG.INDEPENDENT) {
      if (input.independentVerifierAvailable !== true) {
        attempts.push({ rung: row.rung, status: "unavailable", reason: "no-independent-verifier" })
        continue
      }
      const independent = await tryReuse(root, { ...input, requireVerifier: true }, fingerprint).catch(() => null)
      const indepPassed = independent?.passed === true && accepts(EVIDENCE_STRENGTH.INDEPENDENT)
      attempts.push(independent?.attempt
        ? { ...independent.attempt, status: independent.passed ? (indepPassed ? "passed" : "passed-insufficient") : independent.attempt.status }
        : { rung: row.rung, status: "unavailable", reason: "no-independent-receipt" })
      if (indepPassed) {
        verdict = "PASS"
        satisfiedRung = row.rung
        provenStrength = EVIDENCE_STRENGTH.INDEPENDENT
        evidenceRef = independent.evidenceRef
        break
      }
      continue
    }
  }

  // A FAIL is only reported when a rung actually RAN and failed; otherwise the
  // claim is simply UNVERIFIED. The two are never conflated.
  if (verdict !== "PASS" && attempts.some((row) => row.status === "failed")) verdict = "FAIL"

  return {
    schemaVersion: VERIFICATION_LADDER_SCHEMA_VERSION,
    policy: VERIFICATION_LADDER_POLICY,
    root,
    workspaceFingerprint: fingerprint,
    requiredStrength: plan.requiredStrength,
    verdict,
    satisfiedRung,
    provenStrength,
    sufficient: rankOf(provenStrength) >= rankOf(plan.requiredStrength),
    evidenceRef,
    attempts,
    durationMs: nowMs() - startedAt,
    plan,
    // Honest: an unsatisfied requirement is stated, not hidden behind a PASS.
    unmetRequirement: verdict === "PASS" ? null : `claim requires ${plan.requiredStrength} evidence; proven ${provenStrength}`,
    provenance: { fingerprint: fingerprint === "unknown" ? NOT_MEASURED : measured(fingerprint.length), attempts: measured(attempts.length) },
  }
}

async function tryReuse(root, input, fingerprint) {
  const command = String(input.reuseCommand || input.testCommand || "")
  if (!command) {
    return { attempt: { rung: VERIFICATION_RUNG.REUSE, status: "unavailable", reason: "no-reusable-command-declared" }, passed: false }
  }
  const args = Array.isArray(input.reuseArgs) ? input.reuseArgs : []
  const reusable = await findReusableVerification(root, command, args, {
    maxAgeMs: Number(input.reuseMaxAgeMs || 20 * 60_000),
    workspaceFingerprint: fingerprint,
  })
  if (reusable?.reusable === true || reusable?.receipt) {
    return {
      attempt: { rung: VERIFICATION_RUNG.REUSE, status: "passed", reason: "fresh-matching-receipt", command, receiptId: reusable?.receipt?.id || null },
      passed: true,
      evidenceRef: reusable?.receipt?.evidenceRef || null,
      strength: input.reuseStrength || null,
    }
  }
  return { attempt: { rung: VERIFICATION_RUNG.REUSE, status: "miss", reason: reusable?.reason || "no-fresh-matching-receipt" }, passed: false }
}

async function tryStatic(root, input, options) {
  const snapshot = { changedFiles: input.changedFiles || [] }
  const evidence = await collectFastStaticEvidence(root, snapshot, options.staticOptions || {})
  if (evidence.required === false) {
    return { attempt: { rung: VERIFICATION_RUNG.STATIC, status: "not-applicable", reason: evidence.reason || "no-static-target" }, passed: false }
  }
  if (evidence.complete === true && Number(evidence.errorCount || 0) === 0) {
    return { attempt: { rung: VERIFICATION_RUNG.STATIC, status: "passed", reason: evidence.reason, file: evidence.file, source: evidence.source }, passed: true, evidenceRef: evidence.fingerprint || null }
  }
  return {
    attempt: {
      rung: VERIFICATION_RUNG.STATIC,
      status: evidence.complete === true ? "failed" : "incomplete",
      reason: evidence.reason,
      errorCount: Number(evidence.errorCount || 0),
    },
    passed: false,
  }
}

async function tryAffected(root, input, fingerprint) {
  const affected = await resolveAffectedTests(root, {
    changedFiles: input.changedFiles,
    workspaceFingerprint: fingerprint,
    limit: input.affectedTestLimit,
  })
  const tests = affected.tests || []
  if (!tests.length) {
    return { attempt: { rung: VERIFICATION_RUNG.AFFECTED, status: "not-applicable", reason: "no-affected-tests" }, passed: false }
  }
  // The ladder does NOT run the tests itself. It reports the targeted commands
  // and defers to the caller's runner; absent a runner this rung is unavailable.
  if (typeof input.runAffected !== "function") {
    return {
      attempt: { rung: VERIFICATION_RUNG.AFFECTED, status: "unavailable", reason: "no-affected-runner-provided", tests: tests.map((row) => row.path) },
      passed: false,
    }
  }
  const result = await input.runAffected({ tests, suggestedCommands: affected.suggestedCommands || [] })
  return {
    attempt: { rung: VERIFICATION_RUNG.AFFECTED, status: result?.passed === true ? "passed" : "failed", reason: result?.reason || null, tests: tests.map((row) => row.path) },
    passed: result?.passed === true,
    evidenceRef: result?.evidenceRef || null,
  }
}

export const verificationLadderExports = Object.freeze({
  planVerificationLadder,
  runVerificationLadder,
  requiredStrength,
  VERIFICATION_RUNG,
  EVIDENCE_STRENGTH,
  RUNG_ORDER,
})
