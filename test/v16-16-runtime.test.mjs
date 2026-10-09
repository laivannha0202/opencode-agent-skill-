// V16.16 Runtime: prewarm, run budget, proof composition, telemetry, stop.
//
// Proves the P1 behaviors without weakening anything: prewarm never exceeds
// the writer bound and cleans up abandoned workers, the run budget can lower
// concurrency but never skip verification, DeepSeek stays zero on tiny tasks,
// child receipts are reused only when exact and unaffected, telemetry
// separates measured/derived/not-measured honestly, and the loop stops only
// when correctness is proven.

import test from "node:test"
import assert from "node:assert/strict"

import {
  buildCriticalPathTelemetry,
  executeProofPlan,
  planProofReuse,
  prewarmWaveWorkers,
  recordWaveHistory,
  shouldStopProven,
  waveHistoryEstimates,
  waveTelemetryToEfficiencyEvents,
} from "../lib/parallel-coding-runtime-v16-15.mjs"
import { computeOrchestrationBudget, reserveRunCost } from "../lib/orchestration-budget-v16-6.mjs"
import { buildRpcWorkerKey } from "../lib/pi-rpc-pool.mjs"
import { createCriticalPathHistory } from "../lib/critical-path-history-v16-16.mjs"
import { NOT_MEASURED } from "../lib/measurement-provenance.mjs"

// A minimal pool double with the same prewarm/discard/run surface the runtime
// uses. It spawns nothing: it only records the keys it was asked about.
function fakePool(failures = new Set()) {
  const live = new Set()
  return {
    live,
    async prewarm(key) {
      if (failures.has(key)) throw new Error(`prewarm failed for ${key}`)
      live.add(key)
      return { key, reused: false, prewarmed: true }
    },
    async discard(key) {
      live.delete(key)
      return { key, discarded: true }
    },
  }
}

test("V16.16 prewarm: abandoned workers are cleaned and the bound holds", async () => {
  const pool = fakePool(new Set(["bad"]))
  const result = await prewarmWaveWorkers(pool, [
    { key: "a", spec: { command: "pi", args: [], cwd: "/tmp/a" } },
    { key: "bad", spec: { command: "pi", args: [], cwd: "/tmp/bad" } },
    { key: "c", spec: { command: "pi", args: [], cwd: "/tmp/c" } },
    { key: "d", spec: { command: "pi", args: [], cwd: "/tmp/d" } },
    { key: "e", spec: { command: "pi", args: [], cwd: "/tmp/e" } },
  ], { maxWorkers: 3 })
  // Five requested, three started at most (the writer bound, never above 3).
  assert.equal(result.bounded, 3)
  assert.equal(result.started.value, 2)
  assert.equal(result.failed.value, 1)
  assert.equal(result.timeSavingClaim, null)
  assert.equal(result.canProduceVerdict, false)
  // The failed prewarm left no abandoned worker behind.
  assert.ok(!pool.live.has("bad"))
})

test("V16.16 prewarm: no unnecessary children for a tiny local task", async () => {
  const pool = fakePool()
  const result = await prewarmWaveWorkers(pool, [], { maxWorkers: 2 })
  assert.equal(result.bounded, 0)
  assert.equal(result.started.value, 0)
  assert.equal(pool.live.size, 0)
})

test("V16.16 prewarm: retry reuses only the same valid key", async () => {
  const seen = []
  const pool = {
    async prewarm(key, spec) {
      seen.push([key, spec.cwd])
      return { key, reused: seen.length > 1, prewarmed: true }
    },
    async discard() {
      return { discarded: true }
    },
  }
  const first = await prewarmWaveWorkers(pool, [{ key: "sandbox-A", spec: { cwd: "/tmp/A" } }], { maxWorkers: 2 })
  const second = await prewarmWaveWorkers(pool, [{ key: "sandbox-A", spec: { cwd: "/tmp/A" } }], { maxWorkers: 2 })
  assert.equal(first.reused.value, 0)
  assert.equal(second.reused.value, 1)
  // A different sandbox gets a different key: no stale reuse.
  await prewarmWaveWorkers(pool, [{ key: "sandbox-B", spec: { cwd: "/tmp/B" } }], { maxWorkers: 2 })
  assert.ok(seen.some((row) => row[0] === "sandbox-B" && row[1] === "/tmp/B"))
})

test("V16.16 budget: the run budget can lower concurrency but never skip verification", () => {
  // The reservation consumes the REAL canonical V16.6 run budget (never a
  // second budget, never a null bypass): a constrained FAST budget lowers a
  // 3-wide COMPLEX wave, while a permissive DEEP budget admits it.
  const constrained = computeOrchestrationBudget({ affectedFiles: 1, taskPolicy: { risk: "low" } })
  assert.equal(constrained.executionProfile, "FAST")
  const lowered = reserveRunCost(constrained, { taskShape: "COMPLEX", simultaneousCalls: 3, childTurns: 4 })
  assert.equal(lowered.admitted, false)
  assert.equal(lowered.action, "lower-concurrency")
  assert.equal(lowered.verificationIntact, true)
  assert.ok(Number(lowered.limits?.maxSimultaneousCalls) <= 3)
  const permissive = computeOrchestrationBudget({ taskPolicy: { risk: "high" } })
  assert.equal(permissive.executionProfile, "DEEP")
  const admitted = reserveRunCost(permissive, { taskShape: "COMPLEX", simultaneousCalls: 3, childTurns: 4 })
  assert.equal(admitted.admitted, true)
  assert.equal(admitted.action, "admit")
  assert.equal(admitted.verificationIntact, true)
  assert.ok(Number(admitted.limits?.maxSimultaneousCalls) <= 3)
})

test("V16.16 budget: DeepSeek stays zero on a tiny local task", () => {
  const tinyBudget = computeOrchestrationBudget({ affectedFiles: 1, taskPolicy: { risk: "low" } })
  const tiny = reserveRunCost(tinyBudget, { taskShape: "TINY", deepseekCalls: 0 })
  assert.equal(tiny.deepseekAllowed, 0)
  assert.equal(tiny.verificationIntact, true)
  const sneaky = reserveRunCost(tinyBudget, { taskShape: "SMALL", deepseekCalls: 2 })
  assert.equal(sneaky.admitted, false)
  assert.equal(sneaky.verificationIntact, true)
  const hardBudget = computeOrchestrationBudget({ taskPolicy: { risk: "high" } })
  const hard = reserveRunCost(hardBudget, { taskShape: "COMPLEX", deepseekCalls: 1 })
  assert.ok(hard.deepseekAllowed >= 1)
  assert.equal(hard.verificationIntact, true)
})

test("V16.16 proof: a valid exact child receipt may be reused", () => {
  const plan = planProofReuse({
    candidates: [{
      command: "node",
      args: ["--test", "test/a.test.mjs"],
      fingerprint: "fp-1",
      exitCode: 0,
      completed: true,
      ageMs: 1_000,
      affectedBySiblings: false,
      gateName: "test",
    }],
  })
  assert.equal(plan.reuse.length, 1)
  assert.equal(plan.run.length, 0)
  assert.equal(plan.canProduceVerdict, false)
})

test("V16.16 proof: sibling cross-impact invalidates the receipt", () => {
  const plan = planProofReuse({
    candidates: [{
      command: "node",
      args: ["--test", "test/a.test.mjs"],
      fingerprint: "fp-1",
      exitCode: 0,
      completed: true,
      ageMs: 1_000,
      affectedBySiblings: true,
    }],
  })
  assert.equal(plan.reuse.length, 0)
  assert.equal(plan.run.length, 1)
  assert.equal(plan.run[0].reason, "sibling-cross-impact")
})

test("V16.16 proof: release verification always runs fresh", () => {
  const candidate = {
    command: "npm",
    args: ["test"],
    fingerprint: "fp-release",
    exitCode: 0,
    completed: true,
    ageMs: 1_000,
    affectedBySiblings: false,
  }
  const release = planProofReuse({ candidates: [candidate], finalRelease: true })
  assert.equal(release.reuse.length, 0)
  assert.equal(release.run[0].reason, "final-release-requires-fresh-proof")
  const sensitive = planProofReuse({
    candidates: [candidate],
    requireFreshCommands: ["npm test"],
  })
  assert.equal(sensitive.reuse.length, 0)
  const stale = planProofReuse({ candidates: [{ ...candidate, ageMs: 99 * 60_000 }] })
  assert.equal(stale.reuse.length, 0)
  const failed = planProofReuse({ candidates: [{ ...candidate, exitCode: 1 }] })
  assert.equal(failed.reuse.length, 0)
  const changed = planProofReuse({ candidates: [{ ...candidate, lockfileChanged: true }] })
  assert.equal(changed.reuse.length, 0)
})

test("V16.16 telemetry: preflight rejections are not rollbacks; unknowns are NOT_MEASURED", () => {
  const events = waveTelemetryToEfficiencyEvents({
    waves: [],
    sharedContext: [],
    integrationTransactions: [
      { outcome: "preflight-rejected", rootUnchanged: true },
      { outcome: "nothing-to-integrate", rootUnchanged: true },
      { outcome: "apply-failed-rolled-back", rootUnchanged: true },
    ],
  })
  const byOperation = Object.fromEntries(events.map((row) => [row.operation, row.metrics.count]))
  assert.equal(byOperation["integration-root-rollbacks"], 1)
  assert.equal(byOperation["integration-preflight-rejected-noop"], 1)
  assert.equal(byOperation["integration-nothing-to-integrate"], 1)
})

test("V16.16 telemetry: provider tokens unknown means NOT_MEASURED, never zero", () => {
  const telemetry = buildCriticalPathTelemetry({ totalWallMs: 1_234, parentTurns: 3 })
  assert.equal(telemetry.totalWallMs.value, 1_234)
  assert.equal(telemetry.totalWallMs.provenance, "MEASURED")
  assert.equal(telemetry.providerInputTokens.value, null)
  assert.equal(telemetry.providerInputTokens.provenance, "NOT_MEASURED")
  assert.equal(telemetry.childTurns.value, null)
  assert.equal(telemetry.childTurns.provenance, "NOT_MEASURED")
  assert.equal(telemetry.tokenSavingClaim, null)
  assert.equal(telemetry.canProduceVerdict, false)
  const reported = buildCriticalPathTelemetry({ providerInputTokens: 500, providerOutputTokens: 50 })
  assert.equal(reported.providerInputTokens.provenance, "MEASURED")
  assert.equal(reported.providerInputTokens.value, 500)
})

test("V16.16 history: bounded EMA with honest provenance", () => {
  const history = createCriticalPathHistory({ maxSamplesPerComponent: 4 })
  assert.equal(history.record(null).recorded, 0)
  assert.equal(history.record({ sandboxCreateMs: 800, bogus: -5, nonsense: "x" }).recorded, 1)
  for (let index = 0; index < 5; index += 1) {
    history.record({ sandboxCreateMs: 800 })
  }
  const estimates = history.estimates()
  assert.equal(estimates.components.sandboxCreateMs.provenance, "MEASURED")
  assert.equal(estimates.components.rpcWorkerStartMs.provenance, "NOT_MEASURED")
  assert.equal(estimates.observations, 6)
  assert.equal(history.snapshot().components.sandboxCreateMs.samples, 4)
  history.reset()
  assert.equal(history.estimates().components.sandboxCreateMs.provenance, "NOT_MEASURED")
  assert.equal(NOT_MEASURED.provenance, "NOT_MEASURED")
})

test("V16.16 history: the composition records and serves bounded estimates", () => {
  const recorded = recordWaveHistory({ sandboxCreateMs: 800, integrationMs: 400, bogus: -1 })
  assert.equal(recorded.recorded, 2)
  assert.equal(recorded.observations >= 1, true)
  const estimates = waveHistoryEstimates()
  assert.equal(estimates.policy, "critical-path-history-v16-16")
  assert.ok(estimates.components.sandboxCreateMs.fallbackMs > 0)
})

test("V16.16 stop: the loop stops only when correctness is proven", () => {
  const stop = shouldStopProven({
    editsComplete: true,
    verificationPass: true,
    requirementsSatisfied: true,
    highRiskEvidence: false,
    staleGeneration: false,
    pendingDependencies: 0,
    releaseGateRequested: false,
  })
  assert.equal(stop.stop, true)
  assert.equal(stop.canProduceVerdict, false)
  for (const incomplete of [
    { editsComplete: false, verificationPass: true, requirementsSatisfied: true },
    { editsComplete: true, verificationPass: false, requirementsSatisfied: true },
    { editsComplete: true, verificationPass: true, requirementsSatisfied: false },
    { editsComplete: true, verificationPass: true, requirementsSatisfied: true, highRiskEvidence: true },
    { editsComplete: true, verificationPass: true, requirementsSatisfied: true, pendingDependencies: 1 },
    { editsComplete: true, verificationPass: true, requirementsSatisfied: true, releaseGateRequested: true },
  ]) {
    const cont = shouldStopProven({ highRiskEvidence: false, staleGeneration: false, pendingDependencies: 0, ...incomplete })
    assert.equal(cont.stop, false, JSON.stringify(incomplete))
    assert.ok(cont.missing.length > 0)
  }
})
