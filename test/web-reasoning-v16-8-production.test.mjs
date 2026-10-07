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
import { buildExecutorAdvisorCapsule } from "../lib/web-decision-barrier-v16-8.mjs"

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
  // V16.9 advances this pointer to the lifecycle wrapper, which re-exports the
  // V16.8 lane verbatim. The intent is unchanged: the loader must resolve a
  // VERSIONED WRAPPER (v16-8 or v16-9), never the raw V16.7 lane module, so the
  // barrier/overlap layer is always in the production path.
  assert.match(source, /web-reasoning-lane-v16-[89]\.mjs/)
  assert.doesNotMatch(source, /import\("\.\/web-reasoning-lane\.mjs"\)/)
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

test("V16.8 hard deadline leaves the lane reusable and never closes a newer session", async () => {
  const root = repoFixture()
  try {
    const sessions = []
    const closed = []
    let consultCalls = 0
    const flaky = adapter({
      consult: async (_session, _packet, _options = {}) => {
        consultCalls += 1
        if (consultCalls === 1) {
          // Generation 1 ignores AbortSignal and settles LATE, after the caller
          // already received the hard-deadline fallback.
          await new Promise((resolve) => setTimeout(resolve, 400))
          return { answer: JSON.stringify(GOOD_ADVICE), latencyMs: 400 }
        }
        return { answer: JSON.stringify(GOOD_ADVICE), latencyMs: 5 }
      },
      startSession: async () => {
        const session = { sessionId: `v16-8-reuse-${sessions.length + 1}`, state: "ready" }
        sessions.push(session.sessionId)
        return session
      },
      closeSession: async (session) => {
        closed.push(session?.sessionId)
        return true
      },
    })
    const mod = await productionModule()
    const lane = mod.createWebReasoningLane({
      mode: "auto",
      provider: "deepseek-web",
      adapters: [flaky],
      workspaceRoot: root,
      // Generation 1 is fenced quickly: the hard floor is 250ms, which the mock
      // advisor's 400ms response cannot beat. Generations 2 and 3 override this
      // PER CONSULTATION with a generous deadline. They must not race a tight
      // timer under concurrent test load (release:verify runs 4 files at once),
      // because the defect under test is lane reusability, not deadline latency:
      // a shared 250ms floor made the later generations time out on their own
      // real session/packet work and masked the defect with a false failure.
      softDeadlineMs: 10,
      hardDeadlineMs: 40,
      // The run budget must allow a later generation: the defect under test is
      // lane reusability, not the consultation ceiling.
      maxConsultations: 3,
    })
    const first = await lane.consult(input(root, { requestId: "v16-8-gen1" }))
    assert.equal(first.reason, "web-advisor-hard-deadline")

    // A later consultation on the SAME lane must still work. The V16.8 defect
    // was that late cleanup called base.close(), which set `finished = true` and
    // made every later consult return `skipped/lane-finished`.
    const second = await lane.consult(input(root, {
      requestId: "v16-8-gen2",
      softDeadlineMs: 30_000,
      hardDeadlineMs: 60_000,
    }))
    assert.notEqual(second.reason, "lane-finished")
    assert.equal(second.outcome, "advised")
    assert.ok(second.advisorText, "a later generation must still receive advice")

    // Let generation 1's late response land, then confirm the lane is still
    // usable: late cleanup must not close the lane for a newer generation.
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(lane.state().finished, false)
    // Generation 2's session must survive generation 1's late cleanup. A
    // teardown that closes "whatever session the lane holds now" would kill the
    // NEWER generation's live session and silently break the next follow-up.
    const secondSession = sessions[1]
    assert.ok(secondSession, "generation 2 must have started its own session")
    assert.equal(
      closed.includes(secondSession),
      false,
      `late cleanup closed the newer generation's session (${secondSession}); closed=${JSON.stringify(closed)}`,
    )
    const third = await lane.consult(input(root, {
      requestId: "v16-8-gen3",
      softDeadlineMs: 30_000,
      hardDeadlineMs: 60_000,
    }))
    assert.notEqual(third.reason, "lane-finished")
    assert.equal(third.outcome, "advised")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 capsule never admits a target that has no verified workspace proof", () => {
  const ghost = "src/ghost-that-does-not-exist.mjs"
  // Exactly what withUpstreamGrounding() fabricates when no workspace root was
  // proven: a `present` claim derived from the CALLER's own knownFiles list.
  const fabricated = {
    outcome: "advice-accepted",
    requestId: "v16-8-fabricated",
    advice: {
      summary: "The contract is inconsistent.",
      recommendedApproach: ["Update the contract."],
      filesToInspect: [ghost],
      verificationSuggestions: ["v"],
      confidence: 0.9,
    },
    evidenceBinding: { claims: [{ path: ghost, status: "present" }] },
  }
  // No file rows => no workspace proof was ever obtained.
  const capsule = buildExecutorAdvisorCapsule(fabricated, { critical: { fileRows: [] } }, { consultGeneration: 1 })
  assert.notEqual(capsule.status, "accepted")
  assert.equal(capsule.modelVisible, null)
  assert.equal(capsule.reason, "unverified-targets")
  assert.equal(capsule.rejectedTargets[0].path, ghost)
})

test("V16.8 timeout-path telemetry is not labelled MEASURED when it is synthesized", async () => {
  const root = repoFixture()
  try {
    const blocking = adapter({
      consult: async (_session, _packet, options = {}) => new Promise((_resolve, reject) => {
        const stop = () => reject(new Error("aborted by v16.8 deadline"))
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
    const result = await lane.consult(input(root))
    assert.equal(result.reason, "web-advisor-hard-deadline")
    const telemetry = result.v16_8.overlapTelemetry
    // The advisor never reported a completion time on this path, so the timing
    // row must not claim to be measured.
    assert.notEqual(telemetry.measurement_provenance.timings, "MEASURED")
    assert.equal(telemetry.measurement_provenance.timings, "PARTIAL")
    assert.equal(telemetry.advisor_completed, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 production controller passes the verified workspace root to the barrier", () => {
  const source = readFileSync(new URL("../pi/extensions/ues.ts", import.meta.url), "utf8")
  // `createRunWebLane` must hand the run's VERIFIED Git root to the lane.
  // Without it `resolveBarrierWorkspaceRoot` falls back to process.cwd() and the
  // barrier can run unproven, which lets an advisor target that does not exist
  // reach the executor capsule as `validated`.
  assert.match(source, /workspaceRoot: cwd/)
  const createLane = source.slice(source.indexOf("function createRunWebLane"))
  assert.match(createLane.slice(0, 2_500), /workspaceRoot: cwd/, "createRunWebLane must pass workspaceRoot")
  // Both consultation call sites (primary execute + patch review) must too.
  const callSites = source.split(/webLane\.consult\(\{/).slice(1)
  assert.ok(callSites.length >= 2, `expected >=2 webLane.consult call sites, found ${callSites.length}`)
  for (const site of callSites) {
    assert.match(site.slice(0, 1_200), /workspaceRoot: cwd/, "every webLane.consult call site must pass workspaceRoot")
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
