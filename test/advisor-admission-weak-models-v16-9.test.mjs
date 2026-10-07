// V16.9 ADMISSION FOR WEAK MODELS.
//
// The release directive requires that admission routing is DETERMINISTIC and
// does NOT depend on the model's self-reported confidence. A weak model that
// says "I am 99% sure" and a strong model that says "I am 1% sure" must route
// the SAME task identically, because the decision is made from MEASURED and
// DECLARED structural facts, never from prose or a self-score.
//
// This test drives the real `decideAdmission` / `rescoreAfterVerifier` owner
// over a representative routing matrix and asserts each class, then proves
// invariance to injected self-confidence.

import test from "node:test"
import assert from "node:assert/strict"
import {
  ADMISSION_REASON,
  ADMISSION_ROUTE,
  decideAdmission,
  rescoreAfterVerifier,
} from "../lib/advisor-admission.mjs"

/** The closed set of routes a task may take. */
const ROUTES = new Set(Object.values(ADMISSION_ROUTE))

/**
 * Every representative class the directive names, expressed ONLY as the
 * deterministic features the owner reads (never as prose the model authored).
 */
const MATRIX = [
  {
    name: "exact syntax error -> local/Pi (never a consultation)",
    input: { mode: "auto", task: "fix the syntax error: missing semicolon", deterministicProven: true },
    expect: [ADMISSION_ROUTE.LOCAL_DETERMINISTIC, ADMISSION_ROUTE.PI_ONLY],
  },
  {
    name: "exact type error -> local/Pi",
    input: { mode: "auto", task: "the type error is exact: expected string, got number", deterministicProven: true },
    expect: [ADMISSION_ROUTE.LOCAL_DETERMINISTIC, ADMISSION_ROUTE.PI_ONLY],
  },
  {
    name: "simple bounded one-file fix -> Pi",
    input: { mode: "auto", task: "rename a variable in one file", affectedSubsystems: 1, relevantFiles: ["src/a.mjs"] },
    expect: [ADMISSION_ROUTE.PI_ONLY],
  },
  {
    name: "cross-module unknown root cause -> advisor",
    input: { mode: "auto", affectedSubsystems: 3, rootCauseAmbiguous: true },
    expect: [ADMISSION_ROUTE.PI_PLUS_ADVISOR],
  },
  {
    name: "async/race/lifecycle -> advisor (cross-layer structural signal)",
    input: { mode: "auto", crossLayerDependency: true, rootCauseAmbiguous: true },
    expect: [ADMISSION_ROUTE.PI_PLUS_ADVISOR],
  },
  {
    name: "security/auth/payment -> advisor (architectural decision required)",
    input: { mode: "auto", architecturalDecisionRequired: true, crossLayerDependency: true },
    expect: [ADMISSION_ROUTE.PI_PLUS_ADVISOR],
  },
  {
    name: "verifier failed repeatedly -> advisor",
    input: { mode: "auto", verifierRetries: 2 },
    expect: [ADMISSION_ROUTE.PI_PLUS_ADVISOR],
  },
]

test("weak-model admission: every representative class routes deterministically", () => {
  for (const row of MATRIX) {
    const decision = decideAdmission(row.input)
    assert.ok(
      row.expect.includes(decision.route),
      `${row.name}: expected one of ${row.expect.join("/")}, got ${decision.route} (${decision.reason})`,
    )
    assert.ok(ROUTES.has(decision.route), `${row.name}: route must be from the closed vocabulary`)
    assert.equal(decision.mayProducePass, false, `${row.name}: admission never grants a pass`)
    assert.equal(decision.isToolInvocation, false, `${row.name}: admission is never a tool call`)
  }
})

test("weak-model admission: routing is INVARIANT to model self-confidence", () => {
  // A weak model often over-states confidence and a strong model under-states
  // it. Neither must move the route. We inject several spellings of a
  // self-confidence score and assert the route is unchanged for every class.
  const CONFIDENCE_SPELLINGS = [
    { selfConfidence: 0.99 },
    { selfConfidence: 0.01 },
    { modelConfidence: 0.99 },
    { modelConfidence: 0.01 },
    { confidence: 0.99 },
    { confidence: 0.01 },
    { modelSelfConfidence: 0.99 },
    { modelSelfConfidence: 0.01 },
  ]
  for (const row of MATRIX) {
    const baseline = decideAdmission(row.input)
    for (const spell of CONFIDENCE_SPELLINGS) {
      const withConfidence = decideAdmission({ ...row.input, ...spell })
      assert.equal(
        withConfidence.route,
        baseline.route,
        `${row.name}: self-confidence ${JSON.stringify(spell)} must not change the route`,
      )
    }
  }
})

test("weak-model admission: a deterministic proof found AFTER the advisor started de-escalates", () => {
  // The advisor was admitted on a signal, then the local verifier produced a
  // deterministic proof. The re-score must drop the advisor (abort/cancel the
  // consultation) rather than keep paying for it.
  const admitted = decideAdmission({ mode: "auto", affectedSubsystems: 3, rootCauseAmbiguous: true })
  assert.equal(admitted.route, ADMISSION_ROUTE.PI_PLUS_ADVISOR)
  const rescored = rescoreAfterVerifier(admitted, { accepted: true }, {})
  assert.equal(rescored.route, ADMISSION_ROUTE.PI_ONLY)
  assert.equal(rescored.reason, ADMISSION_REASON.VERIFIER_ACCEPTED)
  assert.equal(rescored.rescored, true)
})

test("weak-model admission: re-score after verifier FEEDBACK is dynamic (reject -> bounded retry)", () => {
  const admitted = decideAdmission({ mode: "auto", affectedSubsystems: 3, ambiguity: 2, verifierRetries: 2 })
  assert.equal(admitted.route, ADMISSION_ROUTE.PI_PLUS_ADVISOR)
  const retried = rescoreAfterVerifier(admitted, { rejected: true }, { followUpsSent: 1 })
  assert.equal(retried.route, ADMISSION_ROUTE.ADVISOR_RETRY)
  assert.equal(retried.retry.allowed, true)
  // A second rejection with no remaining budget must NOT loop forever.
  const exhausted = rescoreAfterVerifier(retried, { rejected: true }, { followUpsSent: 2, submitBudgetAllows: false })
  assert.equal(exhausted.route, ADMISSION_ROUTE.PI_ONLY)
  assert.equal(exhausted.retry.allowed, false)
})

test("weak-model admission: no route ever consults on a no-signal task regardless of confidence", () => {
  const noSignal = { mode: "auto", task: "rename a variable", affectedSubsystems: 0 }
  for (const spell of [{ selfConfidence: 0.99 }, { confidence: 1 }, { modelConfidence: 0.99 }]) {
    const decision = decideAdmission({ ...noSignal, ...spell })
    assert.equal(decision.route, ADMISSION_ROUTE.PI_ONLY)
    assert.equal(decision.consultAdvisor, false)
  }
})
