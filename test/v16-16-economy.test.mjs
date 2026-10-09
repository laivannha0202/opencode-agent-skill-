// V16.16 Critical-Path Economy Gate.
//
// Proves the V16.16 fix for the V16.15 production wiring gap: the old gate
// charged every overhead component once PER CHILD (as if nothing overlapped),
// so a production wave that never supplied `perChildWorkMs` could never reach
// PARALLEL_WRITERS. The critical-path model charges overlapped components once
// (their maximum) and serializes only integration, and scopes without an
// explicit estimate get a deterministic ESTIMATED work figure from their
// declarations - never a fabricated measurement.

import test from "node:test"
import assert from "node:assert/strict"

import {
  CRITICAL_PATH_MODEL,
  EXECUTION_POSTURE,
  MIN_MEANINGFUL_CHILD_WORK_MS,
  TASK_SHAPE_V16_15,
  WRITER_CONCURRENCY,
  adaptiveWriterConcurrency,
  decideParallelExecution,
  estimateParallelEconomy,
  estimateScopeWorkMs,
  resolveWriterConcurrency,
  resourcePressure,
} from "../lib/parallel-execution-policy-v16-15.mjs"
import {
  createCriticalPathHistory,
  HISTORY_FALLBACK_MS,
} from "../lib/critical-path-history-v16-16.mjs"

const substantialScopes = () => [1, 2].map((index) => ({
  id: `t${index}`,
  taskId: `t${index}`,
  readOnly: false,
  writeFiles: [`pkg${index}/src/a.ts`, `pkg${index}/src/b.ts`, `pkg${index}/src/c.ts`],
  readFiles: [],
  acceptance: [`acceptance ${index}-a`, `acceptance ${index}-b`, `acceptance ${index}-c`],
  verificationCommands: [`node --test test/pkg${index}.test.mjs`],
  task: `Implement substantial feature ${index} with full acceptance criteria and verification`,
}))

const trivialScopes = () => [1, 2].map((index) => ({
  id: `t${index}`,
  taskId: `t${index}`,
  readOnly: false,
  writeFiles: [`pkg${index}/x.ts`],
  task: "fix typo",
}))

test("V16.16 economy: production-like substantial writers reach PARALLEL_WRITERS without an explicit estimate", () => {
  const scopes = substantialScopes()
  const decision = decideParallelExecution({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
  })
  assert.equal(decision.shape, TASK_SHAPE_V16_15.DECOMPOSABLE)
  assert.equal(decision.posture, EXECUTION_POSTURE.PARALLEL_WRITERS)
  assert.equal(decision.spawnsWriters, true)
  assert.equal(decision.writerConcurrency, 2)
  assert.equal(decision.canProduceVerdict, false)
  // The work figure is ESTIMATED from declarations, never MEASURED.
  assert.equal(decision.economy.perChildWorkMs.provenance, "ESTIMATED")
  assert.equal(decision.economy.model, "critical-path-v16-16")
})

test("V16.16 economy: two trivial writers stay serial under the economy gate", () => {
  const scopes = trivialScopes()
  const decision = decideParallelExecution({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "low",
    scopes,
  })
  assert.equal(decision.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.equal(decision.spawnsWriters, false)
  assert.ok(decision.reasons.some((row) => row.signal === "economy-gate-failed"))
})

test("V16.16 economy: one writer never spawns child parallelism", () => {
  const decision = decideParallelExecution({
    changedFiles: ["lib/only.mjs", "lib/also.mjs"],
    risk: "medium",
    scopes: [{ id: "t1", readOnly: false, writeFiles: ["lib/only.mjs", "lib/also.mjs"] }],
  })
  assert.equal(decision.spawnsWriters, false)
  assert.equal(decision.writerConcurrency, 0)
})

test("V16.16 economy: overlapped startup is charged once, not once per child", () => {
  const economy = estimateParallelEconomy({ scopes: substantialScopes() })
  const components = economy.criticalPathMs.value
  // Two children: the parallel wall is setup + ONE startup max + longest
  // child + ONE verification max + serialized integration - strictly less
  // than the old childCount * every-component sum.
  const legacySum = 2 * (900 + 600 + 1_400 + 1_200 + 500)
  assert.ok(economy.parallelWallMs.value < legacySum + economy.perChildWorkMs.value)
  assert.equal(components.serializedIntegrationMs, 2 * 500)
  assert.ok(components.startupCriticalPathMs <= 1_400)
  assert.equal(economy.economical.value, true)
})

test("V16.16 economy: marginal work still serializes deterministically", () => {
  const scopes = substantialScopes()
  const postures = Array.from({ length: 3 }, () => decideParallelExecution({
    changedFiles: scopes.flatMap((scope) => scope.writeFiles),
    risk: "medium",
    scopes,
    perChildWorkMs: 3_999,
  }).posture)
  assert.deepEqual([...new Set(postures)], [EXECUTION_POSTURE.SERIAL_STRUCTURED])
})

test("V16.16 economy: tiny/small shapes stay parent-direct whatever the estimate", () => {
  for (const changedFiles of [["lib/one.mjs"], ["lib/a.mjs", "lib/b.mjs"]]) {
    const decision = decideParallelExecution({
      changedFiles,
      risk: "low",
      scopes: [{ id: "t1", readOnly: false, writeFiles: changedFiles }],
      perChildWorkMs: 60_000,
    })
    assert.equal(decision.posture, EXECUTION_POSTURE.PARENT_DIRECT)
    assert.equal(decision.spawnsChildren, false)
  }
})

test("V16.16 economy: measured history tunes within its clamp band only", () => {
  const history = createCriticalPathHistory()
  // Below the minimum sample size: history is ignored, fallback used.
  history.record({ sandboxCreateMs: 100 })
  const untuned = estimateParallelEconomy({ scopes: substantialScopes(), history: history.estimates() })
  assert.equal(untuned.historyComponents.sandboxCreateMs.provenance, "ESTIMATED")
  // With enough samples the measured value is used, clamped to the band.
  for (let index = 0; index < 5; index += 1) {
    history.record({ sandboxCreateMs: 100, integrationMs: 5_000 })
  }
  const tuned = estimateParallelEconomy({ scopes: substantialScopes(), history: history.estimates() })
  assert.equal(tuned.historyComponents.sandboxCreateMs.provenance, "MEASURED")
  // 100ms clamped to the 0.25x floor of the 1400ms fallback (350ms).
  assert.equal(tuned.historyComponents.sandboxCreateMs.ms, 350)
  // 5000ms clamped to the 4x ceiling of the 500ms fallback (2000ms).
  assert.equal(tuned.historyComponents.integrationMs.ms, 2_000)
  assert.equal(tuned.provenance.history, "MEASURED")
})

test("V16.16 economy: history can never override the hard writer maximum", () => {
  assert.equal(WRITER_CONCURRENCY.hardMax, 3)
  assert.equal(resolveWriterConcurrency(99), 3)
  const raised = adaptiveWriterConcurrency({ samples: 100, childQueueMs: 5, integrationConflictRate: 0 })
  assert.ok(raised.concurrency <= WRITER_CONCURRENCY.hardMax)
  const decision = decideParallelExecution({
    changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
    risk: "medium",
    scopes: [1, 2, 3, 4, 5].map((index) => ({
      id: `t${index}`,
      writeFiles: [`pkg${index}/a.ts`, `pkg${index}/b.ts`],
      acceptance: ["done"],
      verificationCommands: ["node --test"],
      task: `substantial work ${index}`,
    })),
    requestedWriters: 99,
  })
  assert.ok(decision.writerConcurrency <= WRITER_CONCURRENCY.hardMax)
})

test("V16.16 economy: missing history never masquerades as measured", () => {
  const fresh = createCriticalPathHistory()
  const estimates = fresh.estimates()
  for (const component of Object.values(estimates.components)) {
    assert.equal(component.provenance, "NOT_MEASURED")
    assert.equal(component.value, null)
    assert.ok(Number.isFinite(component.fallbackMs))
  }
  const economy = estimateParallelEconomy({ scopes: substantialScopes(), history: estimates })
  assert.equal(economy.provenance.history, "NOT_MEASURED")
  // ...and the gate still decides deterministically from fallbacks.
  assert.equal(economy.economical.value, true)
  const first = decideParallelExecution({ changedFiles: ["a.ts", "b.ts"], risk: "medium", scopes: substantialScopes() })
  const second = decideParallelExecution({ changedFiles: ["a.ts", "b.ts"], risk: "medium", scopes: substantialScopes() })
  assert.equal(first.posture, second.posture)
  assert.equal(first.deterministic, true)
})

test("V16.16 economy: scope work estimation is deterministic and bounded", () => {
  const scope = {
    writeFiles: ["a.ts", "b.ts"],
    readFiles: ["c.ts"],
    acceptance: ["done"],
    verificationCommands: ["node --test"],
    task: "implement the thing",
  }
  assert.equal(estimateScopeWorkMs(scope), estimateScopeWorkMs(JSON.parse(JSON.stringify(scope))))
  const estimate = estimateScopeWorkMs(scope)
  assert.ok(estimate >= 500 && estimate <= 60_000)
  assert.ok(estimateScopeWorkMs({}) >= 500)
  assert.ok(estimateScopeWorkMs({ writeFiles: Array.from({ length: 100 }, (_, i) => `f${i}.ts`) }) <= 60_000)
  assert.ok(estimateScopeWorkMs({ writeFiles: ["a.ts"] }) < estimateScopeWorkMs({
    writeFiles: ["a.ts", "b.ts", "c.ts"],
    acceptance: ["x", "y"],
    verificationCommands: ["node --test"],
  }))
})

test("V16.16 economy: resource pressure still clamps, research barrier still blocks, release stays safe", () => {
  const scopes = substantialScopes()
  const files = scopes.flatMap((scope) => scope.writeFiles)
  const pressured = decideParallelExecution({
    changedFiles: files,
    risk: "medium",
    scopes,
    resourcePressure: resourcePressure({ activeChildren: 3, activeSubprocessLanes: 3, activeTests: 2 }),
  })
  assert.equal(pressured.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  const blocked = decideParallelExecution({ changedFiles: files, risk: "medium", scopes, unresolvedResearch: true })
  assert.equal(blocked.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  const release = decideParallelExecution({ changedFiles: files, scopes, finalRelease: true, perChildWorkMs: 60_000 })
  assert.equal(release.posture, EXECUTION_POSTURE.SERIAL_STRUCTURED)
  assert.equal(release.shape, TASK_SHAPE_V16_15.RELEASE)
})

test("V16.16 economy: Windows default is 2 writers", () => {
  assert.equal(WRITER_CONCURRENCY.default, 2)
  assert.equal(resolveWriterConcurrency(undefined, { platform: "win32" }), 2)
  assert.ok(MIN_MEANINGFUL_CHILD_WORK_MS > 0)
  assert.equal(CRITICAL_PATH_MODEL.serializedIntegration, true)
  assert.deepEqual(Object.keys(HISTORY_FALLBACK_MS).length > 0, true)
})
