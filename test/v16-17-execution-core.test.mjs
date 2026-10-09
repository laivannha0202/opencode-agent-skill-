// V16.17 Execution-Core Consolidation — architecture invariant tests.
//
// This suite pins the invariants the V16.17 directive makes non-negotiable:
//
//   §3  delegation waves compile conflict inputs ONCE and never drop edges/strategy
//   §4  task-graph owns DEPENDENCY topology; execution conflicts have ONE owner
//   §5  external side effects are classified by the canonical graph, not a broad
//       prose regex that mislabels ordinary source-writing prose
//   §7  the privileged system prompt is fenced into the runtime epoch + the RPC
//       prompt path is content-addressed
//   §8  the run budget is CUMULATIVE across waves, not a stateless per-request
//   §9  the run has a wall-clock deadline that never removes verification
//   §10 provider usage has ONE normalizer; UNKNOWN is never a measured zero

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildDelegationWaves,
  classifyScope,
} from "../lib/delegation-safety.mjs"
import {
  classifyPair,
  normalizeScope,
  PAIR_VERDICT,
} from "../lib/execution-conflict-graph-v16-15.mjs"
import {
  computeSafeWaves,
  tasksConflict,
  taskConflictScope,
} from "../lib/task-graph.mjs"
import { buildRuntimeEpoch, runtimeEpochCompatibility } from "../lib/runtime-epoch.mjs"
import {
  createRunBudgetLedger,
  deriveRunCeilings,
} from "../lib/run-budget-ledger-v16-17.mjs"
import {
  SAMPLE_SEMANTICS,
  measuredTokenMetric,
  normalizeProviderUsage,
  normalizedUsageView,
} from "../lib/provider-usage-normalizer-v16-17.mjs"
import { aggregateUsageSamples } from "../lib/run-telemetry.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const readSource = (rel) => readFileSync(path.join(ROOT, rel), "utf8")

const writer = (id, files, extra = {}) => ({
  id,
  childId: id,
  role: "implement",
  readOnly: false,
  files,
  task: `edit ${files.join(",")}`,
  ...extra,
})

// ---------------------------------------------------------------------------
// §3 Delegation wave consistency
// ---------------------------------------------------------------------------

test("V16.17 §3: a module edge is honored by the wave builder (not dropped)", () => {
  const scopes = [writer("w1", ["lib/a.mjs"]), writer("w2", ["lib/b.mjs"])]
  const noEdge = buildDelegationWaves(scopes)
  assert.deepEqual(noEdge.waves.map((w) => w.scopes), [["w1", "w2"]])

  const withEdge = buildDelegationWaves(scopes, {
    moduleEdges: [{ from: "lib/a.mjs", to: "lib/b.mjs" }],
  })
  assert.deepEqual(withEdge.waves.map((w) => w.scopes), [["w1"], ["w2"]])
})

test("V16.17 §3: a generated-output edge is honored by the wave builder", () => {
  const scopes = [
    writer("g1", ["lib/schema.ts"], { generatedOutputs: ["lib/generated/schema.gen.ts"] }),
    writer("g2", ["lib/generated/schema.gen.ts"]),
  ]
  const waves = buildDelegationWaves(scopes)
  assert.deepEqual(waves.waves.map((w) => w.scopes), [["g1"], ["g2"]])
})

test("V16.17 §3: pairStrategy is preserved into candidate probes", () => {
  const scopes = [writer("p1", ["lib/alpha.mjs"]), writer("p2", ["lib/beta.mjs"])]
  const legacy = buildDelegationWaves(scopes, { pairStrategy: "legacy-roots" })
  assert.deepEqual(legacy.waves.map((w) => w.scopes), [["p1", "p2"]])
})

test("V16.17 §3: an unknown writer scope still fails closed", () => {
  const waves = buildDelegationWaves([writer("u", []), writer("v", ["lib/v.mjs"])])
  assert.deepEqual(waves.waves.map((w) => w.scopes), [["u"], ["v"]])
})

test("V16.17 §3: the wave builder is deterministic", () => {
  const scopes = [writer("e1", ["x/a.mjs"]), writer("e2", ["x/b.mjs"]), writer("e3", ["x/c.mjs"])]
  assert.deepEqual(buildDelegationWaves(scopes).waves, buildDelegationWaves(scopes).waves)
})

// ---------------------------------------------------------------------------
// §4 ONE conflict authority
// ---------------------------------------------------------------------------

test("V16.17 §4: task-graph conflicts delegate to the canonical conflict graph", () => {
  const shared = [
    { id: "A", files: { modify: ["src/shared.js"] } },
    { id: "B", files: { read: ["src/shared.js"] } },
  ]
  assert.equal(tasksConflict(shared[0], shared[1]).conflict, true)
  const pair = classifyPair(taskConflictScope(shared[0]), taskConflictScope(shared[1]))
  assert.equal(pair.verdict, PAIR_VERDICT.CONFLICT)
})

test("V16.17 §4: independent writers on different files stay in one wave", () => {
  const plan = {
    schemaVersion: 1,
    goal: "g",
    tasks: [
      { id: "A", title: "A", summary: "A", files: { modify: ["lib/a.js"] }, dependsOn: [], acceptance: ["x"], verification: ["y"], risk: "low" },
      { id: "B", title: "B", summary: "B", files: { modify: ["lib/b.js"] }, dependsOn: [], acceptance: ["x"], verification: ["y"], risk: "low" },
    ],
  }
  assert.deepEqual(computeSafeWaves(plan).waves, [["A", "B"]])
})

test("V16.17 §4: a manifest/lockfile pair conflicts through the canonical graph", () => {
  const plan = {
    schemaVersion: 1,
    goal: "g",
    tasks: [
      { id: "A", title: "A", summary: "A", files: { modify: ["package.json"] }, dependsOn: [], acceptance: ["x"], verification: ["y"], risk: "low" },
      { id: "B", title: "B", summary: "B", files: { modify: ["package-lock.json"] }, dependsOn: [], acceptance: ["x"], verification: ["y"], risk: "low" },
    ],
  }
  assert.deepEqual(computeSafeWaves(plan).waves, [["A"], ["B"]])
})

test("V16.17 §4: task-graph no longer keeps its own write/read overlap logic", () => {
  const source = readSource("lib/task-graph.mjs")
  assert.match(source, /from "\.\/execution-conflict-graph-v16-15\.mjs"/)
  assert.match(source, /tasksConflict/)
  // The old local heuristic must be gone.
  assert.doesNotMatch(source, /const writeA = new Set\(taskWriteFiles/)
})

// ---------------------------------------------------------------------------
// §5 External side-effect classification
// ---------------------------------------------------------------------------

test("V16.17 §5: ordinary source prose is NOT an external side effect", () => {
  for (const task of [
    "update release notes",
    "add release tag parsing test",
    "fix HTML tag rendering",
    "release lock in mutex",
    "tag parser bug",
  ]) {
    const scope = classifyScope({ role: "implement", readOnly: false, files: ["a.ts"], task })
    assert.equal(scope.externalSideEffect, false, `mislabeled external effect: ${task}`)
    assert.equal(scope.parallelClass, "disjoint-writer", `wrong class: ${task}`)
  }
})

test("V16.17 §5: genuine external effects are still serial-only", () => {
  for (const task of [
    "run npm publish",
    "git push origin main",
    "deploy to production",
    "deploy production",
  ]) {
    const scope = classifyScope({ role: "implement", readOnly: false, files: ["a.ts"], task })
    assert.equal(scope.externalSideEffect, true, `missed external effect: ${task}`)
    assert.equal(scope.parallelClass, "serial-only", `wrong class: ${task}`)
  }
})

test("V16.17 §5: the canonical graph agrees on the same classification", () => {
  const scope = normalizeScope({ id: "x", readOnly: false, writeFiles: ["a.ts"], task: "deploy to production" })
  assert.equal(scope.externalSideEffectDeclared, true)
})

// ---------------------------------------------------------------------------
// §7 Privileged-context fencing
// ---------------------------------------------------------------------------

test("V16.17 §7: a changed privileged prompt changes the runtime epoch", () => {
  const a = buildRuntimeEpoch({ context: "t", tools: ["a"], systemPrompt: "PROMPT V1" })
  const b = buildRuntimeEpoch({ context: "t", tools: ["a"], systemPrompt: "PROMPT V2" })
  assert.notEqual(a.id, b.id)
  assert.deepEqual(runtimeEpochCompatibility(a, b).reasons, ["systemPromptHash-changed"])
})

test("V16.17 §7: the same prompt is stable and deterministic", () => {
  const a = buildRuntimeEpoch({ context: "t", tools: ["a"], systemPrompt: "P" })
  const b = buildRuntimeEpoch({ context: "t", tools: ["a"], systemPrompt: "P" })
  assert.equal(a.id, b.id)
})

test("V16.17 §7: the RPC prompt path is content-addressed", () => {
  const source = readSource("pi/extensions/ues.ts")
  assert.match(source, /RPC_PROMPT_PATH_CACHE = new Map<string, string>\(\)/)
  assert.match(source, /createHash\("sha256"\)\.update\(prompt, "utf8"\)/)
  assert.match(source, /agent \+ "\." \+ hash \+ "\.md"/)
  assert.match(source, /systemPrompt: getAgentPrompt\(agent\)/)
})

// ---------------------------------------------------------------------------
// §8 Cumulative run budget
// ---------------------------------------------------------------------------

test("V16.17 §8: the ledger accumulates spend across waves", () => {
  const ledger = createRunBudgetLedger({
    budget: { maxParallel: 3, deepSeekTurnBudget: { effectiveMaxTurns: 2 } },
    runStartedAt: 1000,
    runWallClockMs: 60_000,
  })
  assert.equal(ledger.reserve({ subprocessSlots: 3, simultaneousCalls: 3, childTurns: 4 }, 2000).admitted, true)
  ledger.settle({ subprocessSlots: 3, simultaneousCalls: 3, childTurns: 4 })
  // The SAME request that fit alone now fails because the run already spent.
  const second = ledger.reserve({ subprocessSlots: 3, simultaneousCalls: 3, childTurns: 4 }, 3000)
  assert.equal(second.admitted, false)
  assert.ok(second.reasons.some((row) => row.signal.startsWith("cumulative-over-")))
})

test("V16.17 §8: ceilings derive from the canonical budget, never a second budget", () => {
  const ceilings = deriveRunCeilings({ maxParallel: 3, deepSeekTurnBudget: { effectiveMaxTurns: 2 } })
  assert.equal(ceilings.simultaneousCalls, 3)
  assert.equal(ceilings.childTurns, 8)
})

test("V16.17 §8: an unmeasured token total is NOT_MEASURED, never zero", () => {
  const ledger = createRunBudgetLedger({ budget: null, runStartedAt: 0, runWallClockMs: 10_000 })
  ledger.settle({ subprocessSlots: 1 })
  const snapshot = ledger.snapshot()
  assert.equal(snapshot.totalTokens, null)
  assert.equal(snapshot.tokensMeasured, false)
  assert.equal(snapshot.tokenProvenance, "NOT_MEASURED")
})

test("V16.17 §8: a measured token total accumulates honestly", () => {
  const ledger = createRunBudgetLedger({ budget: null, runStartedAt: 0, runWallClockMs: 10_000 })
  ledger.settle({ totalTokens: 1500 })
  ledger.settle({ totalTokens: 500 })
  assert.equal(ledger.snapshot().totalTokens, 2000)
  assert.equal(ledger.snapshot().tokensMeasured, true)
})

// ---------------------------------------------------------------------------
// §9 Run wall-clock deadline
// ---------------------------------------------------------------------------

test("V16.17 §9: the run deadline stops optional work but never verification", () => {
  const ledger = createRunBudgetLedger({ budget: null, runStartedAt: 0, runWallClockMs: 5000 })
  assert.equal(ledger.remainingRunMs(2000), 3000)
  const decision = ledger.reserve({ subprocessSlots: 1 }, 6000)
  assert.equal(decision.action, "stop-optional")
  assert.equal(decision.runWallClockExhausted, true)
  assert.equal(decision.verificationIntact, true)
})

test("V16.17 §9: a run without a deadline reports null remaining time", () => {
  const ledger = createRunBudgetLedger({ budget: null })
  assert.equal(ledger.remainingRunMs(999), null)
  assert.equal(ledger.expired(999), false)
})

test("V16.17 §9: the ledger is deterministic for a fixed now", () => {
  const a = createRunBudgetLedger({ budget: null, runStartedAt: 0, runWallClockMs: 1000 })
  const b = createRunBudgetLedger({ budget: null, runStartedAt: 0, runWallClockMs: 1000 })
  assert.deepEqual(a.reserve({ subprocessSlots: 2 }, 5), b.reserve({ subprocessSlots: 2 }, 5))
})

// ---------------------------------------------------------------------------
// §10 Canonical provider usage normalizer
// ---------------------------------------------------------------------------

test("V16.17 §10: an empty usage report is NOT_MEASURED (null), never zero", () => {
  const normalized = normalizeProviderUsage({})
  assert.equal(normalized.provenance, "NOT_MEASURED")
  assert.equal(normalized.totalTokens.value, null)
  assert.equal(normalized.inputTokens.value, null)
})

test("V16.17 §10: a genuine measured zero is preserved distinctly", () => {
  const normalized = normalizeProviderUsage({ usage: { input: 0, output: 0 } })
  assert.equal(normalized.provenance, "MEASURED")
  assert.equal(normalized.totalTokens.value, 0)
})

test("V16.17 §10: a partial report stays partial", () => {
  const normalized = normalizeProviderUsage({ usage: { input: 100 } })
  assert.equal(normalized.inputTokens.value, 100)
  assert.equal(normalized.outputTokens.value, null)
  assert.equal(normalized.partial, true)
})

test("V16.17 §10: DELTA samples sum; CUMULATIVE samples take the last value", () => {
  const delta = normalizeProviderUsage({ usageSamples: [{ input: 100, output: 20 }, { input: 200, output: 40 }] })
  assert.equal(delta.sampleSemantics, SAMPLE_SEMANTICS.DELTA)
  assert.equal(delta.inputTokens.value, 300)
  const cumulative = normalizeProviderUsage({
    usageSamples: [{ input: 100, output: 20 }, { input: 300, output: 60 }],
    semantics: "CUMULATIVE",
  })
  assert.equal(cumulative.sampleSemantics, SAMPLE_SEMANTICS.CUMULATIVE)
  assert.equal(cumulative.inputTokens.value, 300)
  assert.equal(cumulative.outputTokens.value, 60)
})

test("V16.17 §10: a declared UNKNOWN series is NOT_MEASURED", () => {
  const normalized = normalizeProviderUsage({
    usageSamples: [{ input: 1 }, { input: 2 }],
    semantics: "UNKNOWN",
  })
  assert.equal(normalized.provenance, "NOT_MEASURED")
  assert.equal(normalized.totalTokens.value, null)
})

test("V16.17 §10: measuredTokenMetric never returns a fabricated zero", () => {
  assert.equal(measuredTokenMetric({}).provenance, "NOT_MEASURED")
  assert.equal(measuredTokenMetric({}).value, null)
  assert.deepEqual(measuredTokenMetric({ usage: { input: 10, output: 5 } }), { value: 15, provenance: "MEASURED" })
})

test("V16.17 §10: run-telemetry aggregates through the ONE normalizer", () => {
  const aggregate = aggregateUsageSamples([
    { input: 100, output: 20, cacheRead: 30, cacheWrite: 5 },
    { input: 200, output: 40, cacheRead: 50, cacheWrite: 10 },
  ])
  assert.equal(aggregate.input, 300)
  assert.equal(aggregate.output, 60)
  assert.equal(aggregate.totalTokens, 360)
  assert.equal(aggregateUsageSamples([]), null)
})

test("V16.17 §10: normalizedUsageView exposes null for unmeasured fields", () => {
  const view = normalizedUsageView({})
  assert.equal(view.input, null)
  assert.equal(view.totalTokens, null)
  assert.equal(view.measured, false)
  assert.equal(view.usageAccounting, "provider-normalized")
})

// ---------------------------------------------------------------------------
// Source-integrity guards (the new authorities must not be re-forked)
// ---------------------------------------------------------------------------

test("V16.17: there is exactly ONE provider usage normalizer policy string", () => {
  const broker = readSource("lib/external-research-broker-v16-13.mjs")
  assert.match(broker, /provider-usage-normalizer-v16-17\.mjs/)
  // The broker keeps only a shape wrapper; it no longer owns an alias table.
  assert.doesNotMatch(broker, /const pick = \(\.\.\.keys\) =>/)
})

test("V16.17: the conflict graph is imported by delegation-safety and task-graph", () => {
  assert.match(readSource("lib/delegation-safety.mjs"), /execution-conflict-graph-v16-15\.mjs/)
  assert.match(readSource("lib/task-graph.mjs"), /execution-conflict-graph-v16-15\.mjs/)
})
