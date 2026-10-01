import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { compileModelAciProfile, modelRuntimeProfile } from "../lib/model-runtime-profile.mjs"
import { compilePolicyLattice, evaluatePolicyLattice } from "../lib/permission-policy.mjs"
import { roleContextABI, applyRoleContextABI } from "../lib/role-context-abi.mjs"
import { diversityVerificationPolicy } from "../lib/diversity-verification.mjs"
import { evaluateSkillActivation, skillDietDecision, skillMetadataSurface } from "../lib/skill-activation.mjs"
import { buildContextObservatory, buildDecisionReplayPacket, contextReportFromTrajectory, decisionPointFingerprint } from "../lib/context-observatory.mjs"
import { buildRehydrationManifest, renderRehydrationManifest } from "../lib/rehydration-manifest.mjs"
import { RUNTIME_HOOK_EVENTS, RuntimeHookBus } from "../lib/runtime-hooks.mjs"

test("V15.9 model ACI compiler attenuates scaffolding by measured surface", () => {
  const weak = modelRuntimeProfile("provider/weak", {
    role: "executor",
    performanceRecord: { samples: 12, passRate: 0.5, avgRetries: 2 },
    performanceMinSamples: 8,
  })
  const strong = modelRuntimeProfile("provider/strong", {
    role: "executor",
    performanceRecord: { samples: 12, passRate: 1, avgRetries: 0 },
    performanceMinSamples: 8,
  })
  assert.equal(weak.schemaVersion, 3)
  assert.equal(weak.scaffoldLevel, "high")
  assert.equal(strong.scaffoldLevel, "low")
  assert.ok(weak.maxAdvertisedTools < strong.maxAdvertisedTools)
  assert.ok(weak.toolOutputChars < strong.toolOutputChars)

  const aci = compileModelAciProfile("provider/weak", {
    role: "executor",
    performanceRecord: { samples: 12, passRate: 0.5, avgRetries: 2 },
    performanceMinSamples: 8,
  })
  assert.equal(aci.policy.compileVisibilityBeforePrompt, true)
  assert.equal(aci.skillSurface.fullBodiesOnDemand, true)
  assert.equal(aci.contextSurface.deterministicRehydration, true)
})

test("V15.9 role context ABI keeps independent verifier context read-only", () => {
  const abi = roleContextABI("ues-verifier")
  assert.equal(abi.readOnly, true)
  assert.equal(abi.freshContextRequired, true)
  assert.equal(abi.executorRationaleVisible, false)
  const applied = applyRoleContextABI({
    task: "verify checkout",
    diff: "x",
    evidence: [1, 2],
    executorRationale: "do not leak",
    writeIntent: "edit",
  }, "verifier")
  assert.equal(applied.context.executorRationale, undefined)
  assert.equal(applied.context.writeIntent, undefined)
  assert.equal(applied.context.diff, "x")
})

test("V15.9 policy lattice hides deterministic denies before model exposure", () => {
  const plan = compilePolicyLattice([
    { name: "system", rules: [] },
    { name: "repo", rules: [{ action: "shell", resource: "*", effect: "deny" }] },
    { name: "role", rules: [] },
  ], ["bash", "read"])
  assert.deepEqual(plan.precedence, ["system", "repo", "role"])
  assert.equal(plan.tools.includes("bash"), false)
  assert.equal(plan.tools.includes("read"), true)
  assert.equal(plan.hidden.some((row) => row.tool === "bash"), true)

  const decision = evaluatePolicyLattice([
    { name: "repo", rules: [{ action: "read", resource: "secret/*", effect: "deny" }] },
  ], { action: "read", resource: "secret/token.txt" })
  assert.equal(decision.decision.effect, "deny")
})

test("V15.9 diversity verification is risk gated and never exposes executor rationale", () => {
  const low = diversityVerificationPolicy({
    risk: "low",
    executorModel: "p/a",
    alternateModels: ["p/b"],
  })
  assert.equal(low.crossModelPreferred, false)
  const high = diversityVerificationPolicy({
    risk: "high",
    executorModel: "p/a",
    alternateModels: ["p/a", "p/b"],
  })
  assert.equal(high.crossModelPreferred, true)
  assert.equal(high.selectedVerifierModel, "p/b")
  assert.equal(high.hideExecutorRationale, true)
})

test("V15.9 skill activation eval supports diet decisions without auto-promotion", () => {
  const stats = evaluateSkillActivation(
    [
      { id: "a", expected: ["bug-diagnosis"] },
      { id: "b", expected: ["test-verification"] },
      { id: "c", expected: [] },
      { id: "d", expected: [] },
      { id: "e", expected: ["bug-diagnosis"] },
      { id: "f", expected: ["test-verification"] },
      { id: "g", expected: [] },
      { id: "h", expected: [] },
    ],
    [
      { id: "a", selected: ["bug-diagnosis"] },
      { id: "b", selected: ["test-verification"] },
      { id: "c", selected: [] },
      { id: "d", selected: [] },
      { id: "e", selected: ["bug-diagnosis"] },
      { id: "f", selected: ["test-verification"] },
      { id: "g", selected: [] },
      { id: "h", selected: [] },
    ],
  )
  assert.equal(stats.precision, 1)
  assert.equal(stats.recall, 1)
  assert.equal(skillDietDecision(stats).action, "keep")
  const surface = skillMetadataSurface(Array.from({ length: 20 }, (_, i) => ({ name: "skill-" + i, description: "x" })), { limit: 8 })
  assert.equal(surface.skills.length, 8)
  assert.equal(surface.fullSkillBodiesLoaded, false)
})

test("V15.9 deterministic rehydration manifest never trusts model summary", () => {
  const manifest = buildRehydrationManifest({
    source: "deterministic-filesystem-artifacts",
    workspaces: [{
      state: { currentTaskId: "task-2", nextAction: "run verifier" },
      receipts: [{ id: "r1", passed: true }],
      gateReceipts: [{ id: "g1", verdict: "PASS" }],
    }],
  }, {
    changedFiles: ["lib/a.mjs"],
    evidenceRefs: ["evidence:sha256:x"],
    selectedSkills: ["test-verification"],
    runtimeEpoch: "epoch-1",
  })
  assert.equal(manifest.modelSummaryTrustedForDurableState, false)
  assert.equal(manifest.currentTask, "task-2")
  assert.match(renderRehydrationManifest(manifest), /authoritative/i)
})

test("V15.9 context observatory and decision replay are side-effect free", () => {
  const report = buildContextObservatory({
    systemRuntime: "abcd",
    skills: "abcdefgh",
    selectedFiles: "x".repeat(40),
    toolNames: ["read", "read", "grep"],
    unusedToolSchemas: 2,
  })
  assert.ok(report.estimatedTokens > 0)
  assert.equal(report.waste.repeatedTools, 1)
  const decision = decisionPointFingerprint({ model: "p/m", toolSurface: ["read"] })
  const trajectory = {
    traceID: "trace-1",
    events: [
      { type: "decision.profile-compiled", id: "e1", at: "earlier", payload: { decisionPointId: decision.id, modelRuntimeProfile: { id: "p1" }, modelAciProfile: { id: "a1" } } },
      { type: "decision.surface-compiled", id: "e2", at: "now", payload: { decisionPointId: decision.id, modelRuntimeProfile: { id: "p1" }, modelAciProfile: { id: "a1" }, policySnapshotId: "policy:1", runtimeEpochId: "epoch:1", allowedTools: ["read"], selectedSkills: ["repo-explorer"] } },
      { type: "context.observatory", payload: report },
    ],
  }
  const replay = buildDecisionReplayPacket(trajectory, decision.id)
  assert.equal(replay.found, true)
  assert.equal(replay.sideEffectsAllowed, false)
  assert.equal(replay.toolExecutionAllowed, false)
  assert.equal(replay.surfaceExact, true)
  assert.deepEqual(replay.allowedTools, ["read"])
  assert.deepEqual(replay.selectedSkills, ["repo-explorer"])
  assert.equal(report.measured, false)
  assert.equal(contextReportFromTrajectory(trajectory).estimatedTokens, report.estimatedTokens)
})

test("V15.9 lifecycle hook ABI exposes deterministic hook boundaries", async () => {
  assert.ok(RUNTIME_HOOK_EVENTS.includes("tool.before"))
  assert.ok(RUNTIME_HOOK_EVENTS.includes("compaction.after"))
  assert.ok(RUNTIME_HOOK_EVENTS.includes("verification.before"))
  const bus = new RuntimeHookBus()
  bus.on("tool.before", () => ({ decision: "modify", patch: { bounded: true } }))
  const result = await bus.emit("tool.before", { bounded: false })
  assert.equal(result.payload.bounded, true)
  assert.equal(bus.snapshot().schemaVersion, 2)
})


test("V15.9 Pi runtime wires lifecycle ABI and exact surface telemetry", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const parent = await readFile(path.join(root, "pi", "extensions", "ues.ts"), "utf8")
  const child = await readFile(path.join(root, "pi", "extensions", "ues-child-runtime.ts"), "utf8")
  for (const marker of [
    'PARENT_RUNTIME_HOOKS.emit("tool.before-expose"',
    'PARENT_RUNTIME_HOOKS.emit("context.before-build"',
    'PARENT_RUNTIME_HOOKS.emit("context.after-build"',
    'PARENT_RUNTIME_HOOKS.emit("compaction.before"',
    'PARENT_RUNTIME_HOOKS.emit("compaction.after"',
    'PARENT_RUNTIME_HOOKS.emit("finalize.before"',
    'PARENT_RUNTIME_HOOKS.emit("finalize.after"',
    '"decision.surface-compiled"',
    "policySnapshotId: policySnapshot.id",
    "allowedTools: [...allowedTools]",
  ]) assert.ok(parent.includes(marker), "missing parent runtime marker: " + marker)

  for (const marker of [
    'RUNTIME_HOOKS.emit("tool.before"',
    'RUNTIME_HOOKS.emit("tool.after"',
    'RUNTIME_HOOKS.emit("write.before"',
    'RUNTIME_HOOKS.emit("write.after"',
    'RUNTIME_HOOKS.emit("verification.before"',
    'RUNTIME_HOOKS.emit("verification.after"',
    "governToolOutput",
    "uesOutputGovernor",
  ]) assert.ok(child.includes(marker), "missing child runtime marker: " + marker)
})
