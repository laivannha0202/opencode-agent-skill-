import assert from "node:assert/strict"
import test from "node:test"
import {
  compileExecutionPlan,
  buildExecutionScopes,
  EXECUTION_PLAN_DECISION,
} from "../lib/execution-plan-compiler-v16-17.mjs"
import { runDelegationWave } from "../lib/delegation-fleet.mjs"
import { defaultCriticalPathHistory } from "../lib/critical-path-history-v16-16.mjs"

// V16.17 §2 Execution Plan Compiler: COMPILE ONCE → downstream EXECUTES.
// These tests fail if any layer re-derives conflicts or turns a compiled
// SERIAL wave back into PARALLEL.

function writerTask(id, files, extra = {}) {
  return {
    id,
    title: `task ${id}`,
    summary: `do ${id}`,
    files: { modify: files },
    dependsOn: [],
    acceptance: [`${id} done`],
    verification: [`check ${id}`],
    ...extra,
  }
}

function readTask(id, extra = {}) {
  return {
    id,
    title: `read ${id}`,
    summary: `read ${id}`,
    dependsOn: [],
    acceptance: [`${id} read`],
    verification: [`check ${id}`],
    ...extra,
  }
}

test("conflicting writers are serialized by the order authority and never re-parallelized", async () => {
  // Two INDEPENDENT writers on the SAME file. The order authority
  // (computeSafeWaves) detects the declared write/write conflict and
  // serializes them into SEPARATE waves with `serialized` evidence. Downstream
  // execution must honor that serialization even under maxParallel=3.
  const tasks = [writerTask("A", ["src/a.ts"]), writerTask("B", ["src/a.ts"])]
  const plan = compileExecutionPlan({
    tasks,
    goal: "test goal",
    runId: "run-serial",
    maxConcurrency: 3,
    workspaceGeneration: { rootHead: "abc123" },
  })
  assert.ok(plan.planId.startsWith("plan-"))
  assert.equal(plan.generation.rootHead, "abc123")
  assert.equal(plan.waves.length, 2)
  assert.equal(plan.serialized.length, 1)
  assert.equal(plan.serialized[0].task, "B")
  assert.equal(plan.serialized[0].conflictsWith, "A")
  for (const wave of plan.waves) {
    assert.notEqual(wave.decision, EXECUTION_PLAN_DECISION.PARALLEL)
    assert.equal(wave.concurrency, 1)
    for (const row of wave.conflictWaves) {
      assert.ok(row.indexes.length <= 1, `row ${JSON.stringify(row.indexes)} must be single-scope`)
    }
  }

  // Execute every compiled wave through the fleet with maxParallel=3: a
  // downstream re-derivation would parallelize; verbatim execution stays
  // serial.
  let active = 0
  let peak = 0
  const ran = []
  for (const wave of plan.waves) {
    const scopes = wave.taskIds.map((id) => ({ id, key: id }))
    const result = await runDelegationWave({
      scopes,
      waves: wave.conflictWaves,
      compiledPlanId: plan.planId,
      maxParallel: 3,
      execute: async (scope) => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 15))
        active -= 1
        ran.push(scope.id)
        return { ok: true };
      },
    })
    assert.equal(result.failed, 0)
  }
  assert.deepEqual(ran.sort(), ["A", "B"])
  assert.equal(peak, 1)
})

test("a decision of SERIAL re-packs conflict waves so downstream cannot parallelize them", async () => {
  // Disjoint files: computeSafeWaves keeps both tasks in ONE wave and the
  // conflict authority ALLOWS a parallel pack, but the compiled decision is
  // SERIAL (policy does not prove these writers independent). The compiler
  // must re-pack every row to a single scope so execution is serial BY
  // STRUCTURE — a multi-scope `safe` row would parallelize regardless of the
  // decision.
  const tasks = [writerTask("A", ["src/a.ts"]), writerTask("B", ["src/b.ts"])]
  const plan = compileExecutionPlan({ tasks, goal: "test goal", runId: "run-repack", maxConcurrency: 3 })
  assert.equal(plan.waves.length, 1)
  const wave = plan.waves[0]
  assert.equal(wave.decision, EXECUTION_PLAN_DECISION.SERIAL)
  assert.equal(wave.concurrency, 1)
  assert.ok(wave.conflictWaves.length > 0)
  for (const row of wave.conflictWaves) {
    assert.ok(row.indexes.length <= 1, `row ${JSON.stringify(row.indexes)} must be single-scope`)
    assert.equal(row.safe, false)
  }

  let active = 0
  let peak = 0
  const ran = []
  const scopes = wave.taskIds.map((id) => ({ id, key: id }))
  const result = await runDelegationWave({
    scopes,
    waves: wave.conflictWaves,
    compiledPlanId: plan.planId,
    maxParallel: 3,
    execute: async (scope) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      ran.push(scope.id)
      return { ok: true };
    },
  })
  assert.equal(result.failed, 0)
  assert.deepEqual(ran.sort(), ["A", "B"])
  assert.equal(peak, 1, "a compiled SERIAL wave must execute serially even under maxParallel=3")
})

test("independent readers compile to PARALLEL and overlap in execution", async () => {
  const tasks = [
    readTask("R1", { files: { read: ["lib/r1.ts"] } }),
    readTask("R2", { files: { read: ["lib/r2.ts"] } }),
    readTask("R3", { files: { read: ["lib/r3.ts"] } }),
  ]
  const plan = compileExecutionPlan({ tasks, goal: "test goal", runId: "run-par", maxConcurrency: 3 })
  assert.equal(plan.waves.length, 1)
  const wave = plan.waves[0]
  assert.equal(wave.decision, EXECUTION_PLAN_DECISION.PARALLEL)

  let active = 0
  let peak = 0
  const result = await runDelegationWave({
    scopes: wave.taskIds.map((id) => ({ id, key: id })),
    waves: wave.conflictWaves,
    compiledPlanId: plan.planId,
    maxParallel: 3,
    execute: async (scope) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 25))
      active -= 1
      return { ok: true };
    },
  })
  assert.equal(result.completed, 3)
  assert.ok(peak > 1, `expected overlap, observed peak ${peak}`)
})

test("compiled plan is immutable and deterministic", () => {
  const tasks = [readTask("R1")]
  const a = compileExecutionPlan({ tasks, goal: "test goal", runId: "r", maxConcurrency: 2 })
  const b = compileExecutionPlan({ tasks, goal: "test goal", runId: "r", maxConcurrency: 2 })
  assert.equal(a.planId, b.planId)
  const c = compileExecutionPlan({ tasks, goal: "test goal", runId: "other", maxConcurrency: 2 })
  assert.notEqual(a.planId, c.planId)
  assert.ok(Object.isFrozen(a))
  assert.ok(Object.isFrozen(a.waves))
  assert.ok(Object.isFrozen(a.waves[0]))
  assert.throws(() => { a.waves.push("x") }, TypeError)
})

test("a refusing budget downgrades the wave to SERIAL without dropping verification", () => {
  const tasks = [readTask("R1"), readTask("R2")]
  const plan = compileExecutionPlan({
    tasks,
    goal: "test goal",
    runId: "r",
    maxConcurrency: 3,
    reserve: () => ({ admitted: false, action: "serialize", reasons: ["ceiling"] }),
  })
  assert.equal(plan.waves[0].decision, EXECUTION_PLAN_DECISION.SERIAL)
  assert.equal(plan.waves[0].verification.required, true)
  assert.equal(plan.waves[0].verification.intact, true)
})

test("admission is decided at compile time: read-only waves need no worktrees", () => {
  const plan = compileExecutionPlan({ tasks: [readTask("R1")], goal: "test goal", runId: "r", maxConcurrency: 2 })
  const admission = plan.waves[0].admission
  assert.equal(admission.createWorktrees, false)
  assert.equal(admission.deepseekCalls, 0)
  assert.equal(admission.browserLaunches, false)
})

test("buildExecutionScopes carries the real conflict evidence per task", () => {
  const scopes = buildExecutionScopes([
    writerTask("A", ["src/a.ts"], {
      acceptance: ["a passes"],
      services: ["db"],
      externalEffects: ["deploy to prod"],
    }),
  ])
  assert.equal(scopes.length, 1)
  assert.deepEqual(scopes[0].writeFiles, ["src/a.ts"])
  assert.deepEqual(scopes[0].acceptance, ["a passes"])
  assert.deepEqual(scopes[0].services, ["db"])
  assert.deepEqual(scopes[0].externalEffects, ["deploy to prod"])
})

// ---------------------------------------------------------------------------
// V16.17 (§6) CRITICAL-PATH HISTORY TYPE PARITY.
//
// The defect: the controller passed `history: () => waveHistoryEstimates()`
// (a FUNCTION) while `parallel-execution-policy-v16-15` reads
// `history.components[name]` as an OBJECT. `resolveComponentMs` therefore always
// fell back to ESTIMATED, so MEASURED history never influenced the decision.
// The compiler must accept function-or-object and resolve a supplier EXACTLY
// ONCE, so the MEASURED component provenance reaches `decideParallelExecution`.
// ---------------------------------------------------------------------------

test("V16.17 §6: a history SUPPLIER is resolved once and MEASURED provenance reaches the decision", () => {
  const history = defaultCriticalPathHistory()
  // Record enough real samples that the components are MEASURED, not NOT_MEASURED.
  for (let i = 0; i < 8; i += 1) {
    history.record({
      sandboxCreateMs: 900,
      rpcWorkerStartMs: 700,
      contextBuildMs: 300,
      targetedVerifyMs: 1200,
      integrationMs: 400,
    })
  }
  const estimates = history.estimates()
  assert.equal(estimates.components.sandboxCreateMs.provenance, "MEASURED")

  let calls = 0
  const plan = compileExecutionPlan({
    tasks: [readTask("R1", { files: { read: ["lib/r1.ts"] } }), readTask("R2", { files: { read: ["lib/r2.ts"] } })],
    goal: "test goal",
    runId: "run-history",
    maxConcurrency: 3,
    history: () => {
      calls += 1
      return estimates
    },
  })

  // A supplier is invoked EXACTLY ONCE, not once per wave / per component.
  assert.equal(calls, 1, "the history supplier must be resolved exactly once")

  const economy = plan.waves[0].economy.economy
  // Pre-fix, passing a function meant `history.components` was undefined and
  // every component silently degraded to ESTIMATED.
  assert.equal(economy.provenance.history, "MEASURED", "MEASURED history must reach the decision")
  assert.equal(economy.historyComponents.sandboxCreateMs.provenance, "MEASURED")
  assert.equal(economy.historyComponents.targetedVerifyMs.provenance, "MEASURED")
  assert.equal(economy.historyComponents.integrationMs.provenance, "MEASURED")
})

test("V16.17 §6: a resolved history OBJECT is accepted unchanged (object-or-function parity)", () => {
  const history = defaultCriticalPathHistory()
  for (let i = 0; i < 8; i += 1) history.record({ sandboxCreateMs: 900, rpcWorkerStartMs: 700 })
  const estimates = history.estimates()
  const plan = compileExecutionPlan({
    tasks: [readTask("R1", { files: { read: ["lib/r1.ts"] } }), readTask("R2", { files: { read: ["lib/r2.ts"] } })],
    goal: "test goal",
    runId: "run-history-object",
    maxConcurrency: 3,
    history: estimates,
  })
  assert.equal(plan.waves[0].economy.economy.provenance.history, "MEASURED")
})

test("V16.17 §6: absent history is NOT_MEASURED, never a fabricated MEASURED", () => {
  const plan = compileExecutionPlan({
    tasks: [readTask("R1", { files: { read: ["lib/r1.ts"] } }), readTask("R2", { files: { read: ["lib/r2.ts"] } })],
    goal: "test goal",
    runId: "run-history-absent",
    maxConcurrency: 3,
  })
  const economy = plan.waves[0].economy.economy
  assert.equal(economy.provenance.history, "NOT_MEASURED")
  assert.equal(economy.historyComponents.sandboxCreateMs.provenance, "ESTIMATED")
})
