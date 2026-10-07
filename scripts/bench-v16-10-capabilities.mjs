// V16.10 CAPABILITY BENCHMARK (the six new owners).
//
// QUESTION: do the six V16.10 capabilities actually do bounded, beneficial work
// on representative inputs, and is every claim they make honestly measured?
//
// METHOD: drive each capability owner directly with a deterministic fixture and
// record:
//   * wall-clock ms (MEASURED)
//   * char counts before/after (MEASURED)
//   * provider/token usage (NOT_MEASURED - there is no real telemetry here)
//
// HONESTY LAWS (asserted, not just printed):
//   * Context Kernel compaction must be strictly smaller or refuse.
//   * Tool Output Budgeter must always carry original/visible/omitted + handle.
//   * Metrics V2 token savings must be labeled NOT_MEASURED, never MEASURED.
//   * Nothing here is extrapolated into a total task speedup.
//
// Run: node scripts/bench-v16-10-capabilities.mjs

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { shapeToolOutput } from "../lib/tool-output-budgeter-v16-10.mjs"
import { compactDeterministically, planContextKernel } from "../lib/context-kernel-v16-10.mjs"
import { routeToolIntent } from "../lib/semantic-tool-router-v16-10.mjs"
import { planVerificationLadder } from "../lib/verification-ladder-v16-10.mjs"
import { aggregateEfficiencyMetrics } from "../lib/efficiency-metrics-v16-10.mjs"

const ITERATIONS = Number(process.env.UES_BENCH_ITERS || 50)

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-10-bench-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "bench@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Bench"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function timeIt(fn) {
  const t0 = process.hrtime.bigint()
  const value = fn()
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { value, ms }
}

// A large, repetitive test log - the exact shape a naive truncator mangles.
const BIG_LOG = [
  "# tests 4000",
  "# pass 3900",
  "# fail 100",
  ...Array.from({ length: 4000 }, (_, i) =>
    i % 5 === 0 ? `not ok ${i} - core value expected 1 received 2` : "  at Object.<anonymous> (src/core.mjs:1:1)",
  ),
].join("\n")

// ---------------------------------------------------------------------------
// 1. Tool Output Budgeter
// ---------------------------------------------------------------------------
const budgeter = timeIt(() => shapeToolOutput("bash", BIG_LOG, { budgetChars: 2_000 }))
const budgeterReceipt = budgeter.value.receipt
const budgeterHonest =
  budgeterReceipt.originalChars > budgeterReceipt.visibleChars &&
  budgeterReceipt.truncated === true &&
  budgeter.value.text.includes("omitted")

// ---------------------------------------------------------------------------
// 2. Context Kernel V2 (deterministic compaction)
// ---------------------------------------------------------------------------
const kernel = timeIt(() => compactDeterministically(BIG_LOG, { maxChars: 4_000, handle: "evidence:bench" }))
const kernelHonest = kernel.value.applied && kernel.value.candidateChars < kernel.value.originalChars

const kernelPlan = timeIt(() =>
  planContextKernel(
    [
      { id: "pinned", tier: "pinned", text: "SYSTEM RULES", pinned: true },
      { id: "excerpt-1", tier: "evidence", text: BIG_LOG, priority: 90 },
      { id: "memory-1", tier: "memory", text: "remembered fact", priority: 10 },
    ],
    { budgetChars: 6_000 },
  ),
)

// ---------------------------------------------------------------------------
// 3. Semantic Tool Router
// ---------------------------------------------------------------------------
const ROUTER_UNIVERSE = ["read", "grep", "edit", "write", "bash", "ues_code", "ues_tool_search", "browser_start"]
const router = timeIt(() =>
  routeToolIntent({ task: "find where the budgeter shapes tool output", writer: false, universe: ROUTER_UNIVERSE }),
)
const routerHonest =
  router.value.ranked.every((row) => ROUTER_UNIVERSE.includes(row.tool)) &&
  router.value.deniedTools.length === 0 &&
  router.value.widened === false

// ---------------------------------------------------------------------------
// 4. Verification Ladder
// ---------------------------------------------------------------------------
const ladder = timeIt(() =>
  planVerificationLadder({
    policy: { risk: "low", executionProfile: "fast" },
    changedFiles: ["src/core.mjs"],
    independentVerifierAvailable: false,
  }),
)
const ladderHonest = Array.isArray(ladder.value.rungs) && ladder.value.rungs.length >= 4

// ---------------------------------------------------------------------------
// 5. Repo Intelligence (cache key + warm path)
// ---------------------------------------------------------------------------
const root = fixture()
let repoIntelMs = null
let repoIntelOk = null
try {
  const { buildRepoIntelligence } = await import("../lib/repo-intelligence-v16-10.mjs")
  const t0 = process.hrtime.bigint()
  const result = await buildRepoIntelligence(root, "core value", { limit: 5 })
  repoIntelMs = Number(process.hrtime.bigint() - t0) / 1e6
  repoIntelOk = Array.isArray(result?.files)
} catch (error) {
  repoIntelOk = false
  repoIntelMs = null
}

// ---------------------------------------------------------------------------
// 6. Metrics V2 (honest aggregation of the receipts above)
// ---------------------------------------------------------------------------
const metrics = aggregateEfficiencyMetrics(
  [
    {
      type: "efficiency.observation",
      kind: "tool-output-budgeter",
      metrics: { beforeChars: BIG_LOG.length, afterChars: budgeter.value.text.length },
      provenance: { beforeChars: "MEASURED", afterChars: "MEASURED" },
      outcome: "PASS",
    },
    {
      type: "efficiency.observation",
      kind: "context-kernel",
      metrics: { beforeChars: BIG_LOG.length, afterChars: kernel.value.candidateChars },
      provenance: { beforeChars: "MEASURED", afterChars: "MEASURED" },
      outcome: "PASS",
    },
  ],
  [{ type: "task.telemetry", outcome: { passed: true }, metrics: {} }],
)
const metricsHonest =
  metrics.tokens.tokenSavings.provenance === "NOT_MEASURED" &&
  metrics.qualityClaim === "NOT_INFERRED_FROM_EFFICIENCY"

// ---------------------------------------------------------------------------
// Assertions: the honesty laws must hold for the benchmark to be meaningful.
// ---------------------------------------------------------------------------
const honestyChecks = {
  "budgeter-reports-omission": Boolean(budgeterHonest),
  "kernel-compaction-beneficial": Boolean(kernelHonest),
  "router-respects-universe": Boolean(routerHonest),
  "ladder-lists-rungs": Boolean(ladderHonest),
  "metrics-token-savings-not-measured": Boolean(metricsHonest),
  "repo-intelligence-returns-files": repoIntelOk === true,
}
const allHonest = Object.values(honestyChecks).every(Boolean)

rmSync(root, { recursive: true, force: true })

console.log(
  JSON.stringify(
    {
      policy: "v16-10-capability-benchmark",
      iterations: ITERATIONS,
      measured: {
        toolOutputBudgeterMs: Number(budgeter.ms.toFixed(3)),
        contextKernelCompactMs: Number(kernel.ms.toFixed(3)),
        contextKernelPlanMs: Number(kernelPlan.ms.toFixed(3)),
        semanticToolRouterMs: Number(router.ms.toFixed(3)),
        verificationLadderMs: Number(ladder.ms.toFixed(3)),
        repoIntelligenceMs: repoIntelMs === null ? null : Number(repoIntelMs.toFixed(3)),
      },
      charSavings: {
        toolOutputBudgeter: {
          before: budgeterReceipt.originalChars,
          after: budgeterReceipt.visibleChars,
          strategy: budgeter.value.strategy || null,
          truncated: budgeterReceipt.truncated,
        },
        contextKernel: {
          before: kernel.value.originalChars,
          after: kernel.value.candidateChars,
          reason: kernel.value.reason,
        },
      },
      router: { top: router.value.primary, count: router.value.ordered.length, confidence: router.value.confidence },
      ladder: { required: ladder.value.requiredStrength, rungs: (ladder.value.rungs || []).map((r) => r.rung) },
      metrics: {
        observations: metrics.observations,
        tokenSavingsProvenance: metrics.tokens.tokenSavings.provenance,
        qualityClaim: metrics.qualityClaim,
      },
      repoIntelligenceOk: repoIntelOk,
      honestyChecks,
      providerTokens: "NOT_MEASURED",
      measured_: allHonest,
    },
    null,
    2,
  ),
)

if (!allHonest) process.exitCode = 1
