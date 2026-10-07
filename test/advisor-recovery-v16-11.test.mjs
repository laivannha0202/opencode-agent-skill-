// V16.11 advisor recovery + duplicate-submit prevention tests.
//
// These prove the recovery DECISION (bounded, fail-closed, stale-event-aware) and
// the single-flight submit guard (a recovery can never double-submit). No browser.

import test from "node:test"
import assert from "node:assert/strict"

import {
  ADVISOR_RECOVERY_POLICY,
  RECOVERY_ACTION,
  RECOVERY_FAILURE,
  RECOVERY_MAX_TOTAL_ATTEMPTS,
  classifyFailureKind,
  createSubmitGuard,
  planRecovery,
} from "../lib/advisor-recovery-v16-11.mjs"

test("recovery: a worker crash recycles the worker", () => {
  const plan = planRecovery({ failureKind: RECOVERY_FAILURE.WORKER_CRASH, attempts: { total: 0, byKind: {} } })
  assert.equal(plan.recover, true)
  assert.equal(plan.action, RECOVERY_ACTION.RECYCLE_WORKER)
  assert.equal(plan.needsFreshWorker, true)
})

test("recovery: an auth failure requires reauth but preserves the conversation", () => {
  const plan = planRecovery({ failureKind: RECOVERY_FAILURE.AUTH_EXPIRED, attempts: {}, authAvailable: true })
  assert.equal(plan.action, RECOVERY_ACTION.REAUTH)
  assert.equal(plan.needsAuth, true)
  assert.equal(plan.needsFreshWorker, false)
})

test("recovery: a navigation redirect reopens the conversation", () => {
  const plan = planRecovery({ event: "navigation.redirect", attempts: {} })
  assert.equal(plan.failureKind, RECOVERY_FAILURE.NAVIGATION_REDIRECT)
  assert.equal(plan.action, RECOVERY_ACTION.REOPEN_CONVERSATION)
})

test("recovery: an unknown failure is NOT retried (fail-closed)", () => {
  const plan = planRecovery({ failureKind: RECOVERY_FAILURE.UNKNOWN, attempts: {} })
  assert.equal(plan.recover, false)
  assert.equal(plan.reason, "non-recoverable-failure")
})

test("recovery: the total attempt budget is enforced", () => {
  const plan = planRecovery({ failureKind: RECOVERY_FAILURE.WORKER_CRASH, attempts: { total: RECOVERY_MAX_TOTAL_ATTEMPTS, byKind: {} } })
  assert.equal(plan.recover, false)
  assert.equal(plan.reason, "total-recovery-budget-exhausted")
})

test("recovery: the per-kind budget is enforced", () => {
  const plan = planRecovery({ failureKind: RECOVERY_FAILURE.AUTH_EXPIRED, attempts: { total: 1, byKind: { [RECOVERY_FAILURE.AUTH_EXPIRED]: 2 } }, authAvailable: true })
  assert.equal(plan.recover, false)
  assert.match(plan.reason, /per-kind-recovery-budget-exhausted/)
})

test("recovery: a stale late event NEVER drives a recovery", () => {
  const current = { workerEpoch: 5, conversationEpoch: 2, runGeneration: 3 }
  const plan = planRecovery({
    failureKind: RECOVERY_FAILURE.PAGE_CRASH,
    attempts: {},
    lateEvent: { workerEpoch: 4, generation: 3 },
    current,
  })
  assert.equal(plan.recover, false)
  assert.match(plan.reason, /stale-event/)
})

test("recovery: a duplicate-submit suspicion forces a worker recycle instead of a same-worker retry", () => {
  const plan = planRecovery({ failureKind: RECOVERY_FAILURE.READ_FAILURE, attempts: {}, duplicateSubmitSuspected: true })
  assert.equal(plan.action, RECOVERY_ACTION.RECYCLE_WORKER)
  assert.equal(plan.needsFreshWorker, true)
})

test("recovery: an unavailable reauth path fails closed", () => {
  const plan = planRecovery({ failureKind: RECOVERY_FAILURE.AUTH_LOGIN_REQUIRED, attempts: {}, authAvailable: false })
  assert.equal(plan.recover, false)
  assert.equal(plan.reason, "reauth-unavailable")
})

test("recovery: failure kinds classify from a transport event", () => {
  assert.equal(classifyFailureKind({ event: "auth.expired" }), RECOVERY_FAILURE.AUTH_EXPIRED)
  assert.equal(classifyFailureKind({ event: "page.crashed" }), RECOVERY_FAILURE.PAGE_CRASH)
  assert.equal(classifyFailureKind({ event: "navigation.redirect" }), RECOVERY_FAILURE.NAVIGATION_REDIRECT)
  assert.equal(classifyFailureKind({ reason: "worker exited unexpectedly" }), RECOVERY_FAILURE.WORKER_CRASH)
})

test("submit-guard: a prompt can be claimed exactly once", () => {
  const guard = createSubmitGuard()
  const identity = { workerEpoch: 1, conversationEpoch: 1, runGeneration: 1 }
  const first = guard.claim({ promptId: "p1", identity })
  assert.equal(first.allowed, true)
  const second = guard.claim({ promptId: "p1", identity })
  assert.equal(second.allowed, false)
  assert.equal(second.reason, "submit-in-flight")
})

test("submit-guard: a completed prompt is refused on re-submit", () => {
  const guard = createSubmitGuard()
  const identity = { workerEpoch: 1, conversationEpoch: 1, runGeneration: 1 }
  guard.claim({ promptId: "p2", identity })
  guard.complete({ promptId: "p2", identity })
  const again = guard.claim({ promptId: "p2", identity })
  assert.equal(again.allowed, false)
  assert.equal(again.reason, "already-submitted")
})

test("submit-guard: a recovered (released) claim CAN be re-submitted", () => {
  const guard = createSubmitGuard()
  const identity = { workerEpoch: 1, conversationEpoch: 1, runGeneration: 1 }
  guard.claim({ promptId: "p3", identity })
  guard.release({ promptId: "p3", identity })
  const again = guard.claim({ promptId: "p3", identity })
  assert.equal(again.allowed, true, "a recoverable failure must allow a legitimate retry")
})

test("submit-guard: a fresh worker epoch is a NEW key and IS allowed", () => {
  const guard = createSubmitGuard()
  const before = { workerEpoch: 1, conversationEpoch: 1, runGeneration: 1 }
  guard.claim({ promptId: "p4", identity: before })
  guard.complete({ promptId: "p4", identity: before })
  const after = { workerEpoch: 2, conversationEpoch: 2, runGeneration: 1 }
  const fresh = guard.claim({ promptId: "p4", identity: after })
  assert.equal(fresh.allowed, true, "a retry on a fresh worker is a genuinely new submit")
})

test("submit-guard: the policy id is stable", () => {
  assert.equal(ADVISOR_RECOVERY_POLICY, "advisor-recovery-v16-11")
})
