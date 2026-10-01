import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import test from "node:test"

import { analyzeShellCommand } from "../lib/command-intelligence.mjs"
import { routeToolContent } from "../lib/content-router-v2.mjs"
import { cacheAwareVisibleBudget, cacheStabilityFromRows } from "../lib/provider-cache-stability.mjs"
import { solutionEconomyContract } from "../lib/solution-economy.mjs"
import { buildEfficiencyEvent, efficiencySummary } from "../lib/efficiency-ledger.mjs"
import { recordTaskTelemetry } from "../lib/run-telemetry.mjs"
import { buildRuntimeEpoch, runtimeEpochCompatibility } from "../lib/runtime-epoch.mjs"
import { createRunJournal, appendRunJournalEvent } from "../lib/run-journal.mjs"
import { learnRuntimeWaste } from "../lib/runtime-waste-learner.mjs"

test("V15.7 command intelligence detects hidden verification progress", () => {
  const analysis = analyzeShellCommand("npm test 2>&1 | grep -v progress | tail -45", {
    verificationTimeoutSec: 300,
  })
  assert.equal(analysis.verificationLike, true)
  assert.equal(analysis.hidesProgress, true)
  assert.equal(analysis.finding, "verification-output-hidden-by-pipeline")
  assert.equal(analysis.recommendedTimeoutSec, 300)
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
    uncachedInputTokens: 1000,
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
