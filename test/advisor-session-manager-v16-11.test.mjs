// V16.11 advisor session manager tests: the SINGLE lifecycle owner.
//
// These prove that one manager owns all three lifecycles (worker / conversation
// / run), reuses a warm worker, recycles on health/epoch failure, gates stale
// events, and shuts down idempotently. The browser is replaced by a deterministic
// injected double: the manager owns the LEASE, the double owns the process.

import test from "node:test"
import assert from "node:assert/strict"

import {
  ADVISOR_SESSION_MANAGER_IMPLEMENTATION,
  ADVISOR_SESSION_MANAGER_POLICY,
  ADVISOR_SESSION_MANAGER_SCHEMA_VERSION,
  createAdvisorSessionManager,
} from "../lib/advisor-session-manager.mjs"

/** A deterministic worker double that counts acquire/release and can fail health. */
function workerDouble(options = {}) {
  let acquired = 0
  let released = 0
  const leases = []
  const state = { healthy: options.healthy !== false, failAcquire: options.failAcquire === true }
  return {
    state,
    counts: () => ({ acquired, released, live: leases.length }),
    async acquire() {
      if (state.failAcquire) throw new Error("browser launch failed")
      acquired += 1
      const lease = { workerId: `w${acquired}`, closed: false, async close() { this.closed = true; released += 1; leases.pop() } }
      leases.push(lease)
      return lease
    },
    async health() {
      return state.healthy ? { ok: true } : { ok: false, reason: "page-crashed" }
    },
  }
}

test("session-manager: the module keeps its stable policy id and evolves the schema", () => {
  const manager = createAdvisorSessionManager({ id: "s0", turnBudget: 3 })
  assert.equal(manager.policy, ADVISOR_SESSION_MANAGER_POLICY)
  assert.equal(ADVISOR_SESSION_MANAGER_POLICY, "advisor-session-manager-v16-9")
  assert.equal(ADVISOR_SESSION_MANAGER_IMPLEMENTATION, "advisor-session-manager-v16-11")
  assert.equal(ADVISOR_SESSION_MANAGER_SCHEMA_VERSION, 2)
  assert.equal(manager.implementation, "advisor-session-manager-v16-11")
})

test("session-manager: acquiring a worker advances the worker epoch", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s1", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  assert.equal(manager.identity().workerEpoch, 0)
  const first = await manager.acquireWorker()
  assert.equal(first.ok, true)
  assert.equal(first.reused, false)
  assert.equal(first.workerEpoch, 1, "a fresh worker is a new epoch")
  assert.equal(manager.identity().workerEpoch, 1)
})

test("session-manager: a healthy worker is REUSED warm, not re-acquired", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s2", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  const first = await manager.acquireWorker()
  const second = await manager.acquireWorker()
  assert.equal(second.reused, true)
  assert.equal(second.workerEpoch, first.workerEpoch, "reuse must not advance the worker epoch")
  assert.equal(worker.counts().acquired, 1, "the worker must be acquired exactly once")
})

test("session-manager: an unhealthy worker is recycled and the epoch advances", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s3", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  const first = await manager.acquireWorker()
  worker.state.healthy = false
  const second = await manager.acquireWorker()
  assert.equal(second.reused, false)
  assert.equal(second.workerEpoch, first.workerEpoch + 1, "recycling is a new epoch")
  assert.equal(worker.counts().acquired, 2)
  assert.equal(worker.counts().released, 1, "the old worker must be released, not leaked")
})

test("session-manager: recycleIfNeeded honours the reuse ceiling", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s4", turnBudget: 5, maxReuseCount: 1, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  await manager.acquireWorker() // one reuse -> reuseCount = 1
  const recycle = await manager.recycleIfNeeded()
  assert.equal(recycle.recycled, true)
  assert.equal(recycle.reason, "max-reuse-count")
  assert.equal(manager.workerLease(), null)
})

test("session-manager: a missing worker provider never invents a worker", async () => {
  const manager = createAdvisorSessionManager({ id: "s5", turnBudget: 3 })
  const result = await manager.acquireWorker()
  assert.equal(result.ok, false)
  assert.equal(result.reason, "no-worker-provider")
})

test("session-manager: closing a conversation does NOT release the worker", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s6", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  manager.openConversation()
  const closed = manager.closeConversation("done")
  assert.equal(closed.closed, true)
  assert.equal(closed.workerLeaseRetained, true, "ending a conversation must never kill a warm worker")
  assert.equal(worker.counts().released, 0)
})

test("session-manager: recycling the worker invalidates conversation reuse", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s7", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  manager.openConversation()
  const reusable = await manager.reuseConversation({ health: { ok: true } })
  assert.equal(reusable.reuse, true)

  worker.state.healthy = false
  await manager.acquireWorker() // recycle -> new worker epoch, conversation cleared
  const afterRecycle = await manager.reuseConversation({ health: { ok: true } })
  assert.equal(afterRecycle.reuse, false)
  assert.match(afterRecycle.reason, /conversation|worker-epoch/)
})

test("session-manager: a stale event from an old worker epoch is discarded and counted", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s8", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  manager.beginAdvisorRun()
  const stale = manager.acceptEvent({ workerEpoch: 0, generation: manager.identity().runGeneration })
  assert.equal(stale.stale, true)
  assert.equal(manager.state().metrics.staleEventDiscarded, 1)
})

test("session-manager: an owned event passes the gate", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s9", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  const run = manager.beginAdvisorRun()
  const verdict = manager.acceptEvent({ workerEpoch: manager.identity().workerEpoch, generation: run.runGeneration })
  assert.equal(verdict.stale, false)
  assert.equal(manager.state().metrics.staleEventDiscarded, 0)
})

test("session-manager: beginning a run does not touch the worker epoch", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s10", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  const workerEpoch = manager.identity().workerEpoch
  const run = manager.beginAdvisorRun()
  assert.equal(manager.identity().workerEpoch, workerEpoch, "a run must not recycle the worker")
  assert.equal(run.runGeneration, 1)
  manager.endAdvisorRun()
  assert.equal(manager.isRunActive(), false)
})

test("session-manager: shutdown is idempotent and releases the worker once", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s11", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  const first = await manager.shutdown("done")
  assert.equal(first.shutdown, true)
  assert.equal(first.workerReleased, true)
  assert.equal(worker.counts().released, 1)
  const second = await manager.shutdown("done-again")
  assert.equal(second.alreadyShutdown, true)
  assert.equal(worker.counts().released, 1, "a second shutdown must not double-release")
})

test("session-manager: the turn gate still enforces the budget", () => {
  const manager = createAdvisorSessionManager({ id: "s12", turnBudget: 2 })
  assert.equal(manager.maySend("consult").allowed, true)
  manager.recordTurn("consult", { advisorText: "a" })
  manager.recordTurn("follow-up", { advisorText: "b" })
  const third = manager.maySend("consult")
  assert.equal(third.allowed, false)
  assert.match(third.reason, /turn-budget-exhausted/)
})

test("session-manager: a worker crash is noted and the lease is dropped", async () => {
  const worker = workerDouble()
  const manager = createAdvisorSessionManager({ id: "s13", turnBudget: 3, acquireWorker: () => worker.acquire(), releaseWorker: (l) => l.close(), healthCheck: () => worker.health() })
  await manager.acquireWorker()
  manager.noteWorkerCrash("page-crashed")
  assert.equal(manager.workerLease(), null)
  assert.equal(manager.state().metrics.workerCrashes, 1)
})
