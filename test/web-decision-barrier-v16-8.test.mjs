import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  V16_8_CAPSULE_MAX_CHARS,
  buildExecutorAdvisorCapsule,
  captureBarrierFingerprint,
  deterministicResolutionProof,
  evaluateDecisionBarrier,
  overlapTelemetry,
  phase0FastGrounding,
  renderExecutorAdvisorCapsule,
  resolveBarrierWorkspaceRoot,
  startReadOnlyLocalPrep,
} from "../lib/web-decision-barrier-v16-8.mjs"

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-8-barrier-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Test"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  mkdirSync(path.join(root, "test"), { recursive: true })
  mkdirSync(path.join(root, "generated"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  writeFileSync(path.join(root, "test", "core.test.mjs"), "import '../src/core.mjs'\n")
  writeFileSync(path.join(root, "generated", "client.mjs"), "export const generated = true\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function acceptedAdvice(files = ["src/core.mjs"]) {
  return {
    outcome: "advice-accepted",
    requestId: "req-1",
    advice: {
      summary: "The exported value and its consumer disagree about the intended contract.",
      hypotheses: ["Contract mismatch"],
      recommendedApproach: ["Update the source contract once.", "Keep the change scoped."],
      filesToInspect: files,
      verificationSuggestions: ["Run the focused core test"],
      confidence: 0.83,
    },
    evidenceBinding: {
      claims: files.map((file) => ({ path: file, status: "present" })),
    },
  }
}

test("V16.8 Phase 0 is bounded shaping only", () => {
  let tick = 10
  const result = phase0FastGrounding({
    task: "Fix the ambiguous core failure",
    knownFiles: ["src/core.mjs"],
    evidence: [{ kind: "verifier", text: "TypeError: contract mismatch" }],
  }, { now: () => tick++ })
  assert.equal(result.activeFile, "src/core.mjs")
  assert.match(result.primaryError, /TypeError/)
  assert.equal(result.durationMs, 1)
  assert.equal(result.withinHardBudget, true)
  assert.equal(result.taskFingerprint.length, 32)
})

test("V16.8 workspace root is accepted only with contained existing grounded files", () => {
  const root = fixture()
  try {
    const resolved = resolveBarrierWorkspaceRoot({ knownFiles: ["src/core.mjs"] }, { workspaceRoot: root })
    assert.equal(resolved.root, root)
    assert.equal(resolved.required, true)
    const escaped = resolveBarrierWorkspaceRoot({ knownFiles: ["../outside.mjs"] }, { workspaceRoot: root })
    assert.equal(escaped.root, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 read-only prep discovers affected tests without executing them", async () => {
  const root = fixture()
  try {
    const prep = startReadOnlyLocalPrep({ knownFiles: ["src/core.mjs"] }, { workspaceRoot: root })
    const critical = await prep.critical
    const optional = await prep.optional
    assert.deepEqual(critical.validFiles, ["src/core.mjs"])
    assert.equal(optional.ok, true)
    assert.equal(optional.tests.some((row) => String(row?.file || row?.path || row).includes("core.test")), true)
    // Discovery is static. The source file remains byte-identical and no build
    // product is created as a side effect of the overlap lane.
    assert.equal(captureBarrierFingerprint(root).fingerprint, prep.beforeFingerprint.fingerprint)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 capsule rejects generated targets and never exceeds 1200 chars", async () => {
  const root = fixture()
  try {
    const prepHandle = startReadOnlyLocalPrep({ knownFiles: ["src/core.mjs", "generated/client.mjs"] }, { workspaceRoot: root })
    const critical = await prepHandle.critical
    const optional = await prepHandle.optional
    const result = acceptedAdvice(["src/core.mjs", "generated/client.mjs"])
    const capsule = buildExecutorAdvisorCapsule(result, { critical, optional, afterFingerprint: captureBarrierFingerprint(root) }, { consultGeneration: 1 })
    assert.equal(capsule.status, "degraded")
    assert.deepEqual(capsule.modelVisible.files_to_touch, ["src/core.mjs"])
    assert.equal(capsule.rejectedTargets[0].reason.includes("generated"), true)
    assert.ok(capsule.chars <= V16_8_CAPSULE_MAX_CHARS)
    const rendered = renderExecutorAdvisorCapsule(capsule)
    assert.match(rendered, /^UES_ADVISOR_CAPSULE/)
    assert.equal(rendered.includes("Chain of Thought"), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.8 barrier discards stale generation and workspace mutation", () => {
  const capsule = { status: "accepted", modelVisible: { root_cause: "x", files_to_touch: [], concrete_steps: [], test_targets: [] } }
  const result = acceptedAdvice([])
  const barrier = evaluateDecisionBarrier({
    result,
    consultGeneration: 1,
    activeGeneration: 2,
    beforeFingerprint: { available: true, fingerprint: "a" },
    afterFingerprint: { available: true, fingerprint: "b" },
    capsule,
  })
  assert.equal(barrier.passed, false)
  assert.equal(barrier.stale, true)
  assert.ok(barrier.reasons.includes("stale-generation"))
  assert.ok(barrier.reasons.includes("workspace-mutated-during-consult"))
})

test("V16.8 deterministic circuit breaker requires a complete proof", () => {
  assert.equal(deterministicResolutionProof({ deterministicResolution: { proven: true, uniqueCandidate: true, sourceExists: true, diagnosticAgrees: true, mechanicallyDerivable: false } }).proven, false)
  assert.equal(deterministicResolutionProof({ deterministicResolution: { proven: true, uniqueCandidate: true, sourceExists: true, diagnosticAgrees: true, mechanicallyDerivable: true } }).proven, true)
})

test("V16.8 overlap telemetry distinguishes measured chars from estimated tokens", () => {
  const row = overlapTelemetry({
    startedAt: 0,
    finishedAt: 100,
    advisorStartedAt: 10,
    advisorFinishedAt: 80,
    localStartedAt: 20,
    localFinishedAt: 60,
    barrierAt: 82,
    phase0Ms: 3,
    capsuleChars: 300,
    previousAdvisorChars: 1500,
  })
  assert.equal(row.overlap_ms, 40)
  assert.equal(row.model_visible_chars_saved, 1200)
  assert.equal(row.estimated_input_tokens_saved, 300)
  assert.equal(row.estimated_input_tokens_saved_provenance, "ESTIMATED")
  assert.equal(row.measurement_provenance.provider_tokens, "NOT_MEASURED")
})
