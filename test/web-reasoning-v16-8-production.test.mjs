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
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-8-production-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Test"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  mkdirSync(path.join(root, "test"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  writeFileSync(path.join(root, "test", "core.test.mjs"), "import '../src/core.mjs'\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function adapter(overrides = {}) {
  return {
    id: "deepseek-web",
    capability: async (options = {}) => overrides.capability
      ? overrides.capability(options)
      : ({ state: "ready", reason: "ready", supportsFollowUp: true }),
    startSession: async (options = {}) => overrides.startSession
      ? overrides.startSession(options)
      : ({ sessionId: "v16-8-prod", state: "ready" }),
    consult: async (session, packet, options = {}) => overrides.consult
      ? overrides.consult(session, packet, options)
      : ({ answer: JSON.stringify(GOOD_ADVICE), latencyMs: 5 }),
    followUp: async (session, delta, options = {}) => overrides.followUp
      ? overrides.followUp(session, delta, options)
      : ({ answer: JSON.stringify(GOOD_ADVICE), latencyMs: 5 }),
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
    requestId: "v16-8-request",
    ...overrides,
  }
}

async function productionModule() {
  resetLazyRuntimeForTests()
  return hydrateRuntimeModule(LAZY_RUNTIME_MODULES.WEB_REASONING_LANE)
}

test("V16.8 production lazy loader resolves the barrier wrapper, not the raw V16.7 lane", async () => {
  const mod = await productionModule()
  assert.equal(typeof mod.createWebReasoningLane, "function")
  const source = readFileSync(new URL("../lib/lazy-runtime.mjs", import.meta.url), "utf8")
  assert.match(source, /web-reasoning-lane-v16-8\.mjs/)
})

test("V16.8 production consult injects only a compact validated capsule", async () => {
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
    assert.equal(result.decisionBarrier.passed, true)
    assert.match(result.advisorText, /^UES_ADVISOR_CAPSULE/)
    assert.ok(result.advisorText.length <= 1_200)
    assert.equal(result.advisorText.includes("Hypotheses:"), false)
    assert.equal(result.advisorCapsuleV16_8.modelVisible.files_to_touch[0], "src/core.mjs")
    assert.equal(result.v16_8.localPrep.testsExecuted, 0)
    assert.equal(result.v16_8.localPrep.sourceMutationAllowed, false)
    assert.equal(result.v16_8.overlapTelemetry.measurement_provenance.provider_tokens, "NOT_MEASURED")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 production barrier discards advice if workspace changes while advisor is running", async () => {
  const root = repoFixture()
  try {
    const mutatingAdapter = adapter({
      consult: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 2\n")
        return { answer: JSON.stringify(GOOD_ADVICE), latencyMs: 20 }
      },
    })
    const mod = await productionModule()
    const lane = mod.createWebReasoningLane({ mode: "auto", provider: "deepseek-web", adapters: [mutatingAdapter], workspaceRoot: root })
    const result = await lane.consult(input(root))
    assert.equal(result.outcome, "fallback-local")
    assert.equal(result.advisorText, null)
    assert.equal(result.decisionBarrier.stale, true)
    assert.ok(result.decisionBarrier.reasons.includes("workspace-mutated-during-consult"))
    assert.equal(result.v16_8.overlapTelemetry.stale_discards, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 hard deadline aborts the real adapter consult and fences the late result", async () => {
  const root = repoFixture()
  let sawAbort = false
  try {
    const blocking = adapter({
      consult: async (_session, _packet, options = {}) => new Promise((_resolve, reject) => {
        const stop = () => {
          sawAbort = true
          reject(new Error("aborted by v16.8 deadline"))
        }
        if (options.signal?.aborted) stop()
        else options.signal?.addEventListener?.("abort", stop, { once: true })
      }),
    })
    const mod = await productionModule()
    const lane = mod.createWebReasoningLane({
      mode: "auto",
      provider: "deepseek-web",
      adapters: [blocking],
      workspaceRoot: root,
      softDeadlineMs: 10,
      hardDeadlineMs: 40,
    })
    const started = Date.now()
    const result = await lane.consult(input(root))
    assert.equal(result.outcome, "fallback-local")
    assert.equal(result.reason, "web-advisor-hard-deadline")
    assert.equal(result.fallbackToLocal, true)
    assert.equal(sawAbort, true)
    assert.ok(Date.now() - started < 1_000)
    assert.equal(result.v16_8.overlapTelemetry.advisor_aborts, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 deterministic circuit breaker requires proof and skips the external submit", async () => {
  const root = repoFixture()
  let submits = 0
  try {
    const mod = await productionModule()
    const lane = mod.createWebReasoningLane({
      mode: "auto",
      provider: "deepseek-web",
      adapters: [adapter({ consult: async () => { submits += 1; return { answer: JSON.stringify(GOOD_ADVICE) } } })],
      workspaceRoot: root,
    })
    const result = await lane.consult(input(root, {
      deterministicResolution: {
        proven: true,
        uniqueCandidate: true,
        sourceExists: true,
        diagnosticAgrees: true,
        mechanicallyDerivable: true,
      },
    }))
    assert.equal(result.reason, "deterministic-local-resolution")
    assert.equal(result.circuitBreaker.proven, true)
    assert.equal(submits, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
