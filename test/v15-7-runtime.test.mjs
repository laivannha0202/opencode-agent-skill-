import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import test from "node:test"

import { analyzeShellCommand, boundedVerificationTimeout } from "../lib/command-intelligence.mjs"
import { routeToolContent } from "../lib/content-router-v2.mjs"
import { cacheAwareVisibleBudget, cacheStabilityFromRows } from "../lib/provider-cache-stability.mjs"
import { solutionEconomyContract } from "../lib/solution-economy.mjs"
import { buildEfficiencyEvent, efficiencySummary } from "../lib/efficiency-ledger.mjs"
import { recordTaskTelemetry } from "../lib/run-telemetry.mjs"
import { buildRuntimeEpoch, runtimeEpochCompatibility } from "../lib/runtime-epoch.mjs"
import { createRunJournal, appendRunJournalEvent } from "../lib/run-journal.mjs"
import { learnRuntimeWaste } from "../lib/runtime-waste-learner.mjs"
import { assertExecutionOwnership, claimExecutionOwnership, pruneExecutionOwnership, releaseExecutionOwnership } from "../lib/execution-ownership.mjs"
import { inspectRunRows } from "../lib/run-inspector.mjs"
import { reduceCommandOutput } from "../lib/performance-fabric.mjs"

test("V15.7 command intelligence detects hidden verification progress", () => {
  const analysis = analyzeShellCommand("npm test 2>&1 | grep -v progress | tail -45", {
    verificationTimeoutSec: 300,
  })
  assert.equal(analysis.verificationLike, true)
  assert.equal(analysis.hidesProgress, true)
  assert.equal(analysis.finding, "verification-output-hidden-by-pipeline")
  assert.equal(analysis.recommendedTimeoutSec, 300)
})

test("V15.7 command intelligence ignores pipe text inside quotes", () => {
  const analysis = analyzeShellCommand(
    'npm test -- --testNamePattern="renders | tail literally"',
    { verificationTimeoutSec: 300 },
  )
  assert.equal(analysis.verificationLike, true)
  assert.equal(analysis.hidesProgress, false)
  assert.equal(analysis.finding, null)

  const quotedOnly = analyzeShellCommand('echo "pytest | tail -20"')
  assert.equal(quotedOnly.verificationLike, false)
  assert.equal(quotedOnly.hidesProgress, false)
})

test("V15.7 command intelligence catches workspace-filtered test pipelines", () => {
  const analysis = analyzeShellCommand(
    "npm --filter @agrimarket/api test 2>&1 | grep -v progress | tail -45",
    { verificationTimeoutSec: 300 },
  )
  assert.equal(analysis.verificationLike, true)
  assert.equal(analysis.hidesProgress, true)
  assert.equal(analysis.recommendedTimeoutSec, 300)
  assert.equal(analysis.finding, "verification-output-hidden-by-pipeline")
})

test("V15.7 verification timeout clamp bounds the former 5400s hang case", () => {
  const analysis = analyzeShellCommand(
    "npm --filter @agrimarket/api test 2>&1 | grep -v progress | tail -45",
    { verificationTimeoutSec: 300 },
  )
  assert.equal(boundedVerificationTimeout(analysis, 5400, 300), 300)
  assert.equal(boundedVerificationTimeout(analysis, 120, 300), 120)
  assert.equal(boundedVerificationTimeout(analysis, undefined, 300), 300)
  const ordinary = analyzeShellCommand("node scripts/one-shot.mjs")
  assert.equal(boundedVerificationTimeout(ordinary, 5400, 300), 5400)
})

test("V15.7 package-manager verification families drive content routing", () => {
  const npmTest = analyzeShellCommand("npm --filter @agrimarket/api test")
  const pnpmTypecheck = analyzeShellCommand("pnpm --filter web run typecheck")
  const yarnBuild = analyzeShellCommand("yarn run build")
  assert.equal(npmTest.verificationFamily, "test")
  assert.equal(pnpmTypecheck.verificationFamily, "diagnostics")
  assert.equal(yarnBuild.verificationFamily, "build")

  assert.equal(routeToolContent("Tests: 12 passed", {
    command: "npm --filter @agrimarket/api test",
    phase: "verify",
  }).contentType, "test")
  assert.equal(routeToolContent("Found 0 errors.", {
    command: "pnpm --filter web run typecheck",
    phase: "verify",
  }).contentType, "diagnostics")
  assert.equal(routeToolContent("compiled successfully", {
    command: "yarn run build",
    phase: "verify",
  }).contentType, "build")

  const reduced = reduceCommandOutput("PASS api\nTests: 12 passed, 12 total\nTime: 1.2s", {
    command: "npm --filter @agrimarket/api test",
  })
  assert.equal(reduced.family, "npm-test")
  assert.ok(reduced.rows.some((row) => /Tests:/i.test(row)))
})

test("V15.7 content router preserves more semantic diff evidence than noisy JSON", () => {
  const diff = routeToolContent("diff --git a/a.ts b/a.ts\n+const x = 1", {
    command: "git diff",
    phase: "verify",
  })
  const json = routeToolContent(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ i }))), {
    command: "tool --json",
  })
  assert.equal(diff.contentType, "diff")
  assert.equal(json.contentType, "json")
  assert.ok(diff.budgetMultiplier > json.budgetMultiplier)
  assert.equal(diff.cacheZone, "live")
})

test("V15.7 cache policy is measurement gated and cache aware", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    type: "task.telemetry",
    model: "provider/model",
    metrics: { inputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 100 + index },
  }))
  const policy = cacheStabilityFromRows(rows, { model: "provider/model", minSamples: 4 })
  assert.equal(policy.mode, "cache")
  assert.equal(policy.evidence, "MEASURED")
  const routed = cacheAwareVisibleBudget(24000, { budgetMultiplier: 0.75 }, policy)
  assert.ok(routed >= 8192)
  assert.ok(routed < 24000)
})

test("V15.7 runtime epoch fences provider cache policy changes", () => {
  const input = {
    policySnapshotId: "policy:1",
    workspaceFingerprint: "workspace:1",
    context: "task",
    tools: ["read", "bash"],
    skills: ["typescript"],
    modelProfile: { surface: "compact" },
    model: "provider/model",
    thinking: "low",
  }
  const cache = buildRuntimeEpoch({ ...input, cachePolicy: { mode: "cache", evidence: "MEASURED" } })
  const token = buildRuntimeEpoch({ ...input, cachePolicy: { mode: "token", evidence: "MEASURED" } })
  const compatibility = runtimeEpochCompatibility(cache, token)
  assert.equal(compatibility.compatible, false)
  assert.ok(compatibility.reasons.includes("cachePolicyHash-changed"))

  const sameDecisionNewSample = buildRuntimeEpoch({
    ...input,
    cachePolicy: {
      mode: "cache",
      evidence: "MEASURED",
      samples: 999,
      cacheReadRatio: 0.91,
      preserveStablePrefix: true,
      compactLiveZoneOnly: true,
      usageAccounting: "pi-normalized-disjoint",
    },
  })
  assert.equal(runtimeEpochCompatibility(cache, sameDecisionNewSample).compatible, true)
})

test("V15.7 solution economy remains safety first", () => {
  const contract = solutionEconomyContract({ role: "executor", risk: "high" })
  assert.equal(contract.active, true)
  assert.equal(contract.mode, "safety-first")
  assert.match(contract.text, /Never simplify away/)
  assert.match(contract.text, /correctness and independent verification dominate economy/)
})

test("V15.7 efficiency ledger labels measured and derived evidence honestly", () => {
  const row = buildEfficiencyEvent({
    kind: "task",
    inputTokens: 1000,
    cacheReadTokens: 600,
    cacheWriteTokens: 100,
    usageAccounting: "pi-normalized-disjoint",
    outputTokens: 50,
    beforeChars: 20000,
    afterChars: 8000,
  })
  assert.equal(row.metrics.uncachedInputTokens, 1000)
  assert.equal(row.provenance.providerTokens, "MEASURED")
  assert.equal(row.provenance.uncachedInputTokens, "DERIVED_FROM_MEASURED")
  assert.equal(row.provenance.quality, "NOT_MEASURED")
})

test("V15.7 runtime waste learner reports only observed evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v157-waste-"))
  try {
    await createRunJournal(root, {
      runId: "run-a",
      taskHash: "task-a",
      workspaceFingerprint: "workspace",
      executionProfile: "standard",
      risk: "medium",
    })
    for (let i = 0; i < 3; i += 1) {
      await appendRunJournalEvent(root, "run-a", "tool.started", {
        toolCallId: "read-" + i,
        tool: "read",
        inputHash: "same-read",
        queuedMs: 0,
      })
      await appendRunJournalEvent(root, "run-a", "tool.completed", {
        toolCallId: "read-" + i,
        tool: "read",
      })
    }
    await appendRunJournalEvent(root, "run-a", "command.intelligence", {
      toolCallId: "verify-1",
      tool: "bash",
      finding: "verification-output-hidden-by-pipeline",
      progressVisibility: "reduced-by-shell-pipeline",
    })
    await recordTaskTelemetry(root, {
      exitCode: 0,
      verdict: "PASS",
      durationMs: 100,
      model: "provider/model",
      usage: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50 },
      toolCalls: 3,
      providerRecoveryAttempts: 1,
    }, {
      runId: "run-a",
      task: "test task",
      verifierPass: true,
      falsePassDetected: false,
    })
    const report = await learnRuntimeWaste(root, { limit: 10 })
    assert.equal(report.runsInspected, 1)
    assert.ok(report.findings.some((row) => row.kind === "repeated-tool-work"))
    assert.ok(report.findings.some((row) => row.kind === "provider-recovery-cost"))
    assert.ok(report.findings.some((row) => row.kind === "hidden-output-verification-pipeline"))
    assert.equal(report.efficiency.measuredProviderTokenRows >= 1, true)
    assert.ok(report.unavailable.includes("exact-tool-schema-token-tax"))
    assert.ok(report.unavailable.includes("provider-stage-latency"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.7 durable execution ownership fences expired and replaced runtimes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v157-owner-"))
  const scope = "epoch:test-owner"
  const ownerA = "owner:test-a"
  const ownerB = "owner:test-b"
  try {
    const first = await claimExecutionOwnership(root, scope, ownerA, {
      nowMs: 1_000,
      ttlMs: 1_000,
      ownerPid: process.pid,
      runtimeEpochId: scope,
    })
    assert.equal(first.lease.stolenFromExpiredOwner, false)
    await assertExecutionOwnership(root, scope, ownerA, {
      nowMs: 1_500,
      runtimeEpochId: scope,
    })
    await assert.rejects(
      assertExecutionOwnership(root, scope, ownerA, {
        nowMs: 2_001,
        runtimeEpochId: scope,
      }),
      (error) => error?.code === "UES_EXECUTION_OWNERSHIP_EXPIRED",
    )

    const replacement = await claimExecutionOwnership(root, scope, ownerB, {
      nowMs: 2_001,
      ttlMs: 1_000,
      ownerPid: process.pid,
      runtimeEpochId: scope,
    })
    assert.equal(replacement.lease.stolenFromExpiredOwner, true)
    await assert.rejects(
      assertExecutionOwnership(root, scope, ownerA, {
        nowMs: 2_100,
        runtimeEpochId: scope,
      }),
      (error) => error?.code === "UES_EXECUTION_OWNERSHIP_STALE",
    )
    await assertExecutionOwnership(root, scope, ownerB, {
      nowMs: 2_100,
      runtimeEpochId: scope,
    })
  } finally {
    await releaseExecutionOwnership(root, scope, ownerA).catch(() => null)
    await releaseExecutionOwnership(root, scope, ownerB).catch(() => null)
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.7 trajectory intelligence separates repeated reads searches and mutations", () => {
  const rows = [
    { type: "tool.started", toolCallId: "r1", tool: "read", inputHash: "same-read", queuedMs: 0, concurrencyClass: "READ_PARALLEL_SAFE" },
    { type: "tool.completed", toolCallId: "r1", tool: "read" },
    { type: "tool.started", toolCallId: "r2", tool: "read", inputHash: "same-read", queuedMs: 0, concurrencyClass: "READ_PARALLEL_SAFE" },
    { type: "tool.completed", toolCallId: "r2", tool: "read" },
    { type: "tool.started", toolCallId: "s1", tool: "grep", inputHash: "same-search", queuedMs: 0, concurrencyClass: "READ_PARALLEL_SAFE" },
    { type: "tool.completed", toolCallId: "s1", tool: "grep" },
    { type: "tool.started", toolCallId: "s2", tool: "grep", inputHash: "same-search", queuedMs: 0, concurrencyClass: "READ_PARALLEL_SAFE" },
    { type: "tool.completed", toolCallId: "s2", tool: "grep" },
    { type: "tool.started", toolCallId: "w1", tool: "edit", inputHash: "same-write", queuedMs: 0, concurrencyClass: "WRITE_SERIAL" },
    { type: "tool.completed", toolCallId: "w1", tool: "edit" },
    { type: "tool.started", toolCallId: "w2", tool: "edit", inputHash: "same-write", queuedMs: 0, concurrencyClass: "WRITE_SERIAL" },
    { type: "tool.failed", toolCallId: "w2", tool: "edit" },
    { type: "tool.blocked", toolCallId: "b1", tool: "bash", reason: "stale-execution-owner" },
    { type: "tool.interrupted", toolCallId: "i1", tool: "bash" },
  ]
  const inspected = inspectRunRows(rows)
  assert.equal(inspected.schemaVersion, 2)
  assert.equal(inspected.repeatedReadSignatures.length, 1)
  assert.equal(inspected.repeatedSearchSignatures.length, 1)
  assert.equal(inspected.repeatedMutationSignatures.length, 1)
  assert.equal(inspected.blockedTools, 1)
  assert.equal(inspected.interruptedTools, 1)
  assert.equal(inspected.failedTools, 1)
})

test("V15.7 execution ownership fences stale runtimes without blind takeover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v157-owner-"))
  const scope = "epoch:test-owner"
  try {
    const first = await claimExecutionOwnership(root, scope, "owner:a", {
      ttlMs: 1000,
      nowMs: 1000,
      ownerPid: process.pid,
      runtimeEpochId: scope,
    })
    assert.equal(first.lease.generation, 1)
    await assertExecutionOwnership(root, scope, "owner:a", {
      nowMs: 1500,
      runtimeEpochId: scope,
    })
    await assert.rejects(
      claimExecutionOwnership(root, scope, "owner:b", {
        ttlMs: 1000,
        nowMs: 1500,
        ownerPid: process.pid,
        runtimeEpochId: scope,
      }),
      (error) => error?.code === "UES_EXECUTION_OWNERSHIP_CONFLICT",
    )

    const takeover = await claimExecutionOwnership(root, scope, "owner:b", {
      ttlMs: 1000,
      nowMs: 2501,
      ownerPid: process.pid,
      runtimeEpochId: scope,
    })
    assert.equal(takeover.lease.generation, 2)
    assert.equal(takeover.lease.stolenFromExpiredOwner, true)
    await assert.rejects(
      assertExecutionOwnership(root, scope, "owner:a", {
        nowMs: 2501,
        runtimeEpochId: scope,
      }),
      (error) => error?.code === "UES_EXECUTION_OWNERSHIP_STALE",
    )
    await releaseExecutionOwnership(root, scope, "owner:a")
    const released = await releaseExecutionOwnership(root, scope, "owner:b")
    assert.equal(released.released, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.7 stale execution ownership artifacts are bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v157-owner-gc-"))
  try {
    const scope = "epoch:orphan::run::dead"
    await claimExecutionOwnership(root, scope, "owner:dead", {
      nowMs: 1_000,
      ttlMs: 1_000,
      ownerPid: 2_147_483_647,
      runtimeEpochId: "epoch:orphan",
    })
    const gc = await pruneExecutionOwnership(root, { nowMs: 3_000 })
    assert.equal(gc.removedCount, 1)
    assert.equal(gc.active, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.7 task telemetry feeds the efficiency ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v157-ledger-"))
  try {
    await recordTaskTelemetry(root, {
      exitCode: 0,
      verdict: "PASS",
      durationMs: 123,
      model: "provider/model",
      usage: { input: 2000, output: 100, cacheRead: 1000, cacheWrite: 100 },
      toolCalls: 4,
    }, { runId: "run-ledger", task: "task", verifierPass: true, falsePassDetected: false })
    const summary = await efficiencySummary(root)
    assert.equal(summary.observations, 1)
    assert.equal(summary.measuredProviderTokenRows, 1)
    assert.equal(summary.inputTokens, 2000)
    assert.equal(summary.uncachedInputTokens, 2000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
