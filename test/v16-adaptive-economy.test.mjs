import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { compileToolSurface, coreToolPriorities, summarizeToolUtilizationRows } from "../lib/tool-surface-economy.mjs"
import { observeSeenContext, lineDelta, resetSeenContextLedger } from "../lib/seen-context-ledger.mjs"
import { compileAdaptiveStrategy, strategyPerformanceKey } from "../lib/adaptive-strategy.mjs"
import { modelRuntimeProfile } from "../lib/model-runtime-profile.mjs"
import { normalizePerformanceHistory, recordStrategyPerformanceOutcome } from "../lib/model-performance.mjs"
import { governToolOutput } from "../lib/tool-output-governor.mjs"

test("V16.2 execution surfaces are bounded by model x execution profile", () => {
  assert.equal(modelRuntimeProfile("unknown/model", { surface: "compact", executionProfile: "fast" }).maxAdvertisedTools, 7)
  assert.equal(modelRuntimeProfile("unknown/model", { surface: "compact", executionProfile: "standard" }).maxAdvertisedTools, 9)
  assert.equal(modelRuntimeProfile("unknown/model", { surface: "compact", executionProfile: "deep" }).maxAdvertisedTools, 10)
  assert.equal(modelRuntimeProfile("unknown/model", { surface: "balanced", executionProfile: "fast" }).maxAdvertisedTools, 8)
  assert.equal(modelRuntimeProfile("unknown/model", { surface: "balanced", executionProfile: "deep" }).maxAdvertisedTools, 15)
  assert.equal(modelRuntimeProfile("unknown/model", { surface: "expanded", executionProfile: "deep" }).maxAdvertisedTools, 20)
})

test("V16.2 stable tool surface is independent of candidate input order", () => {
  const tools = ["write", "read", "grep", "bash", "edit", "ues_code", "ues_service", "find", "ls", "powershell", "ues_code_edit"]
  const profile = { maxAdvertisedTools: 7, surface: "compact" }
  const options = { task: "fix a small bug", writer: true, executionProfile: "fast", platform: "win32", attempt: 1 }
  const a = compileToolSurface(tools, profile, coreToolPriorities(tools, options), options)
  const reversed = [...tools].reverse()
  const b = compileToolSurface(reversed, profile, coreToolPriorities(reversed, options), options)
  assert.deepEqual(a.advertised, b.advertised)
  assert.equal(a.schemaPrefixHash, b.schemaPrefixHash)
  assert.ok(a.advertised.length <= 7)
  assert.ok(a.deferred.length > 0)
  assert.equal(a.schemaTax.evidence, "ESTIMATED")
})

test("V16.2 retry reveals tools gradually and utilization is measurable", () => {
  const tools = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "ues_code", "ues_code_edit", "ues_service", "ues_evidence_get"]
  const profile = { maxAdvertisedTools: 7, surface: "compact" }
  const core = coreToolPriorities(tools, { task: "debug service bug", writer: true, executionProfile: "standard", platform: "win32" })
  const first = compileToolSurface(tools, profile, core, { task: "debug service bug", writer: true, executionProfile: "standard", attempt: 1 })
  const retry = compileToolSurface(tools, profile, core, { task: "debug service bug", writer: true, executionProfile: "standard", attempt: 2 })
  assert.ok(retry.advertised.length >= first.advertised.length)
  assert.ok(retry.advertised.length <= first.advertised.length + 2)

  const summary = summarizeToolUtilizationRows([
    { type: "task.telemetry", model: "m", role: "executor", metrics: { advertisedToolNames: ["read", "grep", "write"], usedToolNames: ["read", "write"] } },
    { type: "task.telemetry", model: "m", role: "executor", metrics: { advertisedToolNames: ["read", "grep", "write"], usedToolNames: ["read"] } },
  ], { model: "m", role: "executor", minRuns: 2, minToolExposures: 1 })
  assert.equal(summary.evidence, "MEASURED")
  assert.equal(summary.tools.read.utilizationRatio, 1)
  assert.equal(summary.tools.grep.utilizationRatio, 0)
  assert.equal(summary.tools.write.utilizationRatio, 0.5)
})

test("V16.4 seen context ledger distinguishes NEW UNCHANGED and CHANGED", () => {
  resetSeenContextLedger("test")
  const first = observeSeenContext("test", "read:file", "alpha\nbeta")
  const same = observeSeenContext("test", "read:file", "alpha\nbeta")
  const changed = observeSeenContext("test", "read:file", "alpha\ngamma")
  assert.equal(first.state, "NEW")
  assert.equal(same.state, "UNCHANGED")
  assert.equal(changed.state, "CHANGED")
  const delta = lineDelta(changed.previousText, "alpha\ngamma")
  assert.equal(delta.changed, true)
  assert.ok(delta.changedLines > 0)
})

test("V16.3 retry strategy changes a failed edit dimension", () => {
  const first = compileAdaptiveStrategy({
    model: "provider/free",
    surface: "compact",
    role: "executor",
    writer: true,
    task: "fix login condition",
    taskClass: "debugging",
    executionProfile: "standard",
    attempt: 1,
  })
  const retry = compileAdaptiveStrategy({
    model: "provider/free",
    surface: "compact",
    role: "executor",
    writer: true,
    task: "fix login condition",
    taskClass: "debugging",
    executionProfile: "standard",
    attempt: 2,
    recentFailure: "patch could not apply because context mismatch",
  })
  assert.notEqual(retry.editStrategy, first.editStrategy)
  assert.equal(retry.retryPolicy, "change-one-or-more-failed-dimensions")
})

test("V16.6 strategy performance survives normalization", () => {
  const profile = {
    editStrategy: "symbol-edit",
    toolSurface: "compact",
    contextStrategy: "delta-tools-stable-prefix",
    executionProfile: "standard",
    searchStrategy: "symbol-first",
  }
  const key = strategyPerformanceKey(profile, "debugging")
  const history = recordStrategyPerformanceOutcome({}, {
    model: "provider/model",
    strategyKey: key,
    passed: true,
    retries: 0,
    tokens: 1200,
    latencyMs: 800,
  })
  const normalized = normalizePerformanceHistory(history)
  assert.equal(normalized["provider/model"][key].samples, 1)
  assert.equal(normalized["provider/model"][key].passRate, 1)
})

test("V16.4 tool governor deduplicates only within the same reversible session scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v16-delta-"))
  try {
    const raw = Array.from({ length: 120 }, (_, index) => `line ${index + 1}: stable content for delta context verification`).join("\n")
    const options = {
      toolName: "read",
      command: "read src/example.ts",
      phase: "execute",
      sessionId: "epoch:test",
      runId: "run:test",
      baseMaxChars: 24 * 1024,
    }
    const first = await governToolOutput(root, raw, options)
    const repeated = await governToolOutput(root, raw, options)
    assert.equal(first.compacted, false)
    assert.equal(first.deltaState, "NEW")
    assert.equal(repeated.compacted, true)
    assert.equal(repeated.deduplicated, true)
    assert.equal(repeated.deltaState, "UNCHANGED")
    assert.match(String(repeated.evidenceRef || ""), /^ues-store:/)

    const changedRaw = raw.replace("line 60: stable content", "line 60: changed content")
    const changed = await governToolOutput(root, changedRaw, options)
    assert.equal(changed.compacted, true)
    assert.equal(changed.deltaState, "CHANGED")
    assert.match(String(changed.evidenceRef || ""), /^ues-store:/)
  } finally {
    await rm(root, { recursive: true, force: true })
    resetSeenContextLedger("epoch:test")
  }
})
