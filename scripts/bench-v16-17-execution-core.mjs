// V16.17 EXECUTION-CORE CONSOLIDATION BENCHMARK.
//
// HONESTY CONTRACT (inherited from V16.12–V16.16, NOT weakened):
//
//   1. MEASURED means a real wall-clock observation of real code on this machine.
//   2. SIMULATED means a deterministic decision model (counts only, `ms: null`).
//   3. SYNTHETIC means the real modules under test with synthetic scopes.
//   4. LIVE means a real child process and/or a real Git repository.
//   5. PROVIDER TOKENS ARE NEVER REPORTED. This bench never talks to a provider,
//      so every token figure is NOT_MEASURED and the report says so.
//   6. THERE IS NO COMBINED SPEEDUP NUMBER. Cells are per scenario.
//   7. A cell that cannot be measured reports `ms: null`, never a fabricated 0.
//   8. A cell that declares an expectation is checked; failures are counted and
//      the bench exits non-zero.
//
// The point of this bench is NOT to claim a speedup. It is to show that the
// consolidation is real and cheap:
//   * the conflict authority answers a pair in bounded time;
//   * the wave builder compiles conflict inputs once (no per-candidate rebuild);
//   * the provider normalizer is deterministic and constant-time per report;
//   * the run ledger admits/settles in bounded time.
//
// Run: node scripts/bench-v16-17-execution-core.mjs

import { performance } from "node:perf_hooks";

import { buildDelegationWaves } from "../lib/delegation-safety.mjs";
import { classifyPair, normalizeScope, PAIR_VERDICT } from "../lib/execution-conflict-graph-v16-15.mjs";
import { computeSafeWaves } from "../lib/task-graph.mjs";
import { buildRuntimeEpoch } from "../lib/runtime-epoch.mjs";
import { createRunBudgetLedger } from "../lib/run-budget-ledger-v16-17.mjs";
import {
  normalizeProviderUsage,
  normalizedUsageView,
} from "../lib/provider-usage-normalizer-v16-17.mjs";

const PROVIDER_TOKENS = "NOT_MEASURED";
const cells = [];
const failures = [];

function measure(label, iterations, fn) {
  // Warm-up so the first-call JIT does not dominate a short loop.
  for (let i = 0; i < Math.min(iterations, 50); i += 1) fn(i);
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) fn(i);
  const ms = performance.now() - start;
  return { label, iterations, ms: Number(ms.toFixed(3)), perOpUs: Number(((ms * 1000) / iterations).toFixed(3)) };
}

function check(label, condition, detail) {
  if (!condition) failures.push({ label, detail });
  return condition;
}

// ---------------------------------------------------------------------------
// Cell 1: conflict verdict throughput (MEASURED, SYNTHETIC scopes)
// ---------------------------------------------------------------------------

{
  const a = normalizeScope({ id: "a", readOnly: false, writeFiles: ["lib/a.mjs"] });
  const b = normalizeScope({ id: "b", readOnly: false, writeFiles: ["lib/b.mjs"] });
  const result = measure("conflict-pair-verdict", 20_000, () => classifyPair(a, b));
  const pair = classifyPair(a, b);
  check("conflict-pair-verdict", pair.verdict === PAIR_VERDICT.INDEPENDENT, `unexpected verdict ${pair.verdict}`);
  cells.push({ cell: "conflict-pair-verdict", kind: "MEASURED+SYNTHETIC", ...result });
}

// ---------------------------------------------------------------------------
// Cell 2: wave builder compiles conflict inputs once (MEASURED, SYNTHETIC)
// ---------------------------------------------------------------------------

{
  const scopes = Array.from({ length: 8 }, (_, i) => ({
    id: `w${i}`,
    childId: `w${i}`,
    role: "implement",
    readOnly: false,
    files: [`lib/pkg${i}/file.mjs`],
    task: `edit lib/pkg${i}/file.mjs`,
  }));
  const result = measure("wave-build-8-writers", 500, () => buildDelegationWaves(scopes));
  const waves = buildDelegationWaves(scopes);
  // The writer bound is hard (default 2): 8 independent writers must all be
  // admitted (no writer dropped) and every wave must respect the bound.
  const admitted = waves.waves.flatMap((w) => w.scopes);
  check(
    "wave-build-8-writers",
    admitted.length === 8 && new Set(admitted).size === 8 && waves.waves.every((w) => w.scopes.length <= 2),
    `8 independent writers must all be admitted within the bound (got ${admitted.length} across ${waves.waves.length} waves)`,
  );
  cells.push({ cell: "wave-build-8-writers", kind: "MEASURED+SYNTHETIC", ...result });
}

// ---------------------------------------------------------------------------
// Cell 3: task-graph wave planning delegates to the conflict graph (MEASURED)
// ---------------------------------------------------------------------------

{
  const task = (id) => ({ id, title: id, summary: id, files: { modify: [`lib/${id}.js`] }, dependsOn: [], acceptance: ["x"], verification: ["y"], risk: "low" });
  const plan = { schemaVersion: 1, goal: "g", tasks: [task("a"), task("b"), task("c"), task("d")] };
  const result = measure("task-graph-4-task-waves", 500, () => computeSafeWaves(plan));
  const waves = computeSafeWaves(plan);
  check("task-graph-4-task-waves", waves.waves.length === 1, "independent tasks must share one wave");
  cells.push({ cell: "task-graph-4-task-waves", kind: "MEASURED", ...result });
}

// ---------------------------------------------------------------------------
// Cell 4: provider usage normalization (MEASURED, deterministic)
// ---------------------------------------------------------------------------

{
  const report = { usageSamples: [{ input: 100, output: 20 }, { input: 200, output: 40 }] };
  const result = measure("provider-usage-normalize", 50_000, () => normalizeProviderUsage(report));
  const normalized = normalizeProviderUsage(report);
  check("provider-usage-normalize", normalized.inputTokens.value === 300 && normalized.sampleSemantics === "DELTA", "delta samples must sum");
  // Determinism proof.
  const a = JSON.stringify(normalizedUsageView(report));
  const b = JSON.stringify(normalizedUsageView(report));
  check("provider-usage-normalize", a === b, "normalizer must be deterministic");
  cells.push({ cell: "provider-usage-normalize", kind: "MEASURED+SYNTHETIC", ...result });
}

// ---------------------------------------------------------------------------
// Cell 5: run ledger reserve+settle (MEASURED, deterministic)
// ---------------------------------------------------------------------------

{
  const budget = { maxParallel: 3, deepSeekTurnBudget: { effectiveMaxTurns: 2 } };
  const result = measure("run-ledger-reserve-settle", 20_000, () => {
    const ledger = createRunBudgetLedger({ budget, runStartedAt: 0, runWallClockMs: 60_000 });
    ledger.reserve({ subprocessSlots: 1 }, 1);
    ledger.settle({ subprocessSlots: 1, totalTokens: 100 });
    return ledger.snapshot();
  });
  const ledger = createRunBudgetLedger({ budget, runStartedAt: 0, runWallClockMs: 60_000 });
  ledger.settle({ subprocessSlots: 1 });
  check("run-ledger-reserve-settle", ledger.snapshot().totalTokens === null, "unmeasured tokens must stay null");
  cells.push({ cell: "run-ledger-reserve-settle", kind: "MEASURED+SYNTHETIC", ...result });
}

// ---------------------------------------------------------------------------
// Cell 6: runtime epoch with privileged prompt hash (MEASURED)
// ---------------------------------------------------------------------------

{
  const result = measure("runtime-epoch-with-prompt", 20_000, () => buildRuntimeEpoch({ context: "t", tools: ["a", "b"], systemPrompt: "PROMPT" }));
  const a = buildRuntimeEpoch({ context: "t", systemPrompt: "A" });
  const b = buildRuntimeEpoch({ context: "t", systemPrompt: "B" });
  check("runtime-epoch-with-prompt", a.id !== b.id, "prompt change must change the epoch");
  cells.push({ cell: "runtime-epoch-with-prompt", kind: "MEASURED", ...result });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const report = {
  benchmark: "v16-17-execution-core",
  synthetic: true,
  providerTokens: PROVIDER_TOKENS,
  note: "No provider was contacted. Every token figure is NOT_MEASURED. Cells are per scenario; there is no combined speedup number.",
  cells,
  failures,
  ok: failures.length === 0,
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(report.ok ? 0 : 1);
