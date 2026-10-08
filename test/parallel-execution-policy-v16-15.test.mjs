// V16.15 Parallel Coding Runtime: task shape + economy gate.
//
// Proves the V16.15 structural invariants that make parallelism economical
// instead of decorative:
//   * a tiny/small task NEVER spawns a child, a sandbox or a DeepSeek consult;
//   * a decomposable task with provably independent writers DOES go parallel;
//   * an ambiguous or conflicting task serializes conservatively;
//   * the economy gate refuses parallelism whose overhead exceeds its benefit;
//   * adaptive concurrency may only move WITHIN the hard bound and only on
//     measured history;
//   * resource pressure reduces concurrency instead of being ignored.

import test from "node:test"
import assert from "node:assert/strict"

import {
  EXECUTION_POSTURE,
  PARENT_DIRECT_SHAPES,
  TASK_SHAPE_V16_15,
  WRITER_CONCURRENCY,
  adaptiveWriterConcurrency,
  childOverheadEstimateMs,
  classifyTaskShapeV16_15,
  decideParallelExecution,
  estimateParallelEconomy,
  parallelTokenEconomy,
  resolveReadOnlyConcurrency,
  resolveWriterConcurrency,
  resourcePressure,
} from "../lib/parallel-execution-policy-v16-15.mjs"

const independentScopes = (n, prefix = "pkg") => Array.from({ length: n }, (_, index) => ({
  id: `t${index + 1}`,
  taskId: `t${index + 1}`,
  readOnly: false,
  writeFiles: [`${prefix}${index + 1}/src/index.ts`],
  readFiles: [],
}))

test("V16.15 shape: a one-file change is TINY and stays parent-direct", () => {
  const classification = classifyTaskShapeV16_15({ changedFiles: ["lib/one.mjs"], risk: "low" })
  assert.equal(classification.shape, TASK_SHAPE_V16_15.TINY)

  const decision = decideParallelExecution({ changedFiles: ["lib/one.mjs"], risk: "low" })
  assert.equal(decision.posture, EXECUTION_POSTURE.PARENT_DIRECT)
  assert.equal(decision.spawnsChildren, false)
  assert.equal(decision.spawnsWriters, false)
  assert.equal(decision.sandboxRequired, false)
  assert.equal(decision.writerConcurrency, 0)
  assert.equal(decision.canProduceVerdict, false)
  assert.ok(decision.reasons.some((row) => row.signal === "parent-direct-shape"))
})

test("V16.15 shape: a two-file coherent edit is SMALL and stays parent-direct", () => {
  const decision = decideParallelExecution({
    changedFiles: ["lib/a.mjs", "lib/b.mjs"],
    risk: "low",
  })
  assert.equal(decision.shape, TASK_SHAPE_V16_15.SMALL)
  assert.equal(decision.posture, EXECUTION_POSTURE.PARENT_DIRECT)
  assert.equal(decision.spawnsChildren, false)
})

test("V16.15 shape: a single-output task can never be promoted to parallel by any later signal", () => {
  for (const shape of PARENT_DIRECT_SHAPES) {
    assert.ok([TASK_SHAPE_V16_15.TINY, TASK_SHAPE_V16_15.SMALL].includes(shape))
  }
  // One declared writer over one output. Even with useful read-only work and a
  // measured history that would justify concurrency, there is no second output
  // to overlap, so the shape stays parent-direct.
  const decision = decideParallelExecution({
    changedFiles: ["lib/one.mjs"],
    risk: "low",
    scopes: [{ id: "t1", readOnly: false, writeFiles: ["lib/one.mjs"] }],
    readOnlyWorkUseful: true,
    history: { childQueueMs: 10, integrationConflictRate: 0, samples: 100 },
  })
  assert.equal(decision.shape, TASK_SHAPE_V16_15.TINY)
  assert.equal(decision.posture, EXECUTION_POSTURE.PARENT_DIRECT)
  assert.equal(decision.spawnsChildren, false)
  assert.equal(decision.sandboxRequired, false)
})

test("V16.15 shape: two outputs with one writer is SMALL and stays parent-direct", () => {
  const decision = decideParallelExecution({
    changedFiles: ["lib/a.mjs", "lib/b.mjs"],
    risk: "low",
    scopes: [{ id: "t1", readOnly: false, writeFiles: ["lib/a.mjs", "lib/b.mjs"] }],
  })
  assert.equal(decision.shape, TASK_SHAPE_V16_15.SMALL)
  assert.equal(decision.posture, EXECUTION_POSTURE.PARENT_DIRECT)
})

test("V16.15 shape: declaring two independent writers is DECOMPOSABLE, not TINY", () => {
  // The declared decomposition is real information: two writers over two distinct
  // outputs. It outranks the raw changed-file count, so the shape is never TINY.
  const scopes = independentScopes(2)
  const decision = decideParallelExecution({
    changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"],
    risk: "medium",
    scopes,
    perChildWorkMs: 30_000,
  })
  assert.equal(decision.shape, TASK_SHAPE_V16_15.DECOMPOSABLE)
  assert.notEqual(decision.shape, TASK_SHAPE_V16_15.TINY)
})

test("V16.15 shape: two provably independent writers make the task DECOMPOSABLE", () => {
  const scopes = independentScopes(2)
  const classification = classifyTaskShapeV16_15({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
  })
  assert.equal(classification.shape, TASK_SHAPE_V16_15.DECOMPOSABLE)
  assert.equal(classification.independentWriters, 2)
})

test("V16.15 economy: a decomposable task with meaningful work goes PARALLEL_WRITERS", () => {
  const scopes = independentScopes(2)
  const decision = decideParallelExecution({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
    perChildWorkMs: 30_000,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.PARALLEL_WRITERS)
  assert.equal(decision.spawnsWriters, true)
  assert.equal(decision.sandboxRequired, true)
  assert.equal(decision.writerConcurrency, 2)
  assert.equal(decision.canProduceVerdict, false)
})

test("V16.15 economy: overhead exceeding benefit serializes instead of parallelizing", () => {
  const scopes = independentScopes(2)
  const economy = estimateParallelEconomy({ scopes, perChildWorkMs: 500 })
  assert.equal(economy.economical.value, false)
  assert.equal(economy.provenance.savings, "ESTIMATED")
  assert.equal(economy.provenance.tokens, "NOT_MEASURED")

  const decision = decideParallelExecution({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
    perChildWorkMs: 500,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.equal(decision.spawnsWriters, false)
  assert.ok(decision.reasons.some((row) => row.signal === "economy-gate-failed"))
})

test("V16.15 economy: a marginal case is refused deterministically", () => {
  const scopes = independentScopes(2)
  // Just below the meaningful-work threshold: no parallel posture, no matter how
  // many times it is evaluated.
  const decisions = Array.from({ length: 5 }, () =>
    decideParallelExecution({ changedFiles: ["a.ts", "b.ts", "c.ts"], risk: "medium", scopes, perChildWorkMs: 3_999 }).posture)
  assert.deepEqual([...new Set(decisions)], [EXECUTION_POSTURE.SERIAL_STRUCTURED])
})

test("V16.15: two writers on the SAME file serialize", () => {
  const scopes = [
    { id: "t1", readOnly: false, writeFiles: ["lib/shared.mjs"] },
    { id: "t2", readOnly: false, writeFiles: ["lib/shared.mjs"] },
  ]
  const decision = decideParallelExecution({
    changedFiles: ["lib/shared.mjs"],
    risk: "medium",
    scopes,
    perChildWorkMs: 30_000,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.equal(decision.spawnsWriters, false)
  assert.ok(decision.reasons.some((row) => row.signal === "writer-conflict"))
})

test("V16.15: an ambiguous writer scope (no declared files) fails conservative", () => {
  const scopes = [
    { id: "t1", readOnly: false, writeFiles: ["pkg1/src/index.ts"] },
    { id: "t2", readOnly: false, writeFiles: [] },
  ]
  const decision = decideParallelExecution({
    changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"],
    risk: "medium",
    scopes,
    perChildWorkMs: 30_000,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.equal(decision.spawnsWriters, false)
  assert.ok(decision.reasons.some((row) => row.signal === "writer-conflict"))
})

test("V16.15: an unresolved research barrier blocks source writers", () => {
  const scopes = independentScopes(2)
  const decision = decideParallelExecution({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
    perChildWorkMs: 30_000,
    unresolvedResearch: true,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.ok(decision.reasons.some((row) => row.signal === "research-barrier-open"))
})

test("V16.15: a single writer with useful read-only discovery gets PARALLEL_READ_ONLY", () => {
  const decision = decideParallelExecution({
    changedFiles: ["lib/a.mjs", "lib/b.mjs"],
    risk: "medium",
    scopes: [
      { id: "t1", readOnly: false, writeFiles: ["lib/a.mjs"] },
      { id: "t2", readOnly: true, writeFiles: [], readFiles: ["lib/b.mjs"] },
    ],
    readOnlyWorkUseful: true,
  })
  assert.equal(decision.shape, TASK_SHAPE_V16_15.NORMAL)
  assert.equal(decision.posture, EXECUTION_POSTURE.PARALLEL_READ_ONLY)
  assert.equal(decision.spawnsWriters, false)
  assert.equal(decision.sandboxRequired, false)
  assert.equal(decision.spawnsChildren, true)
})

test("V16.15: release shape never parallelizes unsafe mutation", () => {
  const decision = decideParallelExecution({
    changedFiles: ["a.ts", "b.ts"],
    scopes: independentScopes(2),
    finalRelease: true,
    perChildWorkMs: 60_000,
  })
  assert.equal(decision.shape, TASK_SHAPE_V16_15.RELEASE)
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.equal(decision.spawnsWriters, false)
})

test("V16.15 writer concurrency: default is 2 on Windows and never exceeds the hard max", () => {
  assert.equal(WRITER_CONCURRENCY.default, 2)
  assert.equal(WRITER_CONCURRENCY.hardMax, 3)
  assert.equal(resolveWriterConcurrency(undefined, { platform: "win32" }), 2)
  assert.equal(resolveWriterConcurrency(4, { platform: "win32" }), WRITER_CONCURRENCY.hardMax)
  assert.equal(resolveWriterConcurrency(99), WRITER_CONCURRENCY.hardMax)
  assert.equal(resolveWriterConcurrency(0), 2)
  assert.equal(resolveWriterConcurrency(-5), 2)
})

test("V16.15 read-only lanes: bounded independently of the writer bound", () => {
  assert.equal(resolveReadOnlyConcurrency(undefined), WRITER_CONCURRENCY.readOnlyDefault)
  assert.equal(resolveReadOnlyConcurrency(99), WRITER_CONCURRENCY.readOnlyHardMax)
  assert.equal(resolveReadOnlyConcurrency(0), WRITER_CONCURRENCY.readOnlyDefault)
})

test("V16.15 adaptive concurrency: no history keeps the conservative default", () => {
  const result = adaptiveWriterConcurrency(null)
  assert.equal(result.concurrency, 2)
  assert.equal(result.adapted, false)
  assert.equal(result.provenance, "NOT_MEASURED")
})

test("V16.15 adaptive concurrency: below minimum sample size does not adapt", () => {
  const result = adaptiveWriterConcurrency({ samples: 3, childQueueMs: 10, integrationConflictRate: 0 })
  assert.equal(result.adapted, false)
  assert.equal(result.provenance, "NOT_MEASURED")
})

test("V16.15 adaptive concurrency: measured low contention raises within the hard bound only", () => {
  const raised = adaptiveWriterConcurrency({ samples: 50, childQueueMs: 20, integrationConflictRate: 0 })
  assert.equal(raised.adapted, true)
  assert.equal(raised.concurrency, 3)
  assert.ok(raised.concurrency <= WRITER_CONCURRENCY.hardMax)
  assert.equal(raised.provenance, "MEASURED")
})

test("V16.15 adaptive concurrency: measured high contention drops to 1", () => {
  const lowered = adaptiveWriterConcurrency({ samples: 50, childQueueMs: 9_000, integrationConflictRate: 0.5 })
  assert.equal(lowered.concurrency, 1)
  assert.equal(lowered.adapted, true)
})

test("V16.15 resource pressure: high pressure reduces writer concurrency to 1", () => {
  const scopes = independentScopes(2)
  const pressure = resourcePressure({ activeChildren: 3, activeSubprocessLanes: 3, activeTests: 2 })
  assert.equal(pressure.level, "high")

  const decision = decideParallelExecution({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
    perChildWorkMs: 30_000,
    resourcePressure: pressure,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.ok(decision.reasons.some((row) => row.signal === "resource-pressure-high"))
})

test("V16.15 resource pressure: no counters reads as unknown, never as zero pressure", () => {
  const pressure = resourcePressure({})
  assert.equal(pressure.level, "unknown")
  assert.equal(pressure.provenance, "NOT_MEASURED")
  assert.equal(pressure.signals.length, 0)
})

test("V16.15 token economy: provider tokens are NOT_MEASURED when absent, never fake zero", () => {
  const economy = parallelTokenEconomy({
    parentInputChars: 1_000,
    parentOutputChars: 500,
    sharedWaveContextChars: 2_000,
    childSpecificChars: 800,
    duplicateContextCharsAvoided: 2_000,
  })
  assert.equal(economy.providerInputTokens.provenance, "NOT_MEASURED")
  assert.equal(economy.providerInputTokens.value, null)
  assert.equal(economy.providerOutputTokens.value, null)
  assert.equal(economy.deepseekTokens.value, null)
  assert.equal(economy.tokenSavingClaim, null)
  assert.equal(economy.sharedWaveContextChars.value, 2_000)
  assert.equal(economy.sharedWaveContextChars.provenance, "MEASURED")
})

test("V16.15 token economy: measured provider tokens are reported as MEASURED", () => {
  const economy = parallelTokenEconomy({ providerInputTokens: 12_345, providerOutputTokens: 678 })
  assert.equal(economy.providerInputTokens.value, 12_345)
  assert.equal(economy.providerInputTokens.provenance, "MEASURED")
  assert.equal(economy.provenance.providerTokens, "MEASURED")
  assert.equal(economy.tokenSavingClaim, null)
})

// ---------------------------------------------------------------------------
// regression: the decision must see the caller's REAL dependency edges, and a
// silent scope must never be waved through as harmless.
// ---------------------------------------------------------------------------

test("V16.15 decision: a caller-declared module edge serializes dependent writers", () => {
  const scopes = independentScopes(2)
  const input = {
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
    perChildWorkMs: 30_000,
  }
  // Without the edge the scopes really are independent.
  const independent = decideParallelExecution(input)
  assert.equal(independent.posture, EXECUTION_POSTURE.PARALLEL_WRITERS)

  // With the declared edge the SAME scopes are dependent, and the decision must
  // change. A verdict that ignores the caller's edges is an invisible
  // dependency, which is how two dependent writers get scheduled together.
  const dependent = decideParallelExecution({
    ...input,
    options: { moduleEdges: [{ from: "pkg1/src/index.ts", to: "pkg2/src/index.ts" }] },
  })
  assert.equal(dependent.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.ok(dependent.reasons.some((row) => row.signal === "writer-conflict"))

  // The reported graph must agree with the verdict it accompanies.
  assert.equal(dependent.conflictGraph.edgeCount, 1)
})

test("V16.15 decision: a scope that declared nothing can never be parallelized", () => {
  const decision = decideParallelExecution({
    changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"],
    risk: "medium",
    scopes: [
      { id: "t1", readOnly: false, writeFiles: ["pkg1/src/index.ts"] },
      { id: "silent" },
    ],
    perChildWorkMs: 30_000,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.equal(decision.spawnsWriters, false)
  assert.ok(decision.reasons.some((row) => row.signal === "writer-conflict"))
})

test("V16.15 economy estimates: overhead is a declared sum, not a magic number", () => {
  const overhead = childOverheadEstimateMs()
  assert.ok(overhead > 0)
  const economy = estimateParallelEconomy({ scopes: independentScopes(2), perChildWorkMs: 10_000 })
  assert.equal(economy.estimatedOverheadMs.value, overhead * 2)
  assert.equal(economy.overheadPerChildMs.value, overhead)
})

test("V16.15 decision: every posture is deterministic for identical input", () => {
  const input = {
    changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"],
    risk: "medium",
    scopes: independentScopes(2),
    perChildWorkMs: 30_000,
  }
  const first = decideParallelExecution(input)
  const second = decideParallelExecution(input)
  assert.equal(first.posture, second.posture)
  assert.equal(first.writerConcurrency, second.writerConcurrency)
  assert.deepEqual(first.reasons, second.reasons)
  assert.equal(first.deterministic, true)
})

test("V16.15 decision: a parallel posture never asserts a verdict", () => {
  const decision = decideParallelExecution({
    changedFiles: ["pkg1/src/index.ts", "pkg2/src/index.ts"],
    risk: "medium",
    scopes: independentScopes(2),
    perChildWorkMs: 30_000,
  })
  assert.equal(decision.canProduceVerdict, false)
})
