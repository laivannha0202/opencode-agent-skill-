// V16.9 module tests: advisor-session-manager + advisor-answer-observer +
// advisor-capsule + execution-coordinator.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  ADVISOR_SESSION_MANAGER_POLICY,
  createAdvisorSessionManager,
} from "../lib/advisor-session-manager.mjs"
import {
  ADVISOR_ANSWER_OBSERVER_POLICY,
  createAdvisorAnswerObserver,
} from "../lib/advisor-answer-observer.mjs"
import {
  ADVISOR_CAPSULE_POLICY,
  capsuleChangeNote,
  createAdvisorCapsuleOwner,
} from "../lib/advisor-capsule.mjs"
import {
  EXECUTION_COORDINATOR_POLICY,
  HANDOFF_STATUS,
  createExecutionCoordinator,
} from "../lib/execution-coordinator.mjs"

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-v16-9-exec-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "UES Test"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 1\n")
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
    evidenceBinding: { claims: files.map((file) => ({ path: file, status: "present" })) },
  }
}

function prep(root, rows) {
  return {
    root,
    critical: {
      fileRows: rows,
      validFiles: rows.filter((row) => row.exists && row.writable && !row.generated).map((row) => row.path),
      generatedFiles: rows.filter((row) => row.generated).map((row) => row.path),
      readOnlyFiles: rows.filter((row) => row.exists && !row.writable).map((row) => row.path),
    },
    optional: { tests: ["test/core.test.mjs"] },
  }
}

test("session-manager: turn gate enforces the budget", () => {
  const manager = createAdvisorSessionManager({ id: "s1", turnBudget: 2 })
  assert.equal(manager.maySend("consult").allowed, true)
  manager.recordTurn("consult", { advisorText: "a" })
  manager.recordTurn("follow-up", { advisorText: "b" })
  const third = manager.maySend("consult")
  assert.equal(third.allowed, false)
  assert.match(third.reason, /turn-budget-exhausted/)
})

test("session-manager: resume capsule is consumed exactly once", () => {
  const manager = createAdvisorSessionManager({ id: "s2", turnBudget: 3, resumeCapsule: "capsule-body" })
  assert.equal(manager.hasPendingResumeCapsule(), true)
  assert.equal(manager.takeResumeCapsule(), "capsule-body")
  assert.equal(manager.takeResumeCapsule(), "")
  assert.equal(manager.hasPendingResumeCapsule(), false)
})

test("session-manager: generation identity detects a stale result", () => {
  const manager = createAdvisorSessionManager({ id: "s3", turnBudget: 3 })
  const gen = manager.state().generationId
  assert.equal(manager.isCurrentGeneration({ generationId: gen }), true)
  assert.equal(manager.isCurrentGeneration({ generationId: "gen-other" }), false)
})

test("session-manager: close prevents further turns", () => {
  const manager = createAdvisorSessionManager({ id: "s4", turnBudget: 3 })
  manager.close("done")
  assert.equal(manager.maySend("consult").allowed, false)
  assert.equal(manager.recordTurn("consult", {}).recorded, false)
})

test("answer-observer: a new region with parsed JSON is final", () => {
  let clock = 0
  const observer = createAdvisorAnswerObserver({ stableMs: 1000, now: () => clock })
  const baseline = { counts: { dataMessageRoleAssistant: 0 } }
  clock = 100
  const mid = observer.observe({ observation: { counts: { dataMessageRoleAssistant: 1 }, answerText: "{\"a\":" }, baseline })
  assert.equal(mid.done, false)
  const final = observer.observe({
    observation: { counts: { dataMessageRoleAssistant: 1 }, answerText: "{\"a\":1}" },
    baseline,
    parseResult: { ok: true },
  })
  assert.equal(final.done, true)
  assert.equal(final.reason, "valid-complete-json")
})

test("answer-observer: a read failure is recoverable up to the ceiling", () => {
  const observer = createAdvisorAnswerObserver({ maxPolls: 5 })
  const first = observer.observe({ readError: new Error("read failed") })
  assert.equal(first.recoverable, true)
  assert.equal(first.action, "retry-read")
  observer.observe({ readError: new Error("read failed") })
  const third = observer.observe({ readError: new Error("read failed") })
  assert.equal(third.recoverable, false)
  assert.equal(third.action, "fail")
})

test("answer-observer: a stale answer (no new region) keeps polling", () => {
  const observer = createAdvisorAnswerObserver({ maxPolls: 3 })
  const baseline = { counts: { dataMessageRoleAssistant: 1 } }
  const result = observer.observe({ observation: { counts: { dataMessageRoleAssistant: 1 }, answerText: "old" }, baseline })
  assert.equal(result.done, false)
  assert.equal(result.action, "continue")
})

test("capsule: change note reports added and removed files", () => {
  const previous = { modelVisible: { files_to_touch: ["a.mjs"], concrete_steps: ["s1"], root_cause: "r" } }
  const current = { modelVisible: { files_to_touch: ["b.mjs"], concrete_steps: ["s1"], root_cause: "r" } }
  const note = capsuleChangeNote(previous, current)
  assert.equal(note.changed, true)
  assert.deepEqual(note.addedFiles, ["b.mjs"])
  assert.deepEqual(note.removedFiles, ["a.mjs"])
})

test("capsule-owner: a discarded capsule preserves the current one", () => {
  const owner = createAdvisorCapsuleOwner()
  const accepted = owner.build(acceptedAdvice(), prep(fixture(), [{ path: "src/core.mjs", exists: true, writable: true, generated: false }]))
  const firstReceipt = owner.commit(accepted, { turn: 1 })
  assert.equal(firstReceipt.accepted, true)
  assert.ok(owner.current())
  const discardedReceipt = owner.commit({ status: "discarded", reason: "all-advisor-targets-invalid" }, { turn: 2 })
  assert.equal(discardedReceipt.accepted, false)
  assert.equal(discardedReceipt.currentPreserved, true)
  assert.ok(owner.current())
})

test("execution-coordinator: a clean handoff is ready with executor advice", () => {
  const root = fixture()
  try {
    const coordinator = createExecutionCoordinator({ root })
    const before = coordinator.armBefore()
    const after = { available: true, fingerprint: before.fingerprint, changedFiles: [] }
    const result = acceptedAdvice(["src/core.mjs"])
    const handoff = coordinator.coordinate({
      result,
      prep: prep(root, [{ path: "src/core.mjs", exists: true, writable: true, generated: false }]),
      beforeFingerprint: before,
      afterFingerprint: after,
      consultGeneration: 1,
      activeGeneration: 1,
      writeTargets: ["src/core.mjs"],
    })
    assert.equal(handoff.status, HANDOFF_STATUS.READY)
    assert.equal(typeof handoff.executorAdvice, "string")
    assert.equal(handoff.mayProducePass, false)
    assert.equal(handoff.isToolInvocation, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("execution-coordinator: a workspace mutation refuses the handoff", () => {
  const root = fixture()
  try {
    const coordinator = createExecutionCoordinator({ root })
    const before = coordinator.armBefore()
    writeFileSync(path.join(root, "src", "core.mjs"), "export const value = 9\n")
    const after = { available: true, fingerprint: before.fingerprint + "-changed", changedFiles: ["src/core.mjs"] }
    const handoff = coordinator.coordinate({
      result: acceptedAdvice(["src/core.mjs"]),
      prep: prep(root, [{ path: "src/core.mjs", exists: true, writable: true, generated: false }]),
      beforeFingerprint: before,
      afterFingerprint: after,
      consultGeneration: 1,
      activeGeneration: 1,
      writeTargets: ["src/core.mjs"],
    })
    assert.equal(handoff.status, HANDOFF_STATUS.REFUSED)
    assert.equal(handoff.executorAdvice, null)
    assert.ok(handoff.reasons.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("execution-coordinator: a stale generation refuses the handoff", () => {
  const root = fixture()
  try {
    const coordinator = createExecutionCoordinator({ root })
    const before = coordinator.armBefore()
    const handoff = coordinator.coordinate({
      result: acceptedAdvice(["src/core.mjs"]),
      prep: prep(root, [{ path: "src/core.mjs", exists: true, writable: true, generated: false }]),
      beforeFingerprint: before,
      afterFingerprint: { available: true, fingerprint: before.fingerprint, changedFiles: [] },
      consultGeneration: 1,
      activeGeneration: 2,
      writeTargets: ["src/core.mjs"],
    })
    assert.equal(handoff.status, HANDOFF_STATUS.REFUSED)
    assert.ok(handoff.reasons.includes("stale-generation"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("policies are stable", () => {
  assert.equal(ADVISOR_SESSION_MANAGER_POLICY, "advisor-session-manager-v16-9")
  assert.equal(ADVISOR_ANSWER_OBSERVER_POLICY, "advisor-answer-observer-v16-9")
  assert.equal(ADVISOR_CAPSULE_POLICY, "advisor-capsule-v16-9")
  assert.equal(EXECUTION_COORDINATOR_POLICY, "execution-coordinator-v16-9")
})
