// V16.15 Parallel Coding Runtime composition.
//
// This is the ONE entry point the controller calls for a single-shot parallel
// wave. The suite proves three things:
//
//   1. DELEGATION. The composition owns no policy of its own: it returns the
//      policy owner's verdict (same posture, same shape, same graph) and it
//      reports the owner ids it delegated to.
//   2. NO SECOND ANSWER. The graph the plan reports is the SAME graph the
//      verdict was formed from, including the caller's declared edges.
//   3. NEVER A VERDICT. Every parallel plan carries `canProduceVerdict: false`.
//      Only the local verifier can produce a PASS.

import test from "node:test"
import assert from "node:assert/strict"

import {
  PARALLEL_CODING_EFFICIENCY_KIND,
  PARALLEL_CODING_OWNERS,
  PARALLEL_CODING_RUNTIME_POLICY,
  buildChildDelta,
  buildSiblingHandoff,
  buildWaveSnapshot,
  completionDecision,
  failureCancellation,
  integrationOrder,
  pairIndependent,
  planWave,
  progressWatchdog,
  retryDecision,
  waveAccounting,
  waveTelemetryToEfficiencyEvents,
} from "../lib/parallel-coding-runtime-v16-15.mjs"
import {
  EXECUTION_POSTURE,
  decideParallelExecution,
  TASK_SHAPE_V16_15,
} from "../lib/parallel-execution-policy-v16-15.mjs"

const writerScope = (id, files) => ({ id, taskId: id, readOnly: false, writeFiles: files, readFiles: [] })

const independentScopes = (n, prefix = "pkg") => Array.from({ length: n }, (_, index) =>
  writerScope(`t${index + 1}`, [`${prefix}${index + 1}/src/index.ts`]))

const WAVE_INPUT = {
  risk: "medium",
  perChildWorkMs: 30_000,
}

test("V16.15 runtime: the composition reports the owners it delegates to", () => {
  assert.equal(PARALLEL_CODING_RUNTIME_POLICY, "parallel-coding-runtime-v16-15")
  assert.deepEqual(Object.keys(PARALLEL_CODING_OWNERS).sort(), ["conflictGraph", "integration", "policy", "waveContext"])
  for (const owner of Object.values(PARALLEL_CODING_OWNERS)) {
    assert.match(owner, /-v16-15$/)
  }
})

test("V16.15 runtime: planWave returns the policy owner's verdict unchanged", () => {
  const scopes = independentScopes(2)
  const input = { ...WAVE_INPUT, scopes, changedFiles: scopes.flatMap((scope) => scope.writeFiles) }
  const plan = planWave(input)
  const decision = decideParallelExecution(input)

  // No re-decision: the posture, shape and reason are the authority's own.
  assert.equal(plan.posture, decision.posture)
  assert.equal(plan.shape, decision.shape)
  assert.equal(plan.shapeReason, decision.shapeReason)
  assert.equal(plan.decisionPolicy, decision.policy)
  assert.equal(plan.policy, PARALLEL_CODING_RUNTIME_POLICY)

  // And the plan's own derived fields follow from that verdict.
  assert.equal(plan.posture, EXECUTION_POSTURE.PARALLEL_WRITERS)
  assert.equal(plan.shape, TASK_SHAPE_V16_15.DECOMPOSABLE)
  assert.equal(plan.concurrency, 2)
  assert.equal(plan.parentDirect, false)
})

test("V16.15 runtime: the reported graph IS the graph the verdict came from", () => {
  const scopes = independentScopes(2)
  const input = { ...WAVE_INPUT, scopes, changedFiles: scopes.flatMap((scope) => scope.writeFiles) }
  const plan = planWave(input)
  const decision = decideParallelExecution(input)

  assert.deepEqual(plan.graph.scopes.map((row) => row.id), decision.conflictGraph.scopes.map((row) => row.id))
  assert.equal(plan.graph.fingerprint, decision.conflictGraph.fingerprint)
  assert.equal(plan.graph.edgeCount, decision.conflictGraph.edgeCount)
})

test("V16.15 runtime: a caller edge changes the verdict AND the reported graph", () => {
  const scopes = independentScopes(2)
  const base = { ...WAVE_INPUT, scopes, changedFiles: scopes.flatMap((scope) => scope.writeFiles) }
  assert.equal(planWave(base).posture, EXECUTION_POSTURE.PARALLEL_WRITERS)

  const plan = planWave({
    ...base,
    options: { moduleEdges: [{ from: "pkg1/src/index.ts", to: "pkg2/src/index.ts" }] },
  })
  assert.equal(plan.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  // The graph must not disagree with the verdict it accompanies.
  assert.equal(plan.graph.edgeCount, 1)
})

test("V16.15 runtime: a tiny task stays parent-direct and never spawns", () => {
  const plan = planWave({ scopes: [writerScope("t1", ["lib/one.mjs"])], changedFiles: ["lib/one.mjs"], risk: "low" })
  assert.equal(plan.posture, EXECUTION_POSTURE.PARENT_DIRECT)
  assert.equal(plan.shape, TASK_SHAPE_V16_15.TINY)
  assert.equal(plan.parentDirect, true)
  assert.equal(plan.concurrency, 1)
  assert.equal(plan.graph, null)
})

test("V16.15 runtime: a plan is never a verdict", () => {
  const cases = [
    { scopes: [writerScope("t1", ["lib/one.mjs"])], changedFiles: ["lib/one.mjs"] },
    { ...WAVE_INPUT, scopes: independentScopes(2), changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"] },
    { ...WAVE_INPUT, scopes: independentScopes(3), changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts", "pkg3/src/index.ts"] },
  ]
  for (const input of cases) {
    const plan = planWave(input)
    assert.equal(plan.canProduceVerdict, false)
    assert.equal(plan.deterministic, true)
    assert.equal(plan.schemaVersion, 1)
  }
})

test("V16.15 runtime: the requested writer bound is clamped inside the hard max", () => {
  const scopes = independentScopes(4)
  const plan = planWave({
    ...WAVE_INPUT,
    scopes,
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    options: { requestedWriters: 99 },
  })
  assert.equal(plan.maxWriters, 3)
  assert.ok(plan.concurrency <= 3)
})

test("V16.15 runtime: the wave snapshot is immutable and shared by every child", () => {
  const built = buildWaveSnapshot({
    waveId: "wave-1",
    goal: "Ship V16.15",
    constraints: ["no commit", "no publish"],
    sourceEvidence: ["evidence:sha256:abc"],
  })
  assert.equal(built.policy, PARALLEL_CODING_RUNTIME_POLICY)
  assert.equal(built.canProduceVerdict, false)
  assert.equal(built.snapshot.immutable, true)
  assert.match(built.snapshot.snapshotId, /^wave-snapshot:sha256:/)

  const first = buildChildDelta({ snapshot: built.snapshot, child: { childId: "a", goal: "edit a", writeFiles: ["lib/a.mjs"] } })
  const second = buildChildDelta({ snapshot: built.snapshot, child: { childId: "b", goal: "edit b", writeFiles: ["lib/b.mjs"] } })
  assert.equal(first.sharedSnapshotId, built.snapshot.snapshotId)
  assert.equal(second.sharedSnapshotId, built.snapshot.snapshotId)
  // The shared block is referenced, never repeated inline.
  assert.equal(first.text.includes(built.snapshot.text), false)
  assert.equal(second.text.includes(built.snapshot.text), false)
  assert.ok(first.text.includes(built.snapshot.snapshotId))
})

test("V16.15 runtime: wave accounting is a measured CHAR claim, never a token claim", () => {
  const built = buildWaveSnapshot({ goal: "g", constraints: ["c"] })
  const deltas = ["a", "b", "c"].map((id) =>
    buildChildDelta({ snapshot: built.snapshot, child: { childId: id, goal: `task ${id}`, writeFiles: [`lib/${id}.mjs`] } }))
  const accounting = waveAccounting({ snapshot: built.snapshot, deltas })

  assert.equal(accounting.childCount, 3)
  assert.equal(accounting.providerTokens.provenance, "NOT_MEASURED")
  assert.equal(accounting.tokenSavingClaim, null)
  assert.equal(accounting.provenance.provenance, "MEASURED")
  assert.ok(accounting.duplicateContextCharsAvoided.value > 0)
})

test("V16.15 runtime: wave accounting invents nothing without a snapshot", () => {
  const accounting = waveAccounting({})
  assert.equal(accounting.providerTokens.provenance, "NOT_MEASURED")
  assert.equal(accounting.tokenSavingClaim, null)
  assert.equal(accounting.provenance.provenance, "NOT_MEASURED")
})

test("V16.15 runtime: a sibling handoff is a bounded receipt, not a transcript", () => {
  const handoff = buildSiblingHandoff({
    child: {
      childId: "a",
      taskId: "t1",
      status: "completed",
      changedFiles: ["lib/a.mjs"],
      verificationResults: [{ command: "node --test t.mjs", status: "pass", exitCode: 0 }],
      firstFailure: "x".repeat(5_000),
    },
  })
  assert.equal(handoff.childId, "a")
  assert.ok(handoff.firstFailure.length <= 600)
  assert.equal(handoff.canProduceVerdict, false)
})

test("V16.15 runtime: the integration order is deterministic and dependency-first", () => {
  const patches = [
    { taskId: "t2", wave: 0, dependsOn: ["t1"] },
    { taskId: "t1", wave: 0 },
  ]
  const first = integrationOrder(patches)
  const second = integrationOrder([...patches].reverse())

  // The order must not depend on the input (completion) order.
  assert.deepEqual(first.order, ["t1", "t2"])
  assert.deepEqual(second.order, first.order)
  assert.equal(first.completionOrderIgnored, true)
  assert.equal(first.deterministic, true)
  // A dependent patch sits deeper than the patch it depends on.
  assert.ok(first.depths.t2 > first.depths.t1)
})

test("V16.15 runtime: completion, retry, cancellation and the watchdog all delegate", () => {
  const done = completionDecision({ tasks: [{ taskId: "t1", status: "verified" }], verifierPassed: true })
  assert.ok(Object.keys(done).length > 0)

  const retry = retryDecision({ failureClass: "transient", attempt: 1 })
  assert.ok(Object.keys(retry).length > 0)

  const cancellation = failureCancellation({ failedTaskId: "t1", tasks: [{ taskId: "t1" }, { taskId: "t2", dependsOn: ["t1"] }] })
  assert.ok(Object.keys(cancellation).length > 0)

  const watchdog = progressWatchdog({ startedAt: Date.now(), stallTimeoutMs: 60_000 })
  assert.ok(Object.keys(watchdog).length > 0)
})

test("V16.15 runtime: pair independence is delegated to the conflict graph owner", () => {
  const independent = pairIndependent(writerScope("a", ["pkg1/a.ts"]), writerScope("b", ["pkg2/b.ts"]))
  assert.equal(independent.independent, true)

  const conflicting = pairIndependent(writerScope("a", ["lib/same.ts"]), writerScope("b", ["lib/same.ts"]))
  assert.equal(conflicting.independent, false)
  assert.ok(conflicting.kinds.length > 0)
})

// ---------------------------------------------------------------------------
// efficiency observations
//
// The runtime PRODUCES observations for the existing Metrics V2 aggregator. It
// must never emit a speedup or token claim, because neither is measured here.
// ---------------------------------------------------------------------------

test("V16.15 runtime: wave telemetry becomes MEASURED count observations", () => {
  const events = waveTelemetryToEfficiencyEvents({
    waves: [
      { posture: "PARALLEL_WRITERS", reason: ["independent-writers"] },
      { posture: "PARENT_DIRECT", reason: ["parent-direct-shape"] },
      { posture: "SERIAL_STRUCTURED", reason: ["writer-conflict"] },
      { posture: "SERIAL_STRUCTURED", reason: ["economy-gate-failed"] },
      { posture: "SERIAL_STRUCTURED", reason: ["resource-pressure-high", "writer-bound-single"] },
      { posture: "SERIAL_STRUCTURED", reason: ["research-barrier-open"] },
      { posture: "SERIAL_STRUCTURED", reason: ["release-shape"] },
    ],
    sharedContext: [{ snapshotChars: 1_000, accounting: { duplicateContextCharsAvoided: { value: 2_000 } } }],
    integrationTransactions: [
      { outcome: "integrated", rootUnchanged: false },
      { outcome: "preflight-rejected", rootUnchanged: true },
      { outcome: "apply-failed-rolled-back", rootUnchanged: true },
    ],
  })

  const byOperation = Object.fromEntries(events.map((row) => [row.operation, row.metrics.count]))
  assert.equal(byOperation["waves-planned"], 7)
  assert.equal(byOperation["posture:PARALLEL_WRITERS"], 1)
  assert.equal(byOperation["posture:PARENT_DIRECT"], 1)
  assert.equal(byOperation["posture:SERIAL_STRUCTURED"], 5)
  assert.equal(byOperation["waves-refused-by-writer-conflict"], 1)
  assert.equal(byOperation["waves-refused-by-economy-gate"], 1)
  assert.equal(byOperation["waves-refused-by-resource-pressure"], 1)
  assert.equal(byOperation["waves-refused-by-research-barrier"], 1)
  assert.equal(byOperation["waves-refused-by-release-shape"], 1)
  assert.equal(byOperation["shared-snapshot-chars"], 1_000)
  assert.equal(byOperation["duplicate-context-chars-avoided"], 2_000)
  assert.equal(byOperation["integration-transactions"], 3)
  assert.equal(byOperation["integration:integrated"], 1)
  assert.equal(byOperation["integration:preflight-rejected"], 1)
  // V16.16 telemetry correctness: a preflight rejection leaves the root
  // untouched BY DESIGN and is not a rollback. Only the genuinely reversed
  // apply counts, exactly once.
  assert.equal(byOperation["integration-root-rollbacks"], 1)
  assert.equal(byOperation["integration-preflight-rejected-noop"], 1)

  // Every row is a MEASURED count and carries the parallel-coding kind.
  for (const row of events) {
    assert.equal(row.kind, PARALLEL_CODING_EFFICIENCY_KIND)
    assert.equal(row.provenance.count, "MEASURED")
    assert.equal(typeof row.metrics.count, "number")
  }
})

test("V16.15 runtime: wave observations never claim a speedup or a token saving", () => {
  const events = waveTelemetryToEfficiencyEvents({ waves: [{ posture: "PARALLEL_WRITERS", reason: [] }] })
  const serialized = JSON.stringify(events)
  for (const forbidden of ["speedup", "savedMs", "overlapSaved", "tokens", "tokenSaving"]) {
    assert.equal(serialized.includes(forbidden), false, `wave observations must not mention ${forbidden}`)
  }
  // An empty telemetry block yields no fabricated zero-count events at all.
  const empty = waveTelemetryToEfficiencyEvents({})
  assert.equal(empty.some((row) => row.metrics.count === 0 && row.operation.includes("posture")), false)
})

test("V16.15 runtime: loop-governance observations count refusals, not savings", () => {
  // The refusal rows below are the OWNER's real output shapes: `decideRetry`
  // returns its classification's own reason for a non-retryable class.
  const events = waveTelemetryToEfficiencyEvents({
    waves: [{ posture: "SERIAL_STRUCTURED", reason: [] }],
    retries: [
      { retry: true, reason: "retryable IMPLEMENTATION_FAILURE: child exited 1", failureClass: "IMPLEMENTATION_FAILURE" },
      { retry: false, reason: "identical failure fingerprint already attempted; escalate diagnosis instead of respawning", failureClass: "IMPLEMENTATION_FAILURE" },
      { retry: false, reason: "retry budget exhausted (1/1)", failureClass: "IMPLEMENTATION_FAILURE" },
      { retry: false, reason: "patch or file conflict", failureClass: "CONFLICT" },
      { retry: false, reason: "identical wave state observed twice; the loop is not making progress", failureClass: null },
    ],
  })
  const byOperation = Object.fromEntries(events.map((row) => [row.operation, row.metrics.count]))
  assert.equal(byOperation["loop-retries-allowed"], 1)
  assert.equal(byOperation["loop-retries-refused"], 4)
  assert.equal(byOperation["loop-stops:repeated-failure"], 1)
  assert.equal(byOperation["loop-stops:attempt-budget"], 1)
  assert.equal(byOperation["loop-stops:no-progress"], 1)
  assert.equal(byOperation["loop-stops:not-retryable"], 1)
  // No wall-time or token claim rides along with a loop decision.
  const serialized = JSON.stringify(events)
  for (const forbidden of ["speedup", "savedMs", "tokens"]) {
    assert.equal(serialized.includes(forbidden), false, `loop observations must not mention ${forbidden}`)
  }
  // With no loop decisions recorded, no zero-count event is fabricated.
  const none = waveTelemetryToEfficiencyEvents({ retries: [] })
  assert.equal(none.some((row) => row.operation.startsWith("loop-")), false)
})

// ---------------------------------------------------------------------------
// cold start
//
// The V16.15 stack must stay LAZY: a run that never plans a wave must not pay
// for the policy, the graph, the wave context or the integration transaction.
// ---------------------------------------------------------------------------

test("V16.15 runtime: the parallel coding stack hydrates lazily and completely", async () => {
  const lazy = await import("../lib/lazy-runtime.mjs")
  lazy.resetLazyRuntimeForTests()

  // Cold: nothing from the V16.15 stack is loaded, and the composition entry
  // point exists in the registry (a missing loader would throw here).
  assert.equal(lazy.isLazyModuleLoaded(lazy.LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME), false)
  assert.ok(lazy.LAZY_RUNTIME_STACKS.PARALLEL_CODING.includes(lazy.LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME))
  for (const owner of ["PARALLEL_EXECUTION_POLICY", "EXECUTION_CONFLICT_GRAPH", "WAVE_SHARED_CONTEXT", "INTEGRATION_TRANSACTION"]) {
    assert.ok(lazy.LAZY_RUNTIME_STACKS.PARALLEL_CODING.includes(lazy.LAZY_RUNTIME_MODULES[owner]), owner)
  }

  const stack = await lazy.hydrateRuntimeStack(lazy.LAZY_RUNTIME_STACKS.PARALLEL_CODING)
  const composition = stack[lazy.LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME]
  for (const name of ["planWave", "buildWaveSnapshot", "runIntegration", "completionDecision"]) {
    assert.equal(typeof composition[name], "function", name)
  }
  assert.equal(lazy.loadedLazyModules().length, lazy.LAZY_RUNTIME_STACKS.PARALLEL_CODING.length)

  lazy.resetLazyRuntimeForTests()
})
