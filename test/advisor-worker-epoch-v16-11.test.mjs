// V16.11 lifecycle identity + stale-event gate tests.
//
// These prove the CONTRACT of lib/advisor-lifecycle-v16-11.mjs: three distinct
// lifecycles, epoch bumping, fail-closed reuse and stale-event rejection. They
// use no browser and no clock -- everything is deterministic.

import test from "node:test"
import assert from "node:assert/strict"

import {
  ADVISOR_LIFECYCLE_POLICY,
  ADVISOR_LIFECYCLE_SCHEMA_VERSION,
  advanceProfileEpoch,
  advanceWorkerEpoch,
  beginAdvisorRun,
  classifyStaleness,
  conversationReuseKey,
  createLifecycleIdentity,
  evaluateConversationReuse,
  isEventOwned,
  openConversation,
} from "../lib/advisor-lifecycle-v16-11.mjs"

test("lifecycle: identity carries the three distinct lifecycles", () => {
  const identity = createLifecycleIdentity({
    workerId: "w1",
    workerEpoch: 2,
    profileEpoch: 5,
    conversationId: "c1",
    conversationEpoch: 3,
    advisorRunId: "r1",
    runGeneration: 7,
    workspaceGeneration: 4,
  })
  assert.equal(identity.policy, ADVISOR_LIFECYCLE_POLICY)
  assert.equal(identity.schemaVersion, ADVISOR_LIFECYCLE_SCHEMA_VERSION)
  // worker / conversation / run are three separate identity planes
  assert.equal(identity.workerEpoch, 2)
  assert.equal(identity.conversationEpoch, 3)
  assert.equal(identity.runGeneration, 7)
})

test("lifecycle: recycling the worker invalidates the conversation but not the run", () => {
  const before = createLifecycleIdentity({ workerId: "w1", workerEpoch: 0, conversationId: "c1", conversationEpoch: 1, runGeneration: 4 })
  const after = advanceWorkerEpoch(before, { workerId: "w2" })
  assert.equal(after.workerEpoch, 1)
  assert.equal(after.conversationId, null, "a recycled worker must not keep the old conversation")
  assert.equal(after.conversationEpoch, 2, "the conversation epoch must advance")
  assert.equal(after.runGeneration, 4, "recycling a worker must NOT reset the run generation")
})

test("lifecycle: advancing the profile epoch clears the conversation", () => {
  const before = createLifecycleIdentity({ profileEpoch: 0, conversationId: "c1", conversationEpoch: 1 })
  const after = advanceProfileEpoch(before)
  assert.equal(after.profileEpoch, 1)
  assert.equal(after.conversationId, null)
})

test("lifecycle: beginning a run keeps worker and conversation lineage", () => {
  const base = openConversation(createLifecycleIdentity({ workerEpoch: 3, profileEpoch: 1 }), { conversationId: "c9" })
  const run = beginAdvisorRun(base, { advisorRunId: "run-x" })
  assert.equal(run.runGeneration, 1)
  assert.equal(run.workerEpoch, 3, "a new run must not touch the worker epoch")
  assert.equal(run.conversationId, "c9", "a new run on a warm worker keeps the conversation")
})

test("lifecycle: reuse requires the four-field key, not just the conversation id", () => {
  const identity = openConversation(createLifecycleIdentity({ workerId: "w1", workerEpoch: 2, profileEpoch: 1 }), { conversationId: "c1" })
  const key = conversationReuseKey(identity)
  assert.deepEqual(key, { conversationId: "c1", workerId: "w1", workerEpoch: 2, profileEpoch: 1 })

  const sameEpoch = evaluateConversationReuse({
    conversation: { conversationId: "c1", workerId: "w1", workerEpoch: 2, profileEpoch: 1 },
    current: identity,
  })
  assert.equal(sameEpoch.reuse, true)

  const staleWorker = evaluateConversationReuse({
    conversation: { conversationId: "c1", workerId: "w1", workerEpoch: 1, profileEpoch: 1 },
    current: identity,
  })
  assert.equal(staleWorker.reuse, false)
  assert.equal(staleWorker.reason, "worker-epoch-changed")
})

test("lifecycle: reuse fails closed on a closed or unhealthy conversation", () => {
  const identity = createLifecycleIdentity({ conversationId: "c1", workerEpoch: 1, profileEpoch: 0 })
  const closed = evaluateConversationReuse({
    conversation: { conversationId: "c1", workerEpoch: 1, profileEpoch: 0, closed: true },
    current: identity,
  })
  assert.equal(closed.reuse, false)
  assert.equal(closed.reason, "conversation-closed")

  const unhealthy = evaluateConversationReuse({
    conversation: { conversationId: "c1", workerEpoch: 1, profileEpoch: 0 },
    current: identity,
    health: { ok: false, reason: "page-crashed" },
  })
  assert.equal(unhealthy.reuse, false)
  assert.equal(unhealthy.reason, "page-crashed")
})

test("lifecycle: a stale event from an old worker epoch is discarded", () => {
  const current = createLifecycleIdentity({ workerEpoch: 3, conversationEpoch: 2, runGeneration: 5 })
  const verdict = classifyStaleness({ workerEpoch: 2, generation: 5 }, current)
  assert.equal(verdict.stale, true)
  assert.equal(verdict.reason, "worker-epoch-mismatch")
})

test("lifecycle: a stale event from an old generation is discarded", () => {
  const current = createLifecycleIdentity({ workerEpoch: 3, conversationEpoch: 2, runGeneration: 5 })
  const verdict = classifyStaleness({ workerEpoch: 3, generation: 4 }, current)
  assert.equal(verdict.stale, true)
  assert.equal(verdict.reason, "generation-mismatch")
})

test("lifecycle: an owned event passes the gate", () => {
  const current = createLifecycleIdentity({ workerEpoch: 3, profileEpoch: 1, conversationId: "c1", conversationEpoch: 2, runGeneration: 5 })
  const owned = classifyStaleness(
    { workerEpoch: 3, profileEpoch: 1, conversationId: "c1", conversationEpoch: 2, generation: 5 },
    current,
  )
  assert.equal(owned.stale, false)
  assert.equal(isEventOwned({ workerEpoch: 3, generation: 5 }, current), true)
})

test("lifecycle: a missing generation fails closed only when required", () => {
  const current = createLifecycleIdentity({ workerEpoch: 1, runGeneration: 2 })
  // A worker that does not send a generation is tolerated by default (older worker)...
  assert.equal(classifyStaleness({ workerEpoch: 1 }, current).stale, false)
  // ...but a terminal response that MUST carry one is refused.
  const required = classifyStaleness({ workerEpoch: 1 }, current, { requireGeneration: true })
  assert.equal(required.stale, true)
  assert.equal(required.reason, "missing-generation")
})

test("lifecycle: a late event after the run ended is discarded", () => {
  const current = createLifecycleIdentity({ workerEpoch: 1, runGeneration: 2 })
  const verdict = classifyStaleness({ workerEpoch: 1, generation: 2 }, current, { runActive: false })
  assert.equal(verdict.stale, true)
  assert.equal(verdict.reason, "run-not-active")
  // ...unless the caller is explicitly draining late output.
  assert.equal(classifyStaleness({ workerEpoch: 1, generation: 2 }, current, { runActive: false, allowLate: true }).stale, false)
})
