// V16.9 module tests: advisor-admission + advisor-dialogue-coordinator.
//
// These two modules decide WHETHER and HOW MANY TIMES the advisor is consulted.
// The tests assert the invariants: a deterministic proof never admits the
// advisor, a negative historical weight de-escalates AUTO, a verifier rejection
// can request exactly ONE bounded retry, and no two advisor turns run at once.

import test from "node:test"
import assert from "node:assert/strict"
import {
  ADMISSION_REASON,
  ADMISSION_ROUTE,
  ADVISOR_ADMISSION_POLICY,
  decideAdmission,
  extractAdmissionFeatures,
  rescoreAfterVerifier,
} from "../lib/advisor-admission.mjs"
import {
  ADVISOR_DIALOGUE_POLICY,
  DIALOGUE_REASON,
  createAdvisorDialogueCoordinator,
} from "../lib/advisor-dialogue-coordinator.mjs"
import { recordAdvisorOutcome, resetAdvisorLearnerForTests } from "../lib/advisor-benefit-learner.mjs"

test("admission: deterministic proof routes local without consulting", () => {
  const decision = decideAdmission({ mode: "auto", deterministicProven: true })
  assert.equal(decision.route, ADMISSION_ROUTE.LOCAL_DETERMINISTIC)
  assert.equal(decision.consultAdvisor, false)
  assert.equal(decision.reason, ADMISSION_REASON.DETERMINISTIC_PROOF)
})

test("admission: mode off routes pi-only", () => {
  const decision = decideAdmission({ mode: "off" })
  assert.equal(decision.route, ADMISSION_ROUTE.PI_ONLY)
  assert.equal(decision.reason, ADMISSION_REASON.MODE_OFF)
})

test("admission: no signal routes pi-only", () => {
  const decision = decideAdmission({ mode: "auto", task: "rename a variable" })
  assert.equal(decision.route, ADMISSION_ROUTE.PI_ONLY)
  assert.equal(decision.consultAdvisor, false)
})

test("admission: grounded structural signal admits the advisor", () => {
  const decision = decideAdmission({ mode: "auto", affectedSubsystems: 3 })
  assert.equal(decision.route, ADMISSION_ROUTE.PI_PLUS_ADVISOR)
  assert.equal(decision.consultAdvisor, true)
  assert.equal(decision.mayProducePass, false)
  assert.equal(decision.isToolInvocation, false)
})

test("admission: feature extractor matches canonical structural field names", () => {
  const { features } = extractAdmissionFeatures({ affectedSubsystems: 3, verifierRetries: 2, crossLayerDependency: true })
  assert.equal(features.subsystems, 3)
  assert.equal(features.failedAttempts, 2)
  assert.equal(features.verifierRepeatedFailure, true)
  assert.equal(features.crossLayer, true)
})

test("admission: negative historical weight de-escalates AUTO", () => {
  resetAdvisorLearnerForTests()
  const sample = { taskClass: "refactor", subsystemBucket: "s2", ambiguityClass: "low", failureClass: "none", provider: "deepseek-web" }
  for (let i = 0; i < 10; i += 1) {
    recordAdvisorOutcome({ ...sample, consulted: true, accepted: false, verifiedPass: false })
  }
  const decision = decideAdmission({ mode: "auto", affectedSubsystems: 3, learnerSample: sample })
  assert.equal(decision.route, ADMISSION_ROUTE.PI_ONLY)
  assert.equal(decision.reason, ADMISSION_REASON.NEGATIVE_BENEFIT)
  resetAdvisorLearnerForTests()
})

test("admission: FORCE is never de-escalated by history", () => {
  resetAdvisorLearnerForTests()
  const sample = { taskClass: "force", subsystemBucket: "s3", ambiguityClass: "low", failureClass: "none", provider: "deepseek-web" }
  for (let i = 0; i < 10; i += 1) {
    recordAdvisorOutcome({ ...sample, consulted: true, accepted: false, verifiedPass: false })
  }
  const decision = decideAdmission({ mode: "force", learnerSample: sample })
  assert.equal(decision.route, ADMISSION_ROUTE.PI_PLUS_ADVISOR)
  resetAdvisorLearnerForTests()
})

test("admission: verifier rejection requests ONE bounded retry", () => {
  const previous = decideAdmission({ mode: "auto", affectedSubsystems: 3, ambiguity: 2, verifierRetries: 2 })
  const rescored = rescoreAfterVerifier(previous, { rejected: true }, { followUpsSent: 1 })
  assert.equal(rescored.route, ADMISSION_ROUTE.ADVISOR_RETRY)
  assert.equal(rescored.reason, ADMISSION_REASON.RETRY_BUDGET_AVAILABLE)
  assert.equal(rescored.retry.allowed, true)
})

test("admission: verifier acceptance de-escalates to pi-only", () => {
  const previous = decideAdmission({ mode: "force" })
  const rescored = rescoreAfterVerifier(previous, { accepted: true }, {})
  assert.equal(rescored.route, ADMISSION_ROUTE.PI_ONLY)
  assert.equal(rescored.reason, ADMISSION_REASON.VERIFIER_ACCEPTED)
})

test("admission: rejection with low benefit de-escalates rather than retries", () => {
  const previous = decideAdmission({ mode: "auto", affectedSubsystems: 3 })
  const rescored = rescoreAfterVerifier(previous, { rejected: true }, { followUpsSent: 1, benefitExceedsCost: false })
  assert.equal(rescored.route, ADMISSION_ROUTE.PI_ONLY)
})

test("dialogue: consult is sent once; a second consult is refused", () => {
  const dialogue = createAdvisorDialogueCoordinator({ maxFollowUps: 1 })
  assert.equal(dialogue.mayConsult().ok, true)
  dialogue.noteConsultDispatched({ files: { a: "1" }, diff: "x", fingerprint: "f1" })
  const second = dialogue.mayConsult()
  assert.equal(second.ok, false)
  assert.equal(second.reason, DIALOGUE_REASON.CONSULT_ALREADY_SENT)
})

test("dialogue: follow-up requires a real changed delta", () => {
  const dialogue = createAdvisorDialogueCoordinator({ maxFollowUps: 1 })
  dialogue.noteConsultDispatched({ files: { a: "1" }, diff: "x", fingerprint: "f1" })
  const noChange = dialogue.mayFollowUp({ files: { a: "1" }, diff: "x", fingerprint: "f1" })
  assert.equal(noChange.ok, false)
  assert.equal(noChange.reason, DIALOGUE_REASON.NO_DELTA)
  const changed = dialogue.mayFollowUp({ files: { a: "2" }, diff: "y", fingerprint: "f2" })
  assert.equal(changed.ok, true)
})

test("dialogue: a turn in flight refuses a concurrent turn (single-flight invariant)", () => {
  const dialogue = createAdvisorDialogueCoordinator({ maxFollowUps: 1 })
  dialogue.noteConsultDispatched({ files: { a: "1" }, diff: "x", fingerprint: "f1" })
  const token = dialogue.beginTurn("follow-up")
  assert.equal(token.ok, true)
  assert.equal(dialogue.isTurnInFlight(), true)
  const concurrent = dialogue.beginTurn("consult")
  assert.equal(concurrent.ok, false)
  assert.equal(concurrent.reason, DIALOGUE_REASON.TURN_IN_FLIGHT)
  dialogue.endTurn(token.token)
  assert.equal(dialogue.isTurnInFlight(), false)
})

test("dialogue: hard follow-up ceiling is enforced", () => {
  const dialogue = createAdvisorDialogueCoordinator({ maxFollowUps: 1 })
  dialogue.noteConsultDispatched({ files: { a: "1" }, diff: "x", fingerprint: "f1" })
  dialogue.mayFollowUp({ files: { a: "2" }, diff: "y", fingerprint: "f2" })
  dialogue.noteFollowUpDispatched({ files: { a: "2" }, diff: "y", fingerprint: "f2" })
  const again = dialogue.mayFollowUp({ files: { a: "3" }, diff: "z", fingerprint: "f3" })
  assert.equal(again.ok, false)
  assert.equal(again.reason, DIALOGUE_REASON.BUDGET_EXHAUSTED)
})

test("policies are stable", () => {
  assert.equal(ADVISOR_ADMISSION_POLICY, "advisor-admission-v16-9")
  assert.equal(ADVISOR_DIALOGUE_POLICY, "advisor-dialogue-coordinator-v16-9")
})
