import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { classifyEngineeringTask } from "../lib/task-policy.mjs"
import { classifyDecisionPolicy } from "../lib/decision-policy.mjs"
import { selectSkillNames } from "../lib/skill-compiler.mjs"
import { auditCompletion } from "../lib/completion-auditor.mjs"
import { buildCompactionResumeGuard } from "../lib/compaction-resume-guard.mjs"

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}

function passingVerification(acceptance) {
  return {
    exitCode: 0,
    verdict: "PASS",
    output: "UES_VERDICT: PASS",
    report: {
      valid: true,
      verdict: "PASS",
      sections: {
        "checks-run": "node --test target => exit 0",
        "acceptance-criteria-proven": acceptance,
        "failures": "None",
        "unresolved-gaps": "None",
        "checks-not-run": "None",
        "completion-evidence": "Fresh targeted test passed.",
      },
    },
  }
}

test("decision fabric keeps ambiguous debug work out of the fast lane", () => {
  const policy = classifyEngineeringTask("fix the build error in this project")
  assert.equal(policy.executionProfile, "standard")
  assert.equal(policy.modelTier, "standard")
  assert.equal(policy.ambiguousDebug, true)
  assert.equal(policy.decision.kind, "task-route")
  assert.equal(policy.decision.crossCheckRecommended, true)
  assert.ok(policy.decision.confidence < 0.72)
})

test("decision fabric preserves high-confidence single-file fast work", () => {
  const policy = classifyEngineeringTask("fix src/refund.ts")
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.singleFileBounded, true)
  assert.equal(policy.decision.confidenceBand, "high")
  assert.equal(policy.decision.value.mode, "inline")
})

test("decision confidence preserves clearly bounded local debug fast lanes", () => {
  for (const prompt of [
    "Fix this local parser bug.",
    "Fix this React useEffect stale closure bug.",
  ]) {
    const policy = classifyEngineeringTask(prompt)
    assert.equal(policy.executionProfile, "fast")
    assert.equal(policy.modelTier, "light")
    assert.equal(policy.boundedDebugHint, true)
    assert.ok(policy.decision.confidence >= 0.80)
    assert.equal(policy.decision.crossCheckRecommended, false)
  }
})

test("durable decisions expose typed deterministic confidence", () => {
  const safe = classifyDecisionPolicy("Use a temporary local fixture and rename the internal helper")
  assert.equal(safe.autoResolvable, true)
  assert.equal(safe.decision.value, "auto-resolve")
  assert.equal(safe.decision.confidenceBand, "high")

  const unsafe = classifyDecisionPolicy("npm publish then deploy to production")
  assert.equal(unsafe.requiresUser, true)
  assert.equal(unsafe.decision.value, "escalate-to-user")
  assert.equal(unsafe.decision.confidenceBand, "high")
})

test("micro-skill ranking keeps primary role skill while promoting task-relevant domain skill", () => {
  const selected = selectSkillNames(
    { maxSkills: 2, domains: ["payment"] },
    "architect",
    { taskText: "plan a refund payment flow change" },
  )
  assert.equal(selected[0], "software-architect")
  assert.ok(selected.includes("payment-engineering"))
  assert.equal(selected.length, 2)
})

test("completion auditor rejects inferred or unknown acceptance claims", () => {
  const inferred = auditCompletion({
    verification: passingVerification("INFERRED: refund path should be idempotent"),
    requireIntegration: false,
    requireVisual: false,
    behavioralReceipts: [{ passed: true, exitCode: 0 }],
    requireBehavioralReceipt: true,
  })
  assert.equal(inferred.passed, false)
  assert.ok(inferred.failures.includes("acceptance-criteria-inferred-not-proven"))

  const verified = auditCompletion({
    verification: passingVerification("VERIFIED: refund idempotency test passed"),
    requireIntegration: false,
    requireVisual: false,
    behavioralReceipts: [{ passed: true, exitCode: 0 }],
    requireBehavioralReceipt: true,
  })
  assert.equal(verified.passed, true)
  assert.equal(verified.evidence.claimEvidenceStatus.verified, 1)
})

test("compaction resume guard emits a deterministic instruction epoch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-instruction-epoch-"))
  try {
    const dir = path.join(root, ".ues-work", "demo")
    await json(path.join(dir, "STATE.json"), {
      schemaVersion: 4,
      status: "executing",
      goal: "optimize runtime",
      updatedAt: "2026-09-28T00:00:00.000Z",
      planHash: "plan-1",
      planApproved: true,
      nextAction: "Continue task-1",
      blockers: ["provider flaky"],
      decisions: [{
        at: "2026-09-28T00:00:01.000Z",
        text: "Use bounded retry",
        source: "auto-ruling",
        policy: {
          risk: "low",
          autoResolvable: true,
          decision: { confidence: 0.96 },
        },
      }],
      checkpoint: {
        id: "cp-1",
        currentTaskId: "task-1",
        runId: "run-1",
        workspaceFingerprint: "ws-1",
        nextAction: { type: "continue-task", taskId: "task-1" },
      },
      tasks: {
        "task-1": { status: "completed", attempts: 1, runId: null },
        "task-2": { status: "running", attempts: 1, runId: "run-2" },
      },
    })
    await json(path.join(dir, "PLAN.json"), {
      tasks: [
        { id: "task-1", title: "Patch runtime", dependsOn: [] },
        { id: "task-2", title: "Verify runtime", dependsOn: ["task-1"] },
      ],
    })
    await json(path.join(dir, "EVIDENCE.json"), {
      receipts: [
        { id: "receipt-1", task: "task-1", passed: true, exitCode: 0, command: "node --test" },
      ],
      gateReceipts: [{ id: "gate-1", verdict: "PASS" }],
    })

    const packet = await buildCompactionResumeGuard(root, { reason: "threshold" })
    const epoch = packet.workspaces[0].instructionEpoch
    assert.equal(packet.schemaVersion, 2)
    assert.equal(epoch.objective, "optimize runtime")
    assert.deepEqual(epoch.activeTaskIds, ["task-2"])
    assert.deepEqual(epoch.completedTaskIds, ["task-1"])
    assert.deepEqual(epoch.verification.tasksWithoutPassingReceipt, [])
    assert.equal(epoch.recentDecisions[0].confidence, 0.96)
    assert.match(epoch.epochHash, /^[a-f0-9]{20}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
