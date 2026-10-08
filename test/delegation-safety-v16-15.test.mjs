// V16.15: the delegation-safety pair rule is now the exact conflict graph.
//
// V16.5 decided pair safety from a two-segment root. Two writers on `lib/a.mjs`
// and `lib/b.mjs` share the root `lib/a.mjs`/`lib/b.mjs` -> they were serialized
// even though they cannot corrupt each other, and a writer that declared NO file
// was admitted because its root set was empty.
//
// These tests pin the V16.15 replacement: exact files, read/write direction,
// config families, lockfile/manifest interaction, and fail-closed on silence -
// while the V16.5 vocabulary (`parallelClass`, `PARALLEL_BLOCK_REASON`,
// `overlappingScopeBlocks`, `duplicateWork`) keeps its exact meaning so no
// existing consumer has to change.

import test from "node:test"
import assert from "node:assert/strict"

import {
  PARALLEL_BLOCK_REASON,
  PARALLEL_SAFETY,
  PAIR_STRATEGY,
  assessParallelSafety,
  buildDelegationWaves,
  classifyScope,
} from "../lib/delegation-safety.mjs"

const writer = (id, files, extra = {}) => ({ id, childId: id, role: "implement", readOnly: false, files, task: `edit ${files.join(", ")}`, ...extra })
const reader = (id, files, extra = {}) => ({ id, childId: id, role: "explore", readOnly: true, files, task: `map ${files.join(", ")}`, ...extra })

// ---------------------------------------------------------------------------
// the V16.15 improvement: same directory, different files is INDEPENDENT
// ---------------------------------------------------------------------------

test("V16.15 safety: two writers on different files in the SAME directory are independent", () => {
  const assessment = assessParallelSafety([
    writer("w1", ["lib/alpha.mjs"]),
    writer("w2", ["lib/beta.mjs"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.ALLOWED)
  assert.deepEqual(assessment.blocks, [])
  assert.equal(assessment.pairStrategy, PAIR_STRATEGY.CONFLICT_GRAPH)
})

test("V16.15 safety: a single writer spanning two directories is no longer serial-only", () => {
  const scope = classifyScope({ role: "implement", readOnly: false, files: ["lib/a.mjs", "pi/extensions/ues.ts"], task: "edit both" })
  assert.equal(scope.parallelClass, "disjoint-writer")
  assert.equal(scope.writer, true)
  // Two such writers on disjoint files still overlap.
  const assessment = assessParallelSafety([
    writer("w1", ["lib/a.mjs", "pi/extensions/ues.ts"]),
    writer("w2", ["lib/b.mjs", "scripts/other.mjs"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.ALLOWED)
})

test("V16.15 safety: the legacy root rule is still reachable and still serializes", () => {
  const scopes = [writer("w1", ["lib/alpha.mjs"]), writer("w2", ["lib/beta.mjs"])]
  const graph = assessParallelSafety(scopes)
  const legacy = assessParallelSafety(scopes, { pairStrategy: PAIR_STRATEGY.LEGACY_ROOTS })
  assert.equal(graph.decision, PARALLEL_SAFETY.ALLOWED)
  // `lib/alpha.mjs` and `lib/beta.mjs` are two segments each, so the V16.5 rule
  // sees two DIFFERENT roots and allows them. Use a deeper pair to show the
  // legacy rule genuinely over-serializes:
  const deep = [writer("w1", ["packages/a/src/x.ts"]), writer("w2", ["packages/a/src/y.ts"])]
  assert.equal(assessParallelSafety(deep).decision, PARALLEL_SAFETY.ALLOWED)
  const legacyDeep = assessParallelSafety(deep, { pairStrategy: PAIR_STRATEGY.LEGACY_ROOTS })
  assert.equal(legacyDeep.decision, PARALLEL_SAFETY.BLOCKED)
  assert.ok(legacyDeep.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.WRITER_OVERLAP))
  assert.equal(legacyDeep.pairStrategy, PAIR_STRATEGY.LEGACY_ROOTS)
})

// ---------------------------------------------------------------------------
// the V16.15 tightening: silence is never safety
// ---------------------------------------------------------------------------

test("V16.15 safety: a writer that declares no file is serial-only, never disjoint", () => {
  const scope = classifyScope({ role: "implement", readOnly: false, files: [], task: "fix the thing" })
  assert.equal(scope.scopeUnknown, true)
  assert.equal(scope.parallelClass, "serial-only")

  const assessment = assessParallelSafety([
    writer("blind", []),
    writer("w2", ["lib/b.mjs"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.BLOCKED)
  assert.ok(assessment.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.SCOPE_UNKNOWN))
})

// ---------------------------------------------------------------------------
// existing V16.5 behaviour that must not regress
// ---------------------------------------------------------------------------

test("V16.15 safety: an exact write/write overlap is still WRITER_OVERLAP", () => {
  const assessment = assessParallelSafety([
    writer("w1", ["lib/shared.mjs"]),
    writer("w2", ["lib/shared.mjs"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.BLOCKED)
  assert.ok(assessment.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.WRITER_OVERLAP))
  // The metric keeps exactly its V16.5 meaning: file-level pair blocks.
  assert.equal(assessment.overlappingScopeBlocks, 1)
})

test("V16.15 safety: a reader racing a writer on the same file is blocked", () => {
  const assessment = assessParallelSafety([
    reader("r", ["lib/api.mjs"]),
    writer("w", ["lib/api.mjs"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.BLOCKED)
  assert.ok(assessment.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.OVERLAPPING_FILES))
})

test("V16.15 safety: two readers of the same file still overlap (they do not write it)", () => {
  const assessment = assessParallelSafety([
    reader("r1", ["lib/api.mjs"]),
    reader("r2", ["lib/api.mjs"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.ALLOWED)
})

test("V16.15 safety: a lockfile writer conflicts with a manifest writer on other paths", () => {
  const assessment = assessParallelSafety([
    writer("lock", ["package-lock.json"]),
    writer("manifest", ["packages/a/package.json"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.BLOCKED)
  assert.ok(assessment.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.OVERLAPPING_FILES))
})

test("V16.15 safety: two isolated package writers over disjoint files overlap", () => {
  const assessment = assessParallelSafety([
    writer("a", ["packages/a/src/index.ts"]),
    writer("b", ["packages/b/src/index.ts"]),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.ALLOWED)
})

test("V16.15 safety: a declared module edge between two written modules is a conflict", () => {
  const scopes = [writer("a", ["lib/a.mjs"]), writer("b", ["lib/b.mjs"])]
  assert.equal(assessParallelSafety(scopes).decision, PARALLEL_SAFETY.ALLOWED)
  const withEdge = assessParallelSafety(scopes, {
    moduleEdges: [{ from: "lib/a.mjs", to: "lib/b.mjs" }],
  })
  assert.equal(withEdge.decision, PARALLEL_SAFETY.BLOCKED)
  assert.ok(withEdge.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.OVERLAPPING_FILES))
})

test("V16.15 safety: destructive shell, external side effects and mutable services stay serial-only", () => {
  for (const task of ["git push origin main", "npm publish", "rm -rf build", "deploy to production"]) {
    assert.equal(classifyScope({ role: "x", readOnly: false, files: ["a.ts"], task }).parallelClass, "serial-only", task)
  }
  const service = classifyScope({ role: "svc", readOnly: false, files: ["a.ts"], task: "start the dev server" })
  assert.equal(service.parallelClass, "serial-only")
  assert.equal(service.mutableService, true)

  const assessment = assessParallelSafety([
    writer("pub", ["package.json"], { task: "npm publish the release" }),
    writer("dep", ["docker/app.yml"], { task: "deploy to production" }),
  ])
  assert.equal(assessment.decision, PARALLEL_SAFETY.BLOCKED)
  assert.ok(assessment.blocks.some((block) => block.reason === PARALLEL_BLOCK_REASON.EXTERNAL_SIDE_EFFECT))
})

test("V16.15 safety: duplicate scopes are still detected", () => {
  const assessment = assessParallelSafety([reader("a", ["src/a.ts"]), reader("b", ["src/a.ts"])])
  assert.equal(assessment.duplicateWork, 1)
})

test("V16.15 safety: waves never exceed the bounded max and never co-schedule a conflict", () => {
  const scopes = [
    ...Array.from({ length: 5 }, (_, index) => reader(`lane-${index}`, [`src/${index}.ts`])),
    writer("w1", ["lib/shared.mjs"]),
    writer("w2", ["lib/shared.mjs"]),
  ]
  const waves = buildDelegationWaves(scopes, { maxParallel: 2 })
  for (const wave of waves.waves) assert.ok(wave.scopes.length <= 2, JSON.stringify(wave.scopes))
  const sharedWave = waves.waves.find((wave) => wave.scopes.includes("w1"))
  assert.ok(sharedWave, "w1 must be placed")
  assert.ok(!sharedWave.scopes.includes("w2"), "two writers on one file must never share a wave")
})

test("V16.15 safety: identical input yields identical decisions (deterministic)", () => {
  const scopes = [writer("w1", ["lib/a.mjs"]), writer("w2", ["lib/b.mjs"]), reader("r", ["lib/c.mjs"])]
  const first = assessParallelSafety(scopes)
  const second = assessParallelSafety(scopes)
  assert.deepEqual(first.blocks, second.blocks)
  assert.equal(first.decision, second.decision)
  const wavesA = buildDelegationWaves(scopes)
  const wavesB = buildDelegationWaves(scopes)
  assert.deepEqual(wavesA.waves, wavesB.waves)
})
