// V16.11 advisor runtime production integration tests.
//
// These drive the ONE production composition the shipped extension hydrates
// through `LAZY_RUNTIME_MODULES.ADVISOR_RUNTIME`. They prove the composition
// wires the single lifecycle owner to the event bridge, the recovery coordinator
// and the latency metrics -- and that a warm worker is reused, a stale event is
// refused, and a duplicate submit is blocked. No browser.

import test from "node:test"
import assert from "node:assert/strict"

import { LAZY_RUNTIME_MODULES, hydrateRuntimeModule, resetLazyRuntimeForTests } from "../lib/lazy-runtime.mjs"

async function runtimeModule() {
  resetLazyRuntimeForTests()
  return hydrateRuntimeModule(LAZY_RUNTIME_MODULES.ADVISOR_RUNTIME)
}

function workerDouble() {
  let acquired = 0
  let released = 0
  const state = { healthy: true }
  return {
    state,
    counts: () => ({ acquired, released }),
    acquire: async () => {
      acquired += 1
      return { workerId: `w${acquired}`, async close() { released += 1 } }
    },
    health: async () => (state.healthy ? { ok: true } : { ok: false, reason: "page-crashed" }),
  }
}

test("runtime: the production module is reachable through the lazy stack", async () => {
  const mod = await runtimeModule()
  assert.equal(typeof mod.createAdvisorRuntime, "function")
  assert.equal(mod.ADVISOR_RUNTIME_POLICY, "advisor-runtime-v16-11")
})

test("runtime: the first consult is COLD, the second is WARM and reuses the worker", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r1",
    turnBudget: 3,
    eventChannel: true,
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  const first = await runtime.beginConsult({ promptId: "p1" })
  assert.equal(first.ok, true)
  assert.equal(first.workerState, "cold")
  runtime.completeConsult(first, { advisorText: "a" })
  const second = await runtime.beginConsult({ promptId: "p2" })
  assert.equal(second.workerState, "warm")
  assert.equal(worker.counts().acquired, 1, "the second consult must reuse the warm worker")
})

test("runtime: an accepted event answer produces an event-channel latency sample", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r2",
    turnBudget: 3,
    eventChannel: true,
    parseAnswer: (text) => ({ ok: true, value: { text } }),
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  const consult = await runtime.beginConsult({ promptId: "p3", baseline: {} })
  const { decodeTransportMessage, BROWSER_EVENT } = await import("../lib/browser-transport-v16-11.mjs")
  const event = decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_STABLE, data: { text: '{"a":1}' }, workerEpoch: consult.workerEpoch, generation: consult.runGeneration })
  const observed = runtime.observeEvent(consult, event)
  assert.equal(observed.done, true)
  runtime.completeConsult(consult)
  const sample = runtime.lastSample()
  assert.equal(sample.channel, "event")
  assert.equal(sample.workerState, "cold")
})

test("runtime: a stale event from an old worker epoch is refused before the bridge", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r3",
    turnBudget: 3,
    eventChannel: true,
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  const consult = await runtime.beginConsult({ promptId: "p4" })
  const { decodeTransportMessage, BROWSER_EVENT } = await import("../lib/browser-transport-v16-11.mjs")
  const stale = decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_STABLE, data: { text: "old" }, workerEpoch: consult.workerEpoch - 1, generation: consult.runGeneration })
  const observed = runtime.observeEvent(consult, stale)
  assert.equal(observed.handled, false)
  assert.equal(observed.stale, true)
})

test("runtime: re-claiming an in-flight consult submit is refused (no double submit)", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r4",
    turnBudget: 3,
    eventChannel: true,
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  const consult = await runtime.beginConsult({ promptId: "same" })
  assert.equal(consult.submitAllowed, true)
  // A retry loop re-claiming the SAME in-flight consult must be refused.
  const reclaim = runtime.claimSubmit(consult)
  assert.equal(reclaim.allowed, false)
  assert.equal(reclaim.reason, "submit-in-flight")
  // After completion the same consult is spent too.
  runtime.completeSubmit(consult)
  const afterComplete = runtime.claimSubmit(consult)
  assert.equal(afterComplete.allowed, false)
})

test("runtime: a worker crash recovery recycles the worker and advances the epoch", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r5",
    turnBudget: 3,
    eventChannel: true,
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  const consult = await runtime.beginConsult({ promptId: "p5" })
  const beforeEpoch = consult.workerEpoch
  const plan = await runtime.onFailure(consult, { failureKind: "worker-crash" })
  assert.equal(plan.recover, true)
  assert.equal(plan.action, "recycle-worker")
  const retry = await runtime.beginConsult({ promptId: "p5" })
  assert.equal(retry.workerEpoch, beforeEpoch + 1, "recovery must advance the worker epoch")
  assert.equal(retry.submitAllowed, true, "a retry on a fresh worker is a genuinely new submit")
})

test("runtime: a non-recoverable failure is fail-closed and does not advance the budget", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r6",
    turnBudget: 3,
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  const consult = await runtime.beginConsult({ promptId: "p6" })
  const plan = await runtime.onFailure(consult, { failureKind: "unknown" })
  assert.equal(plan.recover, false)
  assert.equal(runtime.state().attempts.total, 0, "a refused recovery must not spend the budget")
})

test("runtime: shutdown releases the worker and is idempotent", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r7",
    turnBudget: 3,
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  await runtime.beginConsult({ promptId: "p7" })
  const first = await runtime.shutdown("done")
  assert.equal(first.workerReleased, true)
  assert.equal(worker.counts().released, 1)
  const second = await runtime.shutdown("again")
  assert.equal(second.alreadyShutdown, true)
  assert.equal(worker.counts().released, 1)
})

test("runtime: a simulated run never claims a live measurement", async () => {
  const mod = await runtimeModule()
  const worker = workerDouble()
  const runtime = mod.createAdvisorRuntime({
    runId: "r8",
    turnBudget: 3,
    eventChannel: true,
    latencyProvenance: "SIMULATED",
    parseAnswer: (text) => ({ ok: true, value: { text } }),
    acquireWorker: () => worker.acquire(),
    releaseWorker: (l) => l.close(),
    healthCheck: () => worker.health(),
  })
  const consult = await runtime.beginConsult({ promptId: "p8", baseline: {} })
  const { decodeTransportMessage, BROWSER_EVENT } = await import("../lib/browser-transport-v16-11.mjs")
  runtime.observeEvent(consult, decodeTransportMessage({ type: "event", event: BROWSER_EVENT.ANSWER_STABLE, data: { text: "{}" }, workerEpoch: consult.workerEpoch, generation: consult.runGeneration }))
  runtime.completeConsult(consult)
  assert.equal(runtime.metrics().claimStatus, "SIMULATED_ONLY")
})
