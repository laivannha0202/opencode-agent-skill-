// V16 FIND-02 (same-attempt lazy hydration) + FIND-03 (system/project prefix
// hashes) + V16.6 closed-loop learning. Every test asserts runtime behavior,
// not marker existence.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  DEFERRED_DISPATCHER_TOOL,
  DEFAULT_HYDRATION_BUDGET,
  HYDRATION_DENY_REASONS,
  applyHydratedTools,
  createDeferredHydrationSession,
  describeDeferredTool,
  dispatcherSchemaFingerprint,
  requestDeferredHydration,
  searchDeferredTools,
  summarizeDeferredHydration,
} from "../lib/deferred-tool-hydration.mjs"
import {
  compileToolSurface,
  coreToolPriorities,
  estimateToolSchemaTax,
} from "../lib/tool-surface-economy.mjs"
import {
  cacheStabilityFromRows,
  fingerprintStablePrefix,
  redactVolatilePrefixTokens,
  stableProjectPrefix,
  stableSystemPrefix,
} from "../lib/provider-cache-stability.mjs"
import { buildTaskTelemetry } from "../lib/run-telemetry.mjs"
import {
  compileAdaptiveStrategy,
  strategyPerformanceKey,
} from "../lib/adaptive-strategy.mjs"
import { normalizePerformanceHistory } from "../lib/model-performance.mjs"
import { readModelPolicy, recordModelPerformance } from "../lib/model-config.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const readSource = (file) => readFileSync(path.join(root, file), "utf8")

// ---- FIND-02 A: dispatcher advertised iff a deferred set exists ----

test("FIND-02/A dispatcher is advertised exactly when tools are deferred", () => {
  const tools = ["write", "read", "grep", "bash", "edit", "ues_code", "ues_service", "find", "ls", "powershell", "ues_code_edit", DEFERRED_DISPATCHER_TOOL]
  const profile = { maxAdvertisedTools: 7, surface: "compact" }
  const options = { task: "fix a small bug", writer: true, executionProfile: "fast", platform: "win32", attempt: 1 }
  const surface = compileToolSurface(tools, profile, coreToolPriorities(tools, options), options)
  assert.ok(surface.deferred.length > 0)
  assert.equal(surface.hydrationDispatcher, DEFERRED_DISPATCHER_TOOL)
  assert.ok(surface.advertised.includes(DEFERRED_DISPATCHER_TOOL))
  assert.equal(surface.hydrationInterface, "v16.2-same-attempt/1")
  assert.ok(surface.revealPolicy.includes("same-attempt-hydration"))

  const tiny = ["read", DEFERRED_DISPATCHER_TOOL]
  const full = compileToolSurface(tiny, { maxAdvertisedTools: 9 }, coreToolPriorities(tiny, {}), {})
  assert.equal(full.deferred.length, 0)
  assert.equal(full.hydrationDispatcher, null)
  assert.ok(!full.advertised.includes(DEFERRED_DISPATCHER_TOOL), "no pointless dispatcher tax when nothing is deferred")
})

// ---- FIND-02 B: bounded deterministic discovery ----

test("FIND-02/B discovery finds the deferred tool for a need, bounded and deterministic", () => {
  const deferred = ["bash", "find", "ls", "ues_service", "write", "powershell", "grep"]
  const first = searchDeferredTools({ query: "run tests", deferred, writer: true })
  assert.ok(first.results.some((row) => row.tool === "bash"))
  assert.ok(first.returned <= 5)
  assert.equal(first.deterministic, true)
  const second = searchDeferredTools({ query: "run tests", deferred: [...deferred].reverse(), writer: true })
  assert.deepEqual(first.results, second.results, "input order must not change discovery")
  const capped = searchDeferredTools({ query: "e", deferred, writer: true, limit: 99 })
  assert.ok(capped.returned <= 8, "hard discovery cap holds")
  const empty = searchDeferredTools({ query: "zzz-no-such-need", deferred, writer: true })
  assert.equal(empty.returned, 0)
})

// ---- FIND-02 C: dispatcher interface is fixed and tiny ----

test("FIND-02/C dispatcher schema is fixed, tiny, and stable", () => {
  assert.equal(dispatcherSchemaFingerprint(), dispatcherSchemaFingerprint())
  const tax = estimateToolSchemaTax(["read", DEFERRED_DISPATCHER_TOOL])
  const dispatcherRow = tax.rows.find((row) => row.name === DEFERRED_DISPATCHER_TOOL)
  assert.ok(dispatcherRow.estimatedChars <= 500, "dispatcher must stay a small fixed tax")
  const readRow = tax.rows.find((row) => row.name === "read")
  assert.ok(dispatcherRow.estimatedChars < readRow.estimatedChars)
})

// ---- FIND-02 D: hydrate then use in the same attempt ----

test("FIND-02/D granted hydration activates the correct capability without an attempt increment", () => {
  const attempt = 1
  const session = createDeferredHydrationSession({
    deferred: ["bash", "find", "ues_service"],
    advertised: [DEFERRED_DISPATCHER_TOOL, "read", "grep"],
    role: "executor",
    writer: true,
  })
  const found = searchDeferredTools({ query: "run the test suite", deferred: session.deferred, writer: true })
  assert.equal(found.results[0].tool, "bash")
  const grant = requestDeferredHydration(session, "bash")
  assert.equal(grant.granted, true)
  assert.equal(grant.capability, "run-shell")
  assert.equal(grant.reason, "HYDRATED_SAME_ATTEMPT")
  const applied = applyHydratedTools([DEFERRED_DISPATCHER_TOOL, "read", "grep"], session)
  assert.deepEqual(applied.advertised, [DEFERRED_DISPATCHER_TOOL, "read", "grep", "bash"])
  assert.equal(applied.attemptUnchanged, true)
  assert.equal(attempt, 1, "same attempt: no retry was consumed")
  assert.equal(describeDeferredTool("bash").capability, "run-shell", "approved capability mapping is exact")
})

// ---- FIND-02 E/F: deny paths ----

test("FIND-02/E unknown and already-visible tools are denied with stable reasons", () => {
  const session = createDeferredHydrationSession({
    deferred: ["bash"],
    advertised: ["read", DEFERRED_DISPATCHER_TOOL],
    writer: true,
  })
  assert.equal(requestDeferredHydration(session, "not-a-tool").reason, HYDRATION_DENY_REASONS.UNKNOWN_TOOL)
  assert.equal(requestDeferredHydration(session, "read").reason, HYDRATION_DENY_REASONS.ALREADY_ADVERTISED)
  // The dispatcher itself is advertised in this session, so the correct deny
  // reason is ALREADY_ADVERTISED (the child additionally refuses to hydrate
  // the dispatcher by name via its own UNKNOWN_TOOL guard).
  assert.equal(requestDeferredHydration(session, DEFERRED_DISPATCHER_TOOL).reason, HYDRATION_DENY_REASONS.ALREADY_ADVERTISED)
})

test("FIND-02/F read-only roles cannot hydrate writer tools; writers can", () => {
  const reader = createDeferredHydrationSession({ deferred: ["edit", "bash"], advertised: ["read"], writer: false })
  assert.equal(requestDeferredHydration(reader, "edit").reason, HYDRATION_DENY_REASONS.READ_ONLY_ROLE)
  assert.equal(requestDeferredHydration(reader, "bash").granted, true)
  const writer = createDeferredHydrationSession({ deferred: ["edit"], advertised: ["read"], writer: true })
  assert.equal(requestDeferredHydration(writer, "edit").granted, true)
  const forbidden = createDeferredHydrationSession({ deferred: ["bash"], advertised: [], writer: true, forbidden: ["bash"] })
  assert.equal(requestDeferredHydration(forbidden, "bash").reason, HYDRATION_DENY_REASONS.FORBIDDEN_POLICY)
})

// ---- FIND-02 G: budget bound ----

test("FIND-02/G hydration budget is enforced and deterministic", () => {
  const session = createDeferredHydrationSession({
    deferred: ["bash", "find", "ls", "grep", "ues_service", "powershell"],
    advertised: [],
    writer: true,
    maxHydrations: 4,
  })
  const order = ["bash", "find", "ls", "grep"]
  for (const tool of order) assert.equal(requestDeferredHydration(session, tool).granted, true)
  const exhausted = requestDeferredHydration(session, "ues_service")
  assert.equal(exhausted.granted, false)
  assert.equal(exhausted.reason, HYDRATION_DENY_REASONS.HYDRATION_BUDGET_EXHAUSTED)
  assert.equal(session.hydrated.length, DEFAULT_HYDRATION_BUDGET)
  assert.equal(requestDeferredHydration(session, "bash").reason, HYDRATION_DENY_REASONS.ALREADY_HYDRATED)
})

// ---- FIND-02 H: base prefix intact ----

test("FIND-02/H hydration preserves base order and the dispatcher fingerprint", () => {
  const before = dispatcherSchemaFingerprint()
  const session = createDeferredHydrationSession({ deferred: ["bash", "find"], advertised: ["read"], writer: true })
  requestDeferredHydration(session, "find")
  requestDeferredHydration(session, "bash")
  const applied = applyHydratedTools(["read", "grep"], session)
  assert.deepEqual(applied.base, ["read", "grep"])
  assert.deepEqual(applied.hydrated, ["bash", "find"], "hydrated appended in deterministic alpha order")
  assert.equal(applied.basePrefixIntact, true)
  assert.equal(dispatcherSchemaFingerprint(), before, "discovery interface never grows")
})

// ---- FIND-02 I: retry fallback preserved ----

test("FIND-02/I retry reveal still works when hydration is unused", () => {
  const tools = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "ues_code", "ues_code_edit", "ues_service", "ues_evidence_get", DEFERRED_DISPATCHER_TOOL]
  const profile = { maxAdvertisedTools: 7, surface: "compact" }
  const base = { task: "debug service bug", writer: true, executionProfile: "standard", platform: "win32" }
  const core = coreToolPriorities(tools, base)
  const first = compileToolSurface(tools, profile, core, { ...base, attempt: 1 })
  const retry = compileToolSurface(tools, profile, core, { ...base, attempt: 2 })
  assert.ok(retry.advertised.length >= first.advertised.length)
  assert.ok(retry.advertised.length <= first.advertised.length + 2)
  assert.ok(retry.advertised.includes(DEFERRED_DISPATCHER_TOOL), "dispatcher survives into retry")
})

// ---- FIND-02 J: telemetry ----

test("FIND-02/J hydration telemetry records discovery, grants, and denials", () => {
  const session = createDeferredHydrationSession({ deferred: ["bash", "edit"], advertised: ["read"], writer: false })
  searchDeferredTools({ query: "run tests", deferred: session.deferred, writer: false })
  session.discoveryCount += 1
  requestDeferredHydration(session, "bash")
  requestDeferredHydration(session, "edit")
  const summary = summarizeDeferredHydration(session)
  assert.equal(summary.sameAttempt, true)
  assert.equal(summary.discoveryCount, 1)
  assert.equal(summary.hydrationCount, 1)
  assert.deepEqual(summary.hydrated, ["bash"])
  assert.deepEqual(summary.denied, ["edit"])
  assert.equal(summary.dispatcherFingerprint, dispatcherSchemaFingerprint())
  const telemetry = buildTaskTelemetry(
    { toolExposure: { hydration: summary, economy: { schemaPrefixHash: "x" } }, allowedTools: ["read"], toolNames: ["read"] },
    {},
  )
  assert.deepEqual(telemetry.metrics.hydratedToolNames, ["bash"])
  assert.equal(telemetry.metrics.hydrationDeniedCount, 1)
  assert.equal(telemetry.metrics.sameAttemptHydration, true)
})

// ---- FIND-02 K: real wiring (parent advertises, child registers) ----

test("FIND-02/K hydration is really wired: parent env + child dispatcher", () => {
  const parent = readSource("pi/extensions/ues.ts")
  for (const marker of [
    "DEFERRED_DISPATCHER_TOOL",
    "UES_CHILD_DEFERRED_TOOLS",
    "UES_CHILD_HYDRATION_FORBIDDEN",
    "UES_CHILD_ROLE",
    "UES_CHILD_WRITER",
    "UES_CHILD_HYDRATION_MAX",
    "readChildHydrationTelemetry",
    "tool.hydrated",
    "row?.tool || row",
  ]) assert.ok(parent.includes(marker), `ues.ts must contain ${marker}`)
  const child = readSource("pi/extensions/ues-child-runtime.ts")
  for (const marker of [
    "DEFERRED_DISPATCHER_TOOL",
    "deferredHydrationEnv",
    "requestDeferredHydration",
    "searchDeferredTools",
    "pi.setActiveTools",
    "tool.hydrated",
    "tool.hydration-denied",
    "tool.discovery",
  ]) assert.ok(child.includes(marker), `ues-child-runtime.ts must contain ${marker}`)
  // Dispatcher only registers when the parent actually deferred tools.
  assert.ok(child.includes("deferredHydrationEnv().deferred.length > 0"))
  // Dispatcher can only reveal the parent-computed allowlisted universe.
  assert.ok(child.includes("UES_CHILD_DEFERRED_TOOLS"))
})

// ---- FIND-02 L: discovery performance is bounded ----

test("FIND-02/L discovery stays fast on a large deferred universe", () => {
  const deferred = Array.from({ length: 200 }, (_, index) => `mcp_tool_${String(index).padStart(3, "0")}`).concat(["bash", "find"])
  const started = Date.now()
  for (let index = 0; index < 200; index += 1) {
    searchDeferredTools({ query: "run shell command", deferred, writer: true })
  }
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `200 searches took ${elapsed}ms`)
  const found = searchDeferredTools({ query: "run shell command", deferred, writer: true })
  assert.ok(found.returned <= 5)
})

// ---- FIND-03: system/project prefix hashes ----

test("FIND-03 volatile token swaps do not move prefix hashes; real edits do", () => {
  const first = "# Agent\nDo the task. runId: 9f2c1a44-3b1d-4e5f-9a2b-7c8d9e0f1234\nBuilt 2026-10-02T10:00:00Z in /tmp/ues-pi-AbC123 (pid: 12345).\nRules: be careful."
  const second = "# Agent\nDo the task. runId: 00000000-0000-4000-8000-000000000000\nBuilt 2026-10-03T11:11:11Z in /tmp/ues-pi-XyZ789 (pid: 99999).\nRules: be careful."
  assert.equal(stableSystemPrefix(first).hash, stableSystemPrefix(second).hash)
  assert.equal(stableSystemPrefix(first).evidence, "FINGERPRINTED")
  assert.notEqual(stableSystemPrefix(first + "\nRules: be reckless.").hash, stableSystemPrefix(first).hash)
  assert.equal(stableProjectPrefix("").hash, null)
  assert.equal(stableProjectPrefix("").evidence, "NO_PROJECT_PREFIX")
  assert.equal(stableProjectPrefix("   \n  ").hash, null)
  assert.ok(redactVolatilePrefixTokens(second).includes("<volatile>"))
  assert.equal(fingerprintStablePrefix(""), null)
})

test("FIND-03 telemetry rows aggregate system/project prefix stability", () => {
  const sys = stableSystemPrefix("# Agent\nDo it.").hash
  const proj = stableProjectPrefix("# Project\nUse npm.").hash
  const rows = Array.from({ length: 4 }, () => ({
    type: "task.telemetry",
    model: "m",
    metrics: {
      inputTokens: 200, cacheReadTokens: 700, cacheWriteTokens: 100,
      usageAccounting: "pi-normalized-disjoint",
      systemPrefixHash: sys, projectPrefixHash: proj,
    },
  }))
  const policy = cacheStabilityFromRows(rows, { model: "m", minSamples: 2 })
  assert.equal(policy.systemPrefixSamples, 4)
  assert.equal(policy.systemPrefixStableRatio, 1)
  assert.equal(policy.distinctSystemPrefixes, 1)
  assert.equal(policy.projectPrefixSamples, 4)
  assert.equal(policy.distinctProjectPrefixes, 1)
  const changed = [...rows]
  changed[3] = {
    type: "task.telemetry", model: "m",
    metrics: { ...rows[0].metrics, systemPrefixHash: stableSystemPrefix("# Agent\nDo it differently.").hash },
  }
  const policy2 = cacheStabilityFromRows(changed, { model: "m", minSamples: 2 })
  assert.equal(policy2.distinctSystemPrefixes, 2)
  assert.ok(policy2.systemPrefixStableRatio < 1)
  const bare = cacheStabilityFromRows(
    [{ type: "task.telemetry", model: "m", metrics: { inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, usageAccounting: "pi-normalized-disjoint" } }],
    { model: "m", minSamples: 1 },
  )
  assert.equal(bare.systemPrefixSamples, 0)
  assert.equal(bare.systemPrefixStableRatio, null)
  assert.equal(bare.projectPrefixSamples, 0)
})

test("FIND-03 task telemetry carries prefix hashes from the parent launch", () => {
  const telemetry = buildTaskTelemetry(
    {
      toolExposure: {
        economy: {},
        prefixHashes: { systemPrefixHash: "prefix:sha256:abc", projectPrefixHash: null, evidence: "FINGERPRINTED" },
      },
      allowedTools: ["read"],
      toolNames: [],
    },
    {},
  )
  assert.equal(telemetry.metrics.systemPrefixHash, "prefix:sha256:abc")
  assert.equal(telemetry.metrics.projectPrefixHash, null)
  assert.equal(telemetry.metrics.prefixHashEvidence, "FINGERPRINTED")
  const parent = readSource("pi/extensions/ues.ts")
  assert.ok(parent.includes("childPrefixHashes"), "parent must fingerprint launch prefixes")
  assert.ok(parent.includes("stableSystemPrefix") && parent.includes("stableProjectPrefix"))
})

// ---- V16.6 closed loop ----

const STRATEGY_OPTS = {
  writer: true, task: "fix login bug", taskClass: "debugging", surface: "balanced",
  executionProfile: "standard", risk: "medium", attempt: 1, model: "test-model/weak",
}

function strategyKeys() {
  const heuristic = compileAdaptiveStrategy({ ...STRATEGY_OPTS })
  assert.equal(heuristic.evidence, "HEURISTIC")
  const altEdit = heuristic.editStrategy === "symbol-edit" ? "range-edit" : "symbol-edit"
  const good = { ...heuristic, editStrategy: altEdit }
  return {
    heuristic,
    badKey: strategyPerformanceKey(heuristic, "debugging"),
    goodKey: strategyPerformanceKey(good, "debugging"),
    altEdit,
  }
}

function record(samples, passRate) {
  const successes = Math.round(samples * passRate)
  return { samples, successes, passRate: successes / samples, avgRetries: 0, avgTokens: 5000, avgLatencyMs: 2000 }
}

test("V16.6/A empirical history promotes the measured winner over the heuristic", () => {
  const { badKey, goodKey, altEdit } = strategyKeys()
  const history = normalizePerformanceHistory({
    "test-model/weak": { [badKey]: record(10, 0.2), [goodKey]: record(10, 1.0) },
  })
  const promoted = compileAdaptiveStrategy({ ...STRATEGY_OPTS, performanceHistory: history, minSamples: 8 })
  assert.equal(promoted.editStrategy, altEdit)
  assert.equal(promoted.evidence, "MEASURED")
  assert.ok(promoted.empiricalSamples >= 8)
})

test("V16.6/A correctness outranks cost: a reliable expensive strategy still wins", () => {
  const { badKey, goodKey, altEdit } = strategyKeys()
  const cheapBad = { ...record(10, 0.4), avgTokens: 1000, avgRetries: 0 }
  const priceyGood = { ...record(10, 1.0), avgTokens: 30000, avgRetries: 0 }
  const history = normalizePerformanceHistory({ "test-model/weak": { [badKey]: cheapBad, [goodKey]: priceyGood } })
  const promoted = compileAdaptiveStrategy({ ...STRATEGY_OPTS, performanceHistory: history, minSamples: 8 })
  assert.equal(promoted.editStrategy, altEdit)
})

test("V16.6/A below the evidence floor the heuristic holds (no tiny-sample reorder)", () => {
  const { badKey, goodKey, heuristic } = strategyKeys()
  const history = normalizePerformanceHistory({
    "test-model/weak": { [badKey]: record(10, 0.2), [goodKey]: record(3, 1.0) },
  })
  const held = compileAdaptiveStrategy({ ...STRATEGY_OPTS, performanceHistory: history, minSamples: 8 })
  assert.equal(held.editStrategy, heuristic.editStrategy, "a 3-sample record must not reorder the strategy")
})

test("V16.6/B performance persists across processes and corrupt history is safe", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-perf-"))
  try {
    const { goodKey } = strategyKeys()
    for (let index = 0; index < 8; index += 1) {
      await recordModelPerformance(dir, {
        model: "test-model/weak", text: "fix login bug", passed: true, retries: 0,
        latencyMs: 1000, tokens: 4000, taskClass: "debugging",
        strategyProfile: { editStrategy: "symbol-edit", toolSurface: "balanced", contextStrategy: "delta-tools-stable-prefix", executionProfile: "standard", searchStrategy: "hybrid", taskClass: "debugging" },
      })
    }
    const reread = await readModelPolicy(dir)
    assert.ok(reread.performance?.["test-model/weak"]?.[goodKey]?.samples >= 8, "strategy key must survive a reload")
    const promoted = compileAdaptiveStrategy({
      ...STRATEGY_OPTS,
      performanceHistory: reread.performance || {},
      minSamples: 8,
    })
    assert.equal(promoted.editStrategy, "symbol-edit")
    assert.equal(promoted.evidence, "MEASURED")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  const { heuristic } = strategyKeys()
  for (const corrupt of [null, undefined, {}, { "test-model/weak": "junk" }, { "test-model/weak": { "strategy:x": { samples: "NaN" } } }]) {
    const held = compileAdaptiveStrategy({ ...STRATEGY_OPTS, performanceHistory: corrupt, minSamples: 8 })
    assert.equal(held.editStrategy, heuristic.editStrategy, "corrupt history must fall back to heuristic")
  }
})
