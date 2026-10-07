// V16.9 production tests: the lifecycle wrapper the shipped lazy loader hydrates.
//
// These drive the SAME module `pi/extensions/ues.ts` resolves through
// `LAZY_RUNTIME_MODULES.WEB_REASONING_LANE`, so they test the production path,
// not a private fixture. They lock the V16.9 additions the controller depends on:
//
//   1. An accepted consult produces a READY execution handoff (the V16.8 barrier
//      verdict is REUSED, not re-evaluated).
//   2. The write-side pre-write fence refuses a handoff whose declared write
//      target is generated/out-of-scope, downgrading to a local fallback.
//   3. The V16.8 result shape is preserved (spread) and only ADDS `v16_9`.
//   4. The evidence broker extraction in `ues.ts` is a faithful strangler: the
//      inline closure is gone and the broker owns the loop.

import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  LAZY_RUNTIME_MODULES,
  hydrateRuntimeModule,
  resetLazyRuntimeForTests,
} from "../lib/lazy-runtime.mjs"

const GOOD_ADVICE = {
  summary: "The source contract is inconsistent with the current consumer.",
  hypotheses: ["A narrow contract mismatch is the root cause."],
  recommendedApproach: ["Update the existing source contract.", "Keep the change scoped to the grounded file."],
  filesToInspect: ["src/core.mjs"],
  risks: ["Do not widen the change."],
  edgeCases: [],
  verificationSuggestions: ["Run the focused core test."],
  confidence: 0.91,
}

function repoFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-9-production-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Test"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function adapter(overrides = {}) {
  return {
    id: "deepseek-web",
    capability: async () => ({ state: "ready", reason: "ready", supportsFollowUp: true }),
    startSession: async () => ({ sessionId: "v16-9-prod", state: "ready" }),
    consult: async () => overrides.consult
      ? overrides.consult()
      : ({ answer: JSON.stringify(GOOD_ADVICE), latencyMs: 5 }),
    followUp: async () => ({ answer: JSON.stringify(GOOD_ADVICE), latencyMs: 5 }),
    closeSession: async () => true,
  }
}

function input(root, overrides = {}) {
  return {
    task: "The verifier still fails and the root cause is ambiguous across this contract.",
    workspaceRoot: root,
    knownFiles: ["src/core.mjs"],
    relevantFiles: [{ path: "src/core.mjs", role: "source", reason: "grounded target" }],
    evidence: [{ kind: "verifier", source: "test", text: "contract mismatch" }],
    affectedSubsystems: 2,
    requestId: "v16-9-request",
    ...overrides,
  }
}

async function productionModule() {
  resetLazyRuntimeForTests()
  return hydrateRuntimeModule(LAZY_RUNTIME_MODULES.WEB_REASONING_LANE)
}

test("V16.9 production lazy loader hydrates the lifecycle wrapper, not the raw V16.7 lane", async () => {
  const mod = await productionModule()
  assert.equal(typeof mod.createWebReasoningLane, "function")
  assert.equal(mod.V16_9_LANE_POLICY, "web-reasoning-lane-v16-9")
  const source = readFileSync(new URL("../lib/lazy-runtime.mjs", import.meta.url), "utf8")
  assert.match(source, /web-reasoning-lane-v16-9\.mjs/)
  assert.doesNotMatch(source, /import\("\.\/web-reasoning-lane\.mjs"\)/)
})

test("V16.9 production accepted consult yields a READY handoff reusing the V16.8 barrier", async () => {
  const root = repoFixture()
  try {
    const mod = await productionModule()
    const lane = mod.createWebReasoningLane({
      mode: "force",
      provider: "deepseek-web",
      adapters: [adapter()],
      workspaceRoot: root,
      softDeadlineMs: 2_000,
      hardDeadlineMs: 4_000,
    })
    const result = await lane.consult(input(root))
    assert.equal(result.outcome, "advised")
    // The V16.8 shape must survive the wrapper unchanged...
    assert.equal(result.decisionBarrier.passed, true)
    assert.match(result.advisorText, /^UES_ADVISOR_CAPSULE/)
    assert.ok(result.advisorText.length <= 1_200)
    // ...and V16.9 only ADDS its receipt.
    assert.equal(result.v16_9.consulted, true)
    assert.equal(result.v16_9.handoff.status, "ready")
    assert.equal(result.v16_9.handoff.executorAdvice, result.advisorText)
    // The handoff reuses the V16.8 barrier verdict object (no second evaluation).
    assert.equal(result.v16_9.handoff.decisionBarrier, result.decisionBarrier)
    assert.equal(result.v16_9.handoff.mayProducePass, false)
    assert.equal(result.v16_9.handoff.mayGrantPermissions, false)
    const state = lane.state()
    assert.equal(state.v16_9.handoffsReady, 1)
    assert.equal(state.v16_9.handoffsRefused, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.9 production pre-write fence refuses a generated write target and falls back to local", async () => {
  const root = repoFixture()
  try {
    const mod = await productionModule()
    const lane = mod.createWebReasoningLane({
      mode: "auto",
      provider: "deepseek-web",
      adapters: [adapter()],
      workspaceRoot: root,
      softDeadlineMs: 2_000,
      hardDeadlineMs: 4_000,
    })
    // The advisor is accepted, but the executor intends to write a GENERATED
    // path. The V16.8 barrier would pass (workspace unchanged); only the V16.9
    // write-side fence catches this.
    const result = await lane.consult(input(root, {
      writeTargets: ["dist/bundle.js"],
      allowedTargets: ["src/core.mjs"],
    }))
    assert.equal(result.outcome, "fallback-local")
    assert.equal(result.advisorText, null)
    assert.equal(result.fallbackToLocal, true)
    assert.equal(result.v16_9.handoff.status, "refused")
    assert.ok(
      result.v16_9.handoff.reasons.includes("target-outside-declared-scope")
        || result.v16_9.handoff.reasons.includes("target-is-generated"),
      `expected a write-fence refusal, got ${JSON.stringify(result.v16_9.handoff.reasons)}`,
    )
    assert.equal(result.v16_9.handoff.executorAdvice, null)
    assert.equal(lane.state().v16_9.handoffsRefused, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.9 production FORCE keeps the fail-loud contract when the write fence refuses", async () => {
  const root = repoFixture()
  try {
    const mod = await productionModule()
    const lane = mod.createWebReasoningLane({
      mode: "force",
      provider: "deepseek-web",
      adapters: [adapter()],
      workspaceRoot: root,
      softDeadlineMs: 2_000,
      hardDeadlineMs: 4_000,
    })
    const result = await lane.consult(input(root, { writeTargets: ["dist/bundle.js"] }))
    // FORCE must never silently degrade to a local run: a refused handoff is an
    // explicit unavailable, not a quiet fallback.
    assert.equal(result.outcome, "unavailable")
    assert.equal(result.fallbackToLocal, false)
    assert.equal(result.advisorText, null)
    assert.equal(result.v16_9.handoff.status, "refused")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.9 evidence broker is the single owner of the evidence loop in ues.ts", () => {
  const source = readFileSync(new URL("../pi/extensions/ues.ts", import.meta.url), "utf8")
  // The inline closure must be GONE and the broker must own the loop.
  assert.doesNotMatch(source, /const sources: Record<string, string> = \{/, "the inline source map must be removed")
  assert.match(source, /evidenceBroker\.createEvidenceBroker\(/, "ues.ts must construct the broker")
  assert.match(source, /evidenceBroker\.serve\(/, "ues.ts must serve requests through the broker")
  // The broker is hydrated lazily with the session stack, never statically.
  assert.doesNotMatch(
    source,
    /^import[^\n]*from "\.\.\/\.\.\/lib\/evidence-broker\.mjs"/m,
    "the broker must not be statically imported by the extension",
  )
})

test("V16.9 the broker hydrates with the V16.6 session stack and exposes the same budget path", async () => {
  const { loadSessionRuntime } = await import("../lib/v16-6-runtime.mjs")
  const runtime = await loadSessionRuntime()
  assert.equal(typeof runtime.evidenceBroker.createEvidenceBroker, "function")
  // The broker must not fork the authority path: it wraps the SAME evidence
  // request primitives the inline loop used.
  assert.equal(typeof runtime.evidenceRequests.createEvidenceRequestBudget, "function")
})
