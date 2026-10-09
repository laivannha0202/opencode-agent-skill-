// V16.16 FINAL PRODUCTION-WIRING AUDIT (static callsite guard).
//
// The owner suites prove each capability is correct and
// test/v16-16-semantic-wiring.test.mjs proves each capability has a RUNTIME
// effect (reuse / budget / proof / stop) through the real owners. This suite
// is only the small static guard that the CONTROLLER actually calls them on
// the real production path starting from pi/extensions/ues.ts: every
// assertion below checks a real call expression in the shipped extension
// text. A behavioral test passing only because `text.includes(...)` matched
// is NOT sufficient for the four capabilities — see the semantic suite.

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")
const source = () => readFileSync(EXTENSION, "utf8")

test("V16.16 wiring: RPC prewarm reuses the actual run worker through the one existing pool", () => {
  const text = source()
  // ONE canonical identity: prewarm and run share the exact same builder.
  assert.ok(text.includes("buildRpcWorkerKey({"), "canonical worker-key builder is never called")
  assert.ok(
    text.includes("predictStructuredPrewarmIdentity({"),
    "prewarm never predicts the exact run identity",
  )
  assert.ok(
    text.includes("wavePlanModule.prewarmWaveWorkers(RPC_POOL,"),
    "prewarmWaveWorkers is never called with the existing RPC_POOL",
  )
  assert.ok(text.includes("maxWorkers: prewarmBound"), "prewarm bound is missing")
  assert.ok(
    text.includes("Math.max(1, Math.min(3, Math.trunc(Number(waveConcurrency) || 1)))"),
    "prewarm never exceeds the resolved writer concurrency",
  )
  // No wave-local alias keys: every prewarm key comes from the canonical
  // builder (a differently-keyed worker could never be consumed).
  assert.ok(!text.includes("ues-wave-${waveIndex}-a${attempt}:"), "stale wave-alias prewarm keys remain")
  // Unconsumed prewarms perform real cleanup instead of leaking.
  assert.ok(text.includes("wavePrewarmKeys"), "prewarm keys are never tracked for cleanup")
  assert.ok(text.includes("discardUnconsumedPrewarm"), "unconsumed prewarm is never discarded")
  assert.ok(text.includes("stableTaskFor(item)"), "prewarm and run do not share the same stable identity text")
  assert.ok(
    text.includes("never prewarmed here"),
    "the no-DeepSeek/browser prewarm guard is missing",
  )
})

test("V16.16 wiring: run cost is reserved against the real unified run budget", () => {
  const text = source()
  // The null bypass is gone: the reservation consumes the canonical V16.6
  // run budget carried on rootPolicy (fallback only when none exists).
  assert.ok(!text.includes("reserveRunCost(null, {"), "null-budget bypass still present")
  assert.ok(text.includes("reserveRunCost(canonicalRunBudget,"), "reserveRunCost never consumes the canonical run budget")
  assert.ok(text.includes("(input.rootPolicy as any)?.v16_6"), "canonical v16_6 run budget is never read")
  assert.ok(text.includes("budgetSource"), "budget provenance (real vs fallback) is never recorded")
  assert.ok(text.includes("simultaneousCalls: waveConcurrency"), "the reservation does not see the real concurrency")
  assert.ok(text.includes('action === "lower-concurrency"'), "lower-concurrency is never applied")
  assert.ok(text.includes('action === "serialize"'), "serialize is never applied")
  assert.ok(text.includes('action === "parent-direct"'), "parent-direct is never applied")
  assert.ok(text.includes("delay-optional-advisor"), "delay-optional-advisor is never handled")
  assert.ok(text.includes("verificationIntact"), "required verification is not pinned intact")
  assert.ok(text.includes("runCostReservation"), "the reservation is never recorded")
})

test("V16.16 wiring: verification proof composition changes verification work", () => {
  const text = source()
  assert.ok(
    text.includes("wavePlanModule.planProofReuse({"),
    "planProofReuse is never called on the post-integration path",
  )
  assert.ok(text.includes("executeProofPlan"), "the proof partition is never executed (telemetry-only)")
  assert.ok(
    text.includes("findReusableVerification("),
    "reusable receipts are never consumed from the real broker",
  )
  assert.ok(text.includes("mustRunFresh"), "must-run-fresh commands are never recorded for the verifier")
  assert.ok(text.includes("consumedReceipts"), "consumed receipts are never attached as evidence")
  assert.ok(text.includes("verifierOwnsVerdict"), "verifier PASS ownership is never pinned")
  assert.ok(text.includes("finalRelease: input.finalRelease === true"), "final release does not stay fresh")
  assert.ok(text.includes("lockfileChanged"), "lockfile changes do not invalidate reuse")
  assert.ok(text.includes("configChanged"), "config changes do not invalidate reuse")
  assert.ok(text.includes("affectedBySiblings"), "sibling cross-impact is not checked")
  assert.ok(text.includes("requireFreshCommands"), "security-sensitive gates do not stay fresh")
  assert.ok(text.includes("proofReuse"), "the proof plan is never recorded")
})

test("V16.16 wiring: stable wave prefix is part of the model-visible prompt", () => {
  const text = source()
  assert.ok(text.includes("buildStableWavePrefix({"), "buildStableWavePrefix is never called")
  assert.ok(text.includes("stablePrefixText"), "the stable prefix never reaches the prompt")
  assert.ok(
    text.includes("volatile: {"),
    "volatile run binding is missing",
  )
  // Volatile ids/timestamps sort after the stable cache boundary by construction
  // of the helper (stable block first, volatile below the boundary).
  assert.ok(text.includes("stablePrefixText,"), "the stable prefix is not the leading prompt block")
})

test("V16.16 wiring: provider tokens are recorded only from provider reports", () => {
  const text = source()
  assert.ok(text.includes("recordProviderTokens({"), "recordProviderTokens is never called")
  assert.ok(text.includes("providerTokens,"), "provider tokens never reach telemetry")
  assert.ok(
    text.includes("inputTokens: usage?.inputTokens"),
    "provider input tokens do not come from the real provider report",
  )
})

test("V16.16 wiring: critical-path telemetry consumes real measured timings", () => {
  const text = source()
  assert.ok(
    text.includes("wavePlanModule.buildCriticalPathTelemetry({"),
    "buildCriticalPathTelemetry is never called with measured timings",
  )
  assert.ok(text.includes("totalWallMs: waveWallMs"), "real wave wall time is not consumed")
  assert.ok(text.includes("sandboxCreateTimings.length"), "real sandbox timings are not consumed")
  // Honest RPC counts come from actual run-level reuse, never from estimates.
  assert.ok(text.includes("rpcColdStarts: waveRpcColdStarts"), "real cold starts are never recorded")
  assert.ok(text.includes("rpcWarmReuses: waveRpcWarmReuses"), "real warm reuses are never recorded")
  assert.ok(text.includes("criticalPath"), "critical-path telemetry is never recorded")
})

test("V16.16 wiring: stop-when-proven governs the bounded continuation loop", () => {
  const text = source()
  assert.ok(
    text.includes("wavePlanModule.shouldStopProven({"),
    "shouldStopProven never participates in the continuation loop",
  )
  // Every input is derived from real runtime state — none is hardcoded.
  assert.ok(!text.includes("editsComplete: true"), "stop decision hardcodes editsComplete")
  assert.ok(!text.includes("requirementsSatisfied: true"), "stop decision hardcodes requirementsSatisfied")
  assert.ok(!text.includes("highRiskEvidence: false"), "stop decision hardcodes highRiskEvidence")
  assert.ok(!text.includes("staleGeneration: false"), "stop decision hardcodes staleGeneration")
  assert.ok(!text.includes("pendingDependencies: 0"), "stop decision hardcodes pendingDependencies")
  assert.ok(!text.includes("releaseGateRequested: false"), "stop decision hardcodes releaseGateRequested")
  assert.ok(text.includes("waveStartHead"), "stale generation is never derived from the real HEAD guard")
  assert.ok(text.includes("failureByTask"), "requirements are never derived from the real failure ledger")
  assert.ok(text.includes("safe.waves.slice(waveIndex + 1)"), "pending dependencies are never derived from real waves")
  assert.ok(text.includes("stopProven"), "the stop decision is never recorded")
  assert.ok(text.includes("stale-generation"), "stale generation never governs continuation")
  // It cannot create PASS: the file must never synthesize a verdict here.
  const waveBlock = text.slice(
    text.indexOf("V16.16 STOP-WHEN-PROVEN"),
    text.indexOf("V16.16 STOP-WHEN-PROVEN") + 9000,
  )
  assert.ok(!/verdict:\s*"PASS"/.test(waveBlock), "stop-when-proven must never synthesize PASS")
  assert.ok(waveBlock.includes("sole"), "the local-verifier authority is not pinned")
})
