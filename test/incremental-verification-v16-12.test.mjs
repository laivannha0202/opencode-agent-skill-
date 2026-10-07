// V16.12 Incremental Verification Planner: behavior tests.
//
// The planner is a COMPOSITION over the V16.10 verification ladder. It must
// never create a second rung ordering, must escalate on uncertainty, and must
// never plan away the final release gate. These tests pin the shape mapping and
// the escalation laws.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  INCREMENTAL_VERIFICATION_POLICY,
  TASK_SHAPE,
  FAST_PATH,
  classifyTaskShape,
  shapePolicy,
  shapeFastPath,
  planIncrementalVerification,
  checkReceiptReuse,
  buildFailureDelta,
  recommendNextTarget,
  planIsSatisfied,
} from "../lib/incremental-verification-v16-12.mjs"
import { VERIFICATION_RUNG, EVIDENCE_STRENGTH } from "../lib/verification-ladder-v16-10.mjs"

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "ues-incr-verify-"))
}

test("incremental verification policy id is byte-stable", () => {
  assert.equal(INCREMENTAL_VERIFICATION_POLICY, "incremental-verification-v16-12")
})

test("classifyTaskShape: tiny -> normal -> deep by surface", () => {
  assert.equal(classifyTaskShape({ changedFiles: [] }), TASK_SHAPE.TINY)
  assert.equal(classifyTaskShape({ changedFiles: ["docs/a.md"], docsOnly: true }), TASK_SHAPE.TINY)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/a.mjs"] }), TASK_SHAPE.TINY)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/a.mjs", "lib/b.mjs"] }), TASK_SHAPE.NORMAL)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/a.mjs", "lib/b.mjs", "lib/c.mjs", "lib/d.mjs"] }), TASK_SHAPE.DEEP)
})

test("classifyTaskShape: a shared surface escalates to DEEP regardless of file count", () => {
  assert.equal(classifyTaskShape({ changedFiles: ["lib/index.mjs"] }), TASK_SHAPE.DEEP)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/scheduler.mjs"] }), TASK_SHAPE.DEEP)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/a.mjs"], crossModule: true }), TASK_SHAPE.DEEP)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/a.mjs"], verifierFailed: true }), TASK_SHAPE.DEEP)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/a.mjs"], risk: "high" }), TASK_SHAPE.DEEP)
  assert.equal(classifyTaskShape({ changedFiles: ["lib/a.mjs"], risk: "critical" }), TASK_SHAPE.DEEP)
})

test("classifyTaskShape: final release is always RELEASE", () => {
  assert.equal(classifyTaskShape({ finalRelease: true, changedFiles: ["docs/a.md"], docsOnly: true }), TASK_SHAPE.RELEASE)
})

test("shapeFastPath maps every shape to a deterministic fast path", () => {
  assert.equal(shapeFastPath(TASK_SHAPE.TINY), FAST_PATH.TINY_FAST_PATH)
  assert.equal(shapeFastPath(TASK_SHAPE.NORMAL), FAST_PATH.NORMAL_PATH)
  assert.equal(shapeFastPath(TASK_SHAPE.DEEP), FAST_PATH.DEEP_PATH)
  assert.equal(shapeFastPath(TASK_SHAPE.RELEASE), FAST_PATH.RELEASE_PATH)
})

test("a tiny single-file change targets the static rung", () => {
  const plan = planIncrementalVerification({ changedFiles: ["lib/a.mjs"] })
  assert.equal(plan.shape, TASK_SHAPE.TINY)
  assert.equal(plan.targetRung, VERIFICATION_RUNG.STATIC)
  assert.equal(plan.fastPath, FAST_PATH.TINY_FAST_PATH)
  assert.equal(plan.allowFullSuiteDuringImplementation, false)
  assert.equal(plan.allowReleaseVerify, false)
})

test("a normal multi-file change targets affected tests", () => {
  const plan = planIncrementalVerification({ changedFiles: ["lib/a.mjs", "lib/b.mjs"] })
  assert.equal(plan.shape, TASK_SHAPE.NORMAL)
  assert.equal(plan.targetRung, VERIFICATION_RUNG.AFFECTED)
  assert.equal(plan.allowFullSuiteDuringImplementation, false)
})

test("a deep cross-module change targets the full suite and allows it", () => {
  const plan = planIncrementalVerification({ changedFiles: ["lib/index.mjs"] })
  assert.equal(plan.shape, TASK_SHAPE.DEEP)
  assert.equal(plan.targetRung, VERIFICATION_RUNG.SUITE)
  assert.equal(plan.allowFullSuiteDuringImplementation, true)
})

test("final release targets the full suite, requires release verify, and disables receipt reuse", () => {
  const plan = planIncrementalVerification({ finalRelease: true, changedFiles: ["lib/a.mjs"] })
  assert.equal(plan.shape, TASK_SHAPE.RELEASE)
  assert.equal(plan.targetRung, VERIFICATION_RUNG.SUITE)
  assert.equal(plan.fastPath, FAST_PATH.RELEASE_PATH)
  assert.equal(plan.allowReleaseVerify, true)
  assert.equal(plan.receiptReuseEnabled, false)
  assert.equal(plan.finalRelease, true)
})

test("the escalation path always ascends the ladder order", () => {
  const tiny = planIncrementalVerification({ changedFiles: ["lib/a.mjs"] })
  assert.deepEqual(tiny.escalationPath, [VERIFICATION_RUNG.STATIC, VERIFICATION_RUNG.AFFECTED, VERIFICATION_RUNG.SUITE])
  const deep = planIncrementalVerification({ changedFiles: ["lib/index.mjs"] })
  assert.deepEqual(deep.escalationPath, [VERIFICATION_RUNG.SUITE])
})

test("the planner never invents its own rung ordering (it reads the ladder's)", () => {
  const plan = planIncrementalVerification({ changedFiles: ["lib/a.mjs"] })
  const ladderRungs = plan.ladder.rungs.map((row) => row.rung)
  assert.deepEqual(ladderRungs, [VERIFICATION_RUNG.REUSE, VERIFICATION_RUNG.STATIC, VERIFICATION_RUNG.AFFECTED, VERIFICATION_RUNG.SUITE, VERIFICATION_RUNG.INDEPENDENT])
})

test("shapePolicy is conservative: unknown shape falls back to a broad policy", () => {
  const policy = shapePolicy("NOT_A_SHAPE", {})
  assert.equal(policy.risk, "high")
  assert.equal(policy.executionProfile, "standard")
})

test("checkReceiptReuse refuses reuse on the release path", async () => {
  const root = tempRoot()
  try {
    const plan = planIncrementalVerification({ finalRelease: true, changedFiles: ["lib/a.mjs"] })
    let called = false
    const result = await checkReceiptReuse(root, plan, { gateName: "npm test" }, async () => { called = true; return { reusable: true } })
    assert.equal(result.reusable, false)
    assert.equal(called, false, "the lookup must not even be attempted in final-release mode")
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("checkReceiptReuse returns a hit when a fresh receipt exists", async () => {
  const root = tempRoot()
  try {
    const plan = planIncrementalVerification({ changedFiles: ["lib/a.mjs"] })
    const result = await checkReceiptReuse(root, plan, { gateName: "npm test" }, async () => ({ reusable: true, receipt: { gateName: "npm test" } }))
    assert.equal(result.reusable, true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("checkReceiptReuse is a miss (never a throw) when no lookup is provided", async () => {
  const root = tempRoot()
  try {
    const plan = planIncrementalVerification({ changedFiles: ["lib/a.mjs"] })
    const result = await checkReceiptReuse(root, plan, { gateName: "npm test" }, undefined)
    assert.equal(result.reusable, false)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
})

test("recommendNextTarget escalates after a failure, never repeats blindly", () => {
  assert.equal(recommendNextTarget(VERIFICATION_RUNG.STATIC, "fail"), VERIFICATION_RUNG.AFFECTED)
  assert.equal(recommendNextTarget(VERIFICATION_RUNG.AFFECTED, "fail"), VERIFICATION_RUNG.SUITE)
  assert.equal(recommendNextTarget(VERIFICATION_RUNG.SUITE, "fail"), VERIFICATION_RUNG.SUITE)
  assert.equal(recommendNextTarget(VERIFICATION_RUNG.STATIC, "pass"), null)
})

test("buildFailureDelta is compact on a realistic log and names the failed rung", () => {
  const passing = Array.from({ length: 200 }, (_, i) => `ok ${i + 1} - passing case ${i}`)
  const raw = [
    ...passing,
    "not ok 201 - c",
    "  Error: expected 1 to equal 2",
    "    at test/c.test.mjs:10:3",
    "ok 202 - d",
  ].join("\n")
  const delta = buildFailureDelta(raw, { rung: VERIFICATION_RUNG.AFFECTED, command: "node --test", exitCode: 1 })
  assert.equal(delta.failedRung, VERIFICATION_RUNG.AFFECTED)
  assert.equal(delta.outcome, "fail")
  // The point of the budgeter: thousands of passing lines are reduced, and the
  // visible delta is SMALLER than the raw log for a realistic failure.
  assert.ok(delta.visibleChars.value < delta.rawChars.value, `expected visible < raw, saw ${delta.visibleChars.value} vs ${delta.rawChars.value}`)
  assert.equal(delta.visibleChars.provenance, "MEASURED")
  assert.equal(delta.rawChars.provenance, "MEASURED")
})

test("planIsSatisfied never invents a PASS", () => {
  const plan = planIncrementalVerification({ changedFiles: ["lib/a.mjs"] })
  const unmet = planIsSatisfied(plan, { provenStrength: EVIDENCE_STRENGTH.NONE, verdict: "PASS" })
  assert.equal(unmet.satisfied, false)
  const met = planIsSatisfied(plan, { provenStrength: EVIDENCE_STRENGTH.SYNTAX, verdict: "PASS" })
  assert.equal(met.satisfied, true)
  const noVerdict = planIsSatisfied(plan, { provenStrength: EVIDENCE_STRENGTH.SYNTAX, verdict: "FAIL" })
  assert.equal(noVerdict.satisfied, false)
})

test("planning is deterministic across repeated calls", () => {
  const input = { changedFiles: ["lib/a.mjs", "lib/b.mjs"] }
  assert.deepEqual(planIncrementalVerification(input), planIncrementalVerification(input))
})
