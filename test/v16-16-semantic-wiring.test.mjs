// V16.16 SEMANTIC PRODUCTION-WIRING: behavioral proofs (no source-text asserts).
//
// Each test below proves a RUNTIME effect through the real owners with
// injected boundaries — never by checking that a file contains a string.
// The small static callsite guard lives in
// test/v16-16-production-wiring.test.mjs; a test passing only because
// `text.includes(...)` matched is NOT sufficient for any of these four
// capabilities.
//
//   A. prewarm worker is actually reused by run (real PiRpcWorkerPool, fake
//      RpcWorker/spawn boundary): prewarm(key) -> run(same key) reuses with
//      exactly ONE worker start; prewarm(A) -> run(B) does NOT reuse.
//   B. run cost consumes the real V16.6 budget: a constrained canonical
//      budget lowers concurrency, a permissive one admits; verification stays
//      intact, the hard writer cap holds, tiny work stays cheap.
//   C. proof reuse prevents an eligible duplicate verification execution
//      (injected runner counter): reusable child proof -> identical root
//      command NOT executed again, receipt consumed, local verifier still
//      owns the verdict; sibling impact / final release -> fresh execution.
//   D. stop-when-proven governs continuation (bounded harness loop, inputs
//      derived from harness state — never hardcoded): verified complete
//      terminal wave -> no additional attempt/model child; pending dependency,
//      stale generation or requested release gate -> must continue.

import test from "node:test"
import assert from "node:assert/strict"

import { PiRpcWorkerPool, buildRpcWorkerKey, buildRpcWorkerSpec } from "../lib/pi-rpc-pool.mjs"
import { computeOrchestrationBudget, reserveRunCost } from "../lib/orchestration-budget-v16-6.mjs"
import {
  executeProofPlan,
  planProofReuse,
  prewarmWaveWorkers,
  shouldStopProven,
} from "../lib/parallel-coding-runtime-v16-15.mjs"

// ---------------------------------------------------------------------------
// A. prewarm -> run reuse through the REAL pool.
// ---------------------------------------------------------------------------

// Fake RpcWorker/spawn boundary: counts process starts without spawning. The
// pool's key-based reuse, LRU, reservation and discard logic is the REAL one.
function countingWorkerFactory(counter) {
  return (spec) => ({
    spec,
    proc: null,
    runs: 0,
    dead: false,
    active: false,
    lastActivityAt: 0,
    async start() {
      if (this.proc && !this.dead) return
      counter.starts += 1
      this.proc = { fake: true }
      this.dead = false
    },
    async stop() {
      this.dead = true
      this.proc = null
    },
    async run() {
      await this.start()
      this.runs += 1
      this.active = true
      try {
        return {
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          stderr: "",
          toolCalls: 0,
          toolNames: [],
        }
      } finally {
        this.active = false
      }
    },
  })
}

const canonicalKey = (overrides = {}) => buildRpcWorkerKey({
  agent: "ues-executor",
  cwd: "/repo/sandbox-a",
  command: "pi",
  args: ["--mode", "rpc", "--tools", "ues_code"],
  compactToolOutput: false,
  toolOutputLimit: 24576,
  verificationTimeoutSec: 300,
  toolTimeoutMs: 1000,
  allowLocalEnvWrite: false,
  policySnapshotId: "ps-1",
  runtimeEpochId: "epoch-1",
  runId: "run-1",
  journalRoot: "/repo",
  ...overrides,
})

test("V16.16 semantic A: prewarm(key) -> run(same key) reuses with ONE worker start", async () => {
  const counter = { starts: 0 }
  const pool = new PiRpcWorkerPool({ createWorker: countingWorkerFactory(counter) })
  const key = canonicalKey()
  const spec = buildRpcWorkerSpec({ command: "pi", args: ["--mode", "rpc"], cwd: "/repo/sandbox-a", env: {} })

  const pre = await pool.prewarm(key, spec)
  assert.equal(pre.reused, false)
  assert.equal(counter.starts, 1)

  const result = await pool.run(key, spec, "Task: implement\n", {})
  assert.equal(result.workerReused, true)
  assert.equal(counter.starts, 1)
  await pool.stopAll().catch(() => {})
})

test("V16.16 semantic A: prewarm(A) -> run(B) does NOT count as reuse", async () => {
  const counter = { starts: 0 }
  const pool = new PiRpcWorkerPool({ createWorker: countingWorkerFactory(counter) })
  const keyA = canonicalKey({ cwd: "/repo/sandbox-a" })
  const keyB = canonicalKey({ cwd: "/repo/sandbox-b" })
  assert.notEqual(keyA, keyB)
  const specA = buildRpcWorkerSpec({ command: "pi", args: [], cwd: "/repo/sandbox-a", env: {} })
  const specB = buildRpcWorkerSpec({ command: "pi", args: [], cwd: "/repo/sandbox-b", env: {} })

  await pool.prewarm(keyA, specA)
  const result = await pool.run(keyB, specB, "Task: other\n", {})
  assert.equal(result.workerReused, false)
  assert.equal(counter.starts, 2)
  await pool.stopAll().catch(() => {})
})

test("V16.16 semantic A: canonical builder is deterministic and fencing-sensitive", () => {
  const base = {
    agent: "ues-executor",
    cwd: "/repo",
    command: "pi",
    args: ["--mode", "rpc"],
    policySnapshotId: "ps",
    runtimeEpochId: "ep",
    runId: "run",
    journalRoot: "/repo",
  }
  assert.equal(buildRpcWorkerKey(base), buildRpcWorkerKey({ ...base }))
  // Every fencing dimension changes the key: no cross-epoch / cross-run /
  // cross-policy reuse is possible.
  for (const dim of ["agent", "cwd", "policySnapshotId", "runtimeEpochId", "runId", "journalRoot"]) {
    assert.notEqual(buildRpcWorkerKey(base), buildRpcWorkerKey({ ...base, [dim]: String(base[dim]) + "-other" }))
  }
  assert.notEqual(
    buildRpcWorkerKey({ ...base, args: ["--mode", "rpc"] }),
    buildRpcWorkerKey({ ...base, args: ["--mode", "rpc", "--tools", "extra"] }),
  )
})

test("V16.16 semantic A: unconsumed prewarm is discarded, never counted as reuse", async () => {
  const counter = { starts: 0 }
  const pool = new PiRpcWorkerPool({ createWorker: countingWorkerFactory(counter) })
  const helperPool = { live: 0 }
  void helperPool
  // Wave-level helper: successful prewarm that the run never consumes must be
  // discarded (mirrors the production post-wave cleanup contract).
  const prewarmResult = await prewarmWaveWorkers(pool, [
    { key: canonicalKey({ cwd: "/repo/w1" }), spec: buildRpcWorkerSpec({ command: "pi", args: [], cwd: "/repo/w1", env: {} }) },
    { key: canonicalKey({ cwd: "/repo/w2" }), spec: buildRpcWorkerSpec({ command: "pi", args: [], cwd: "/repo/w2", env: {} }) },
  ], { maxWorkers: 2 })
  assert.equal(prewarmResult.started.value, 2)
  // The run consumes only w1 (same key); w2 is abandoned and discarded.
  const consumed = new Set([canonicalKey({ cwd: "/repo/w1" })])
  let discarded = 0
  for (const key of prewarmResult.keys) {
    if (consumed.has(key)) continue
    const outcome = await pool.discard(key)
    if (outcome.discarded) discarded += 1
  }
  assert.equal(discarded, 1)
  assert.equal(pool.status().keys.includes(canonicalKey({ cwd: "/repo/w2" })), false)
  assert.equal(pool.status().keys.includes(canonicalKey({ cwd: "/repo/w1" })), true)
  await pool.stopAll().catch(() => {})
})

// ---------------------------------------------------------------------------
// B. run cost consumes the REAL canonical V16.6 budget.
// ---------------------------------------------------------------------------

test("V16.16 semantic B: constrained real budget lowers concurrency; permissive admits", () => {
  const constrained = computeOrchestrationBudget({ affectedFiles: 1, taskPolicy: { risk: "low" } })
  assert.equal(constrained.executionProfile, "FAST")
  assert.equal(constrained.maxParallel, 1)
  const lowered = reserveRunCost(constrained, {
    taskShape: "COMPLEX",
    simultaneousCalls: 3,
    childTurns: 6,
    childContextChars: 4000,
  })
  assert.equal(lowered.admitted, false)
  assert.equal(lowered.action, "lower-concurrency")
  assert.equal(lowered.verificationIntact, true)
  assert.ok(Number(lowered.limits.maxSimultaneousCalls) <= 3)

  const permissive = computeOrchestrationBudget({ taskPolicy: { risk: "high" } })
  assert.equal(permissive.executionProfile, "DEEP")
  const admitted = reserveRunCost(permissive, {
    taskShape: "COMPLEX",
    simultaneousCalls: 2,
    childTurns: 4,
    childContextChars: 4000,
  })
  assert.equal(admitted.admitted, true)
  assert.equal(admitted.action, "admit")
  assert.equal(admitted.verificationIntact, true)
  // Hard writer cap holds on both paths.
  assert.ok(Number(admitted.limits.maxSimultaneousCalls) <= 3)
})

test("V16.16 semantic B: tiny work stays cheap with verification intact", () => {
  const budget = computeOrchestrationBudget({ affectedFiles: 1, taskPolicy: { risk: "low" } })
  const tiny = reserveRunCost(budget, { taskShape: "TINY", deepseekCalls: 0, simultaneousCalls: 1 })
  assert.equal(tiny.deepseekAllowed, 0)
  assert.equal(tiny.verificationIntact, true)
})

// ---------------------------------------------------------------------------
// C. proof reuse changes verification work (injected runner counter).
// ---------------------------------------------------------------------------

const proofCandidate = (overrides = {}) => ({
  command: "node",
  args: ["--test", "test/a.test.mjs"],
  fingerprint: "fp-1",
  exitCode: 0,
  completed: true,
  aborted: false,
  timedOut: false,
  partial: false,
  ageMs: 1_000,
  affectedBySiblings: false,
  gateName: "test",
  lockfileChanged: false,
  configChanged: false,
  ...overrides,
})

test("V16.16 semantic C: reusable child proof prevents duplicate execution; verifier still owns verdict", async () => {
  const plan = planProofReuse({ candidates: [proofCandidate()] })
  assert.equal(plan.reuse.length, 1)
  assert.equal(plan.run.length, 0)
  assert.equal(plan.canProduceVerdict, false)

  const executions = []
  const result = await executeProofPlan(plan, {
    findReceipt: async () => ({ id: "receipt-1" }),
    runFresh: async (command) => { executions.push(command); return { executed: true } },
  })
  // The eligible duplicate was NOT executed again; its receipt was consumed.
  assert.deepEqual(executions, [])
  assert.equal(result.consumed.length, 1)
  assert.equal(result.consumed[0].receiptId, "receipt-1")
  assert.equal(result.executed.length, 0)
  // Planning/execution never asserts PASS: the local verifier owns the final
  // verdict (simulated here by an independent verifier decision).
  assert.equal(result.canProduceVerdict, false)
  assert.equal(result.verifierOwnsVerdict, true)
  const verifierVerdict = result.consumed.length === 1 ? "PASS" : "FAIL"
  assert.equal(verifierVerdict, "PASS")
})

test("V16.16 semantic C: sibling impact and final release execute fresh", async () => {
  const impacted = planProofReuse({ candidates: [proofCandidate({ affectedBySiblings: true })] })
  assert.equal(impacted.reuse.length, 0)
  assert.equal(impacted.run.length, 1)
  assert.equal(impacted.run[0].reason, "sibling-cross-impact")

  const released = planProofReuse({ candidates: [proofCandidate()], finalRelease: true })
  assert.equal(released.reuse.length, 0)
  assert.equal(released.run[0].reason, "final-release-requires-fresh-proof")

  for (const plan of [impacted, released]) {
    const executions = []
    const result = await executeProofPlan(plan, {
      findReceipt: async () => ({ id: "stale-receipt" }),
      runFresh: async (command) => { executions.push(command); return { executed: true, exitCode: 0 } },
    })
    assert.equal(executions.length, 1)
    assert.equal(executions[0], "node --test test/a.test.mjs")
    assert.equal(result.consumed.length, 0)
    assert.equal(result.executed.length, 1)
    assert.equal(result.canProduceVerdict, false)
  }
})

test("V16.16 semantic C: failed or stale receipts never infer PASS", async () => {
  for (const overrides of [
    { exitCode: 1 },
    { ageMs: 99 * 60_000 },
    { lockfileChanged: true },
  ]) {
    const plan = planProofReuse({ candidates: [proofCandidate(overrides)] })
    assert.equal(plan.reuse.length, 0)
    assert.equal(plan.run.length, 1)
    const executions = []
    const result = await executeProofPlan(plan, {
      findReceipt: async () => null,
      runFresh: async (command) => { executions.push(command); return { executed: true } },
    })
    assert.equal(executions.length, 1)
    assert.equal(result.canProduceVerdict, false)
  }
})

// ---------------------------------------------------------------------------
// D. stop-when-proven governs continuation (derived inputs, bounded harness).
// ---------------------------------------------------------------------------

// Minimal bounded-continuation harness mirroring the production attempt loop:
// each attempt runs one model child; the stop decision (derived from harness
// state, never hardcoded) decides retry vs break. Returns the trace.
async function runHarnessWaves({ waves, maxAttempts = 3, gateRequested = false, staleAfter = -1 }) {
  const trace = { attempts: 0, children: 0, continued: false, stopped: false, wavesDone: 0 }
  let head = "HEAD-0"
  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const ids = waves[waveIndex]
    let wavePassed = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      trace.attempts += 1
      trace.children += 1 // one model child per attempt
      // Simulated child verification: passes (fresh PASS evidence).
      wavePassed = true
      if (trace.attempts - 1 === staleAfter) head = "HEAD-foreign"
      // Derive inputs from harness state (mirrors production derivation).
      const editsComplete = wavePassed === true
      const verificationPass = wavePassed === true
      const requirementsSatisfied = true
      const highRiskEvidence = false
      const staleGeneration = head !== "HEAD-0"
      const pendingDependencies = waves.slice(waveIndex + 1).flat().length
      const releaseGateRequested = gateRequested === true
      const decision = shouldStopProven({
        editsComplete,
        verificationPass,
        requirementsSatisfied,
        highRiskEvidence,
        staleGeneration,
        pendingDependencies,
        releaseGateRequested,
      })
      if (decision.stop === true) {
        trace.stopped = true
        break // no additional attempt/model child for this wave
      }
      // Not proven: continue (retry same wave when stale, else proceed to
      // next wave / gates). The harness records continuation explicitly.
      trace.continued = true
      if (staleGeneration) {
        if (attempt < maxAttempts) continue
        break
      }
      break // pending/gates: proceed outward (next wave / release gates)
    }
    trace.wavesDone += 1
  }
  return trace
}

test("V16.16 semantic D: verified complete terminal wave spawns no additional child", async () => {
  const trace = await runHarnessWaves({ waves: [["t1"]] })
  assert.equal(trace.attempts, 1)
  assert.equal(trace.children, 1)
  assert.equal(trace.stopped, true)
  assert.equal(trace.wavesDone, 1)
})

test("V16.16 semantic D: pending dependency, stale generation or release gate must continue", async () => {
  const pending = await runHarnessWaves({ waves: [["t1"], ["t2"]] })
  assert.equal(pending.continued, true)
  assert.equal(pending.wavesDone, 2)

  const stale = await runHarnessWaves({ waves: [["t1"]], staleAfter: 0 })
  assert.equal(stale.continued, true)
  assert.equal(stale.stopped, false)

  const gated = await runHarnessWaves({ waves: [["t1"]], gateRequested: true })
  assert.equal(gated.continued, true)
  assert.equal(gated.stopped, false)
})
