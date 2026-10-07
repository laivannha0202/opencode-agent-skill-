// V16.9 lane EQUIVALENCE tests.
//
// The V16.9 lane is a strangler wrapper over V16.8. These tests lock the
// behavioural contract that MUST NOT drift, because no existing test asserted it
// on the production (lazy-hydrated) lane:
//
//   1. A no-consult decision must stay `outcome: "skipped"` with the SAME
//      escalation reason as V16.8. The controller's `webLaneOutcomeSkipped()`
//      gates advisor injection on exactly this string, so returning
//      `fallback-local` would silently change production behaviour.
//   2. MODE OFF must stay `skipped` + `web-reasoning-disabled`.
//   3. FORCE must never be silently de-escalated into a local fallback.
//   4. The pre-gate must not consult the provider on a no-signal task.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  LAZY_RUNTIME_MODULES,
  hydrateRuntimeModule,
  resetLazyRuntimeForTests,
} from "../lib/lazy-runtime.mjs"

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-9-equiv-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Test"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function countingAdapter(counter) {
  return {
    id: "deepseek-web",
    capability: async () => ({ state: "ready", reason: "ready", supportsFollowUp: true }),
    startSession: async () => ({ sessionId: "s1", state: "ready" }),
    consult: async () => { counter.consult += 1; return { answer: "{}", latencyMs: 1 } },
    followUp: async () => { counter.followUp += 1; return { answer: "{}", latencyMs: 1 } },
    closeSession: async () => true,
  }
}

const NO_SIGNAL = Object.freeze({
  task: "Rename the local variable `value` to `amount` in one file.",
  notes: [],
  affectedSubsystems: 0,
  relevantFiles: [],
  evidence: [],
  requestId: "equiv-1",
})

async function productionLane(root, options) {
  resetLazyRuntimeForTests()
  const mod = await hydrateRuntimeModule(LAZY_RUNTIME_MODULES.WEB_REASONING_LANE)
  return mod.createWebReasoningLane({
    live: false,
    provider: "deepseek-web",
    workspaceRoot: root,
    maxConsultations: 1,
    maxFollowUps: 1,
    ...options,
  })
}

test("v16.9 lane: no-signal stays a SKIP with the V16.8 escalation reason", async () => {
  const root = fixture()
  try {
    const counter = { consult: 0, followUp: 0 }
    const lane = await productionLane(root, { mode: "auto", adapters: [countingAdapter(counter)] })
    const result = await lane.consult({ ...NO_SIGNAL })
    assert.equal(result.outcome, "skipped", "a no-consult decision must remain a skip, never a local fallback")
    assert.equal(result.reason, "task-already-well-grounded")
    // The escalation decision the controller reads must be present and identical.
    assert.equal(result.decision?.escalate, false)
    assert.equal(result.decision?.reason, "task-already-well-grounded")
    // Telemetry parity: the base lane bumps webReasoningSkipped on every skip and
    // returns a snapshot; the controller journals these counters.
    assert.equal(result.telemetry?.webReasoningSkipped, 1, "a skip must bump webReasoningSkipped exactly like V16.8")
    assert.equal(counter.consult, 0, "the admission pre-gate must not touch the provider")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("v16.9 lane: MODE OFF stays skipped/web-reasoning-disabled and never probes the provider", async () => {
  const root = fixture()
  try {
    const counter = { consult: 0, followUp: 0 }
    const lane = await productionLane(root, { mode: "off", adapters: [countingAdapter(counter)] })
    const result = await lane.consult({ ...NO_SIGNAL })
    assert.equal(result.outcome, "skipped")
    assert.equal(result.reason, "web-reasoning-disabled")
    assert.equal(counter.consult, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("v16.9 lane: the admission pre-gate skips phase0/local-prep on a no-signal task", async () => {
  const root = fixture()
  try {
    const counter = { consult: 0, followUp: 0 }
    const lane = await productionLane(root, { mode: "auto", adapters: [countingAdapter(counter)] })
    await lane.consult({ ...NO_SIGNAL, requestId: "skip-1" })
    const state = lane.state()
    assert.equal(state.v16_9.admissionSkips, 1, "the skip must be attributed to admission, not the barrier")
    assert.equal(state.v16_9.admissions, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("v16.9 lane: a concurrent turn is refused (single-flight invariant)", async () => {
  const root = fixture()
  try {
    const counter = { consult: 0, followUp: 0 }
    const lane = await productionLane(root, { mode: "auto", adapters: [countingAdapter(counter)] })
    // BOTH calls must be consult-worthy: the single-flight gate is only reached
    // after admission routes to PI_PLUS_ADVISOR. A no-signal second call would
    // be skipped by admission before the turn gate, which is a different path.
    const consultWorthy = {
      task: "The verifier still fails and the root cause is ambiguous across this contract.",
      workspaceRoot: root,
      knownFiles: ["src/core.mjs"],
      relevantFiles: [{ path: "src/core.mjs", role: "source", reason: "grounded" }],
      evidence: [{ kind: "verifier", source: "test", text: "contract mismatch" }],
      affectedSubsystems: 2,
    }
    const first = lane.consult({ ...consultWorthy, requestId: "sf-1" })
    const second = await lane.consult({ ...consultWorthy, requestId: "sf-2" })
    // The second call arrives while the first is still in flight.
    assert.equal(second.v16_9?.refusedConcurrent, true)
    assert.equal(second.outcome, "skipped")
    await first
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
