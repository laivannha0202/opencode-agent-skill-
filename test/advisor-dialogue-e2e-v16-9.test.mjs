// V16.9 STATEFUL DIALOGUE E2E.
//
// This test proves the REAL production dialogue across three turns of ONE
// advisor lifecycle, using the shipped production lane (the SAME module
// `pi/extensions/ues.ts` resolves through `LAZY_RUNTIME_MODULES.WEB_REASONING_LANE`)
// plus the evidence broker and shared-context ledger that the controller wires.
//
// The three turns the release directive requires:
//
//   TURN 1  task + bounded evidence -> the advisor ASKS for local evidence
//           (evidenceRequests) -> the EvidenceBroker serves it and the
//           SharedContextLedger records what was delivered.
//   TURN 2  ONLY the new evidence/delta is sent -> a revised strategy -> the
//           controller receives a compact capsule. The FULL context is NOT
//           replayed.
//   VERIFIER FAIL  a verified failure delta drives exactly ONE bounded
//           correction turn in the SAME healthy conversation.
//
// Invariants asserted (each maps to a release acceptance line):
//   * the SAME conversation/session is reused across turns (no respawn);
//   * no full-context replay (the follow-up delta is strictly smaller than the
//     original packet, and the second turn carries only the delta);
//   * no duplicate evidence resend (an unchanged request reuses `evidence_id`);
//   * the max-turn ceiling is enforced (a third follow-up is refused);
//   * novelty termination is enforced (an unchanged repository is a no-op);
//   * a workspace mutation invalidates stale evidence (post-write epoch bump).

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
import { createEvidenceBroker } from "../lib/evidence-broker.mjs"
import { createSharedContextLedger } from "../lib/shared-context-ledger.mjs"

const ADVICE_TURN_1 = {
  summary: "The contract in src/core.mjs disagrees with its consumer.",
  hypotheses: ["A narrow contract mismatch is the root cause."],
  recommendedApproach: ["Read the diff before editing.", "Keep the change scoped to src/core.mjs."],
  filesToInspect: ["src/core.mjs"],
  risks: ["Do not widen the change."],
  edgeCases: [],
  verificationSuggestions: ["Run the focused core test."],
  confidence: 0.9,
  // The advisor ASKS for the workspace diff on turn 1. This is the ONLY way it
  // can obtain local evidence: it runs no tools.
  evidenceRequests: [{ kind: "diff", reason: "Need the exact patch under review." }],
}

const ADVICE_TURN_2 = {
  summary: "The delta confirms the mismatch is one-directional.",
  hypotheses: ["The consumer expects a wider contract."],
  recommendedApproach: ["Update only the consumer call site."],
  filesToInspect: ["src/core.mjs"],
  risks: [],
  edgeCases: [],
  verificationSuggestions: ["Re-run the focused core test."],
  confidence: 0.93,
}

function repoFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-9-dialogue-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Test"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

/**
 * A session-tracking adapter: it records every startSession/consult/followUp so
 * the test can prove the SAME conversation is reused and that no respawn
 * happened between turns.
 */
function trackingAdapter(script) {
  const log = { startSession: 0, consult: 0, followUp: 0, closeSession: 0, sessionIds: [], reused: [] }
  let sessionSeq = 0
  let current = null
  return {
    log,
    id: "deepseek-web",
    capability: async () => ({ state: "ready", reason: "ready", supportsFollowUp: true }),
    startSession: async () => {
      log.startSession += 1
      sessionSeq += 1
      current = { sessionId: `conv-${sessionSeq}`, state: "ready" }
      log.sessionIds.push(current.sessionId)
      return current
    },
    consult: async () => {
      log.consult += 1
      return { answer: JSON.stringify(script.turn1()), latencyMs: 3 }
    },
    followUp: async () => {
      log.followUp += 1
      log.reused.push(current?.sessionId || null)
      return { answer: JSON.stringify(script.turn2()), latencyMs: 3 }
    },
    closeSession: async () => { log.closeSession += 1; return true },
  }
}

async function productionLane(root, adapter, options = {}) {
  resetLazyRuntimeForTests()
  const mod = await hydrateRuntimeModule(LAZY_RUNTIME_MODULES.WEB_REASONING_LANE)
  return mod.createWebReasoningLane({
    mode: "force",
    provider: "deepseek-web",
    adapters: [adapter],
    workspaceRoot: root,
    maxConsultations: 1,
    maxFollowUps: 1,
    softDeadlineMs: 3_000,
    hardDeadlineMs: 6_000,
    ...options,
  })
}

function consultInput(root, overrides = {}) {
  return {
    task: "The verifier still fails and the root cause is ambiguous across this contract.",
    workspaceRoot: root,
    knownFiles: ["src/core.mjs"],
    relevantFiles: [{ path: "src/core.mjs", role: "source", reason: "grounded target" }],
    evidence: [{ kind: "verifier", source: "test", text: "contract mismatch" }],
    affectedSubsystems: 2,
    requestId: "dialogue-1",
    ...overrides,
  }
}

test("V16.9 dialogue E2E: turn 1 consults once, serves evidence, and stays in ONE conversation", async () => {
  const root = repoFixture()
  try {
    const adapter = trackingAdapter({ turn1: () => ADVICE_TURN_1, turn2: () => ADVICE_TURN_2 })
    const lane = await productionLane(root, adapter)

    // TURN 1: consult. The advisor's answer carries an evidence request.
    const first = await lane.consult(consultInput(root))
    assert.equal(first.outcome, "advised")
    assert.equal(first.consulted, true)
    assert.equal(adapter.log.startSession, 1, "exactly one conversation is opened")
    assert.equal(adapter.log.consult, 1)
    assert.ok(first.advisorText, "an accepted consult yields advice")
    assert.equal(first.sessionReusable, true, "the conversation must remain reusable for the next turn")

    // The controller serves the advisor's evidence request through the SAME
    // broker + ledger it wires in production, scoped to this run+workspace.
    const ledger = createSharedContextLedger({ scope: `evidence:dialogue:${root}` })
    ledger.reset()
    const broker = createEvidenceBroker({
      runId: "dialogue",
      root,
      ledger,
      sources: {
        diff: () => {
          writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 2\nexport const extra = 3\n")
          return execFileSync("git", ["diff"], { cwd: root }).toString()
        },
      },
    })
    const served = broker.serve(JSON.stringify({ evidenceRequests: ADVICE_TURN_1.evidenceRequests }), {})
    assert.equal(served.deltasSent, 1, "the broker serves the requested diff")
    assert.equal(served.receipt.evidenceResent, 1, "the first delivery is a full send")
    assert.ok(served.deltaText.includes("value = 2"), "the served delta carries the real workspace change")

    // TURN 2: the follow-up carries ONLY the delta. The same conversation is
    // reused, so no second session is opened.
    const second = await lane.followUp({
      task: consultInput(root).task,
      workspaceRoot: root,
      knownFiles: ["src/core.mjs"],
      evidence: [{ kind: "evidence-delta", source: "ues-evidence-broker", text: served.deltaText }],
      diff: served.deltaText,
      requestId: "dialogue-2",
    })
    assert.equal(second.outcome, "advised", "a real delta produces a revised strategy")
    // The V16.8 follow-up reports participation via `outcome`/`advisorText` (the
    // controller keys on `outcome`, not a top-level `consulted`).
    assert.equal(adapter.log.startSession, 1, "turn 2 must NOT respawn the conversation")
    assert.equal(adapter.log.followUp, 1, "the follow-up goes to the SAME adapter session")
    assert.deepEqual(adapter.log.reused, ["conv-1"], "the follow-up reuses conversation conv-1")
    assert.ok(second.advisorText, "the revised strategy reaches the controller as advice")
    assert.equal(second.sessionReusable, true)

    // NO FULL-CONTEXT REPLAY: the follow-up delta must be strictly smaller than
    // the original packet (it carries only what changed).
    assert.ok(
      second.delta.chars < first.packet.chars,
      `follow-up delta (${second.delta.chars}) must be smaller than the original packet (${first.packet.chars})`,
    )
    ledger.reset()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.9 dialogue E2E: unchanged evidence is reused, not resent (no duplicate evidence)", async () => {
  const root = repoFixture()
  try {
    const ledger = createSharedContextLedger({ scope: `evidence:dup:${root}` })
    ledger.reset()
    const body = Array.from({ length: 200 }, (_, i) => `export const row${i} = ${i}`).join("\n")
    const broker = createEvidenceBroker({ runId: "dup", root, ledger, sources: { diff: () => body } })
    const request = JSON.stringify({ evidenceRequests: [{ kind: "diff" }] })

    const first = broker.serve(request, {})
    const charsAfterFirst = broker.telemetry().budget.charsSent
    const second = broker.serve(request, {})

    assert.equal(first.receipt.evidenceResent, 1)
    assert.equal(second.receipt.evidenceReused, 1, "the second identical request reuses the evidence_id")
    assert.equal(second.receipt.evidenceResent, 0)
    assert.ok(second.deltaText.includes("evidence_id="), "a reuse is delivered as an id marker")
    assert.equal(
      broker.telemetry().budget.charsSent,
      charsAfterFirst,
      "an unchanged request must not be re-charged to the run budget",
    )
    ledger.reset()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.9 dialogue E2E: max-turn ceiling refuses a second follow-up", async () => {
  const root = repoFixture()
  try {
    const adapter = trackingAdapter({ turn1: () => ADVICE_TURN_1, turn2: () => ADVICE_TURN_2 })
    const lane = await productionLane(root, adapter)
    await lane.consult(consultInput(root))
    const followUpInput = {
      task: consultInput(root).task,
      workspaceRoot: root,
      knownFiles: ["src/core.mjs"],
      evidence: [{ kind: "verifier", source: "test", text: "still failing" }],
      diff: "export const value = 2",
      requestId: "dialogue-follow-1",
    }
    const firstFollowUp = await lane.followUp(followUpInput)
    assert.equal(firstFollowUp.outcome, "advised", "the first follow-up is dispatched")
    assert.ok(firstFollowUp.advisorText)
    // A second follow-up (maxFollowUps: 1) must be REFUSED, never dispatched.
    const secondFollowUp = await lane.followUp({ ...followUpInput, diff: "export const value = 3", requestId: "dialogue-follow-2" })
    assert.equal(secondFollowUp.outcome, "skipped", "the max-turn ceiling must refuse the extra turn")
    assert.equal(adapter.log.followUp, 1, "only ONE follow-up reaches the adapter")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.9 dialogue E2E: an unchanged repository terminates as a novelty no-op", async () => {
  const root = repoFixture()
  try {
    const adapter = trackingAdapter({ turn1: () => ADVICE_TURN_1, turn2: () => ADVICE_TURN_2 })
    const lane = await productionLane(root, adapter)
    await lane.consult(consultInput(root))
    // A follow-up whose input is byte-identical to the prior packet has NO
    // fresh delta: it must terminate as a skip, not burn a turn.
    const noNovelty = await lane.followUp({
      task: consultInput(root).task,
      workspaceRoot: root,
      knownFiles: ["src/core.mjs"],
      relevantFiles: [{ path: "src/core.mjs", role: "source", reason: "grounded target" }],
      evidence: [{ kind: "verifier", source: "test", text: "contract mismatch" }],
      requestId: "dialogue-noop",
    })
    assert.equal(noNovelty.outcome, "skipped", "an unchanged repository must not dispatch a turn")
    assert.equal(noNovelty.reason, "identical-fingerprint", "the termination reason is the novelty check")
    assert.equal(adapter.log.followUp, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.9 dialogue E2E: a workspace mutation invalidates stale evidence (epoch bump forces re-send)", async () => {
  const root = repoFixture()
  try {
    const ledger = createSharedContextLedger({ scope: `evidence:mut:${root}` })
    ledger.reset()
    const body = Array.from({ length: 200 }, (_, i) => `row-${i}`).join("\n")
    const broker = createEvidenceBroker({ runId: "mut", root, ledger, sources: { diff: () => body } })
    const request = JSON.stringify({ evidenceRequests: [{ kind: "diff" }] })

    broker.serve(request, {})
    const reused = broker.serve(request, {})
    assert.equal(reused.receipt.evidenceReused, 1, "unchanged evidence is reused within an epoch")

    // A writer agent finished a turn: the workspace may have moved, so the
    // controller bumps the ledger epoch (exactly what `ues.ts` does after a
    // WRITE_AGENTS turn). The same bytes are now NEW against an empty epoch.
    ledger.bumpEpoch("post-write:executor")
    const afterMutation = broker.serve(request, {})
    assert.equal(afterMutation.receipt.evidenceResent, 1, "after a write the evidence is re-sent in full")
    assert.equal(afterMutation.receipt.evidenceReused, 0, "no stale evidence_id survives the mutation")
    ledger.reset()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
