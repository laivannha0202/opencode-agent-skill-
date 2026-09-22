import test from "node:test"
import assert from "node:assert/strict"
import { createVerificationReceipt } from "../lib/evidence-receipt.mjs"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  addBlocker,
  approvePlan,
  completeTask,
  createPlanVerificationReceipt,
  createIntegrationVerificationReceipt,
  failTask,
  heartbeatTask,
  finalizeWork,
  importPlan,
  initWork,
  recordIntegrationVerification,
  resolveBlocker,
  resumeWork,
  recoverTask,
  startTask,
  workStatus,
  recordVerificationReceipt,
  workspaceFingerprint,
  checkpointWork,
  markCheckpointResumed,
} from "../lib/task-engine.mjs"

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

const fixturePlan = {
  schemaVersion: 1,
  goal: "Implement two dependent changes",
  tasks: [
    {
      id: "T1",
      title: "Core",
      summary: "Create core behavior",
      files: { modify: ["src/core.js"] },
      dependsOn: [],
      acceptance: ["Core behavior works"],
      verification: ["node --test test/core.test.js"],
      risk: "medium",
    },
    {
      id: "T2",
      title: "Consumer",
      summary: "Update consumer",
      files: { modify: ["src/consumer.js"] },
      dependsOn: ["T1"],
      acceptance: ["Consumer uses core behavior"],
      verification: ["node --test test/consumer.test.js"],
      risk: "medium",
    },
  ],
}

async function importAndApprove(root, slug, plan = fixturePlan) {
  const planFile = path.join(root, "plan.json")
  await writeFile(planFile, JSON.stringify(plan), "utf8")
  await importPlan(root, slug, planFile)
  const receipt = await createPlanVerificationReceipt(root, slug, {
    verifier: "ues-plan-checker",
    evidence: "ues-plan-checker => PASS",
  })
  await approvePlan(root, slug, "ues-plan-checker => PASS", { receipt })
}

async function addPassingReceipt(root, slug, taskID, runId) {
  const fingerprint = workspaceFingerprint(root)
  const receipt = createVerificationReceipt({
    task: taskID,
    runId,
    command: "node",
    args: ["--version"],
    exitCode: 0,
    stdout: "v-test",
    stderr: "",
    workspaceBefore: fingerprint,
    workspaceAfter: fingerprint,
  })
  await recordVerificationReceipt(root, slug, taskID, receipt)
}

test("plan approval is a hard gate before task execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-plan-gate-"))
  try {
    await initWork(root, "plan-gate", fixturePlan.goal)
    const planFile = path.join(root, "plan.json")
    await writeFile(planFile, JSON.stringify(fixturePlan), "utf8")
    await importPlan(root, "plan-gate", planFile)

    const before = await workStatus(root, "plan-gate")
    assert.equal(before.status, "awaiting-plan-approval")
    assert.deepEqual(before.ready, [])
    await assert.rejects(startTask(root, "plan-gate", "T1"), /plan is not approved/)

    const planReceipt = await createPlanVerificationReceipt(root, "plan-gate", {
      verifier: "ues-plan-checker",
      evidence: "plan checker PASS",
    })
    const approved = await approvePlan(root, "plan-gate", "plan checker PASS", { receipt: planReceipt })
    assert.equal(approved.approval.status, "passed")
    assert.deepEqual(approved.ready, ["T1"])

    const started = await startTask(root, "plan-gate", "T1")
    assert.equal(started.record.status, "running")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("persistent work state resumes from dependency-safe boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-work-"))
  try {
    await initWork(root, "checkout-upgrade", fixturePlan.goal)
    await importAndApprove(root, "checkout-upgrade")

    let status = await workStatus(root, "checkout-upgrade")
    assert.deepEqual(status.ready, ["T1"])

    const started = await startTask(root, "checkout-upgrade", "T1")
    assert.equal(started.record.status, "running")
    assert.equal(started.contextPack.task.id, "T1")
    await addPassingReceipt(root, "checkout-upgrade", "T1", started.record.runId)

    await completeTask(root, "checkout-upgrade", "T1", {
      runId: started.record.runId,
      evidence: "node --test test/core.test.js => PASS",
      report: "# T1 report\n\nCore implemented and verified.",
    })

    status = await workStatus(root, "checkout-upgrade")
    assert.deepEqual(status.ready, ["T2"])
    assert.equal(status.counts.completed, 1)

    const startedT2 = await startTask(root, "checkout-upgrade", "T2")
    const failed = await failTask(root, "checkout-upgrade", "T2", "consumer test still fails", {
      runId: startedT2.record.runId,
    })
    assert.equal(failed.attempts, 1)

    const retryT2 = await startTask(root, "checkout-upgrade", "T2")
    assert.equal(retryT2.record.attempts, 2)
    assert.equal(retryT2.contextPack.attempt, 2)
    assert.equal(retryT2.contextPack.contextPolicy.recovery.stage, "diagnose")
    assert.equal(retryT2.contextPack.contextPolicy.recovery.requireDiagnosis, true)
    assert.ok(
      retryT2.contextPack.contextPolicy.effectiveContextBudget >=
      retryT2.contextPack.contextPolicy.profile.contextBudget,
    )
    await failTask(root, "checkout-upgrade", "T2", "retry remains unresolved", {
      runId: retryT2.record.runId,
    })

    const resumed = await resumeWork(root, "checkout-upgrade")
    assert.deepEqual(resumed.status.ready, ["T2"])
    assert.equal(resumed.completedEvidence.length, 1)

    const evidence = JSON.parse(await readFile(path.join(root, ".ues-work", "checkout-upgrade", "EVIDENCE.json"), "utf8"))
    assert.equal(evidence.entries[0].task, "T1")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent independent task completion preserves both state and evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-concurrency-"))
  const plan = {
    schemaVersion: 1,
    goal: "Run independent work safely",
    tasks: [
      {
        id: "A",
        title: "Alpha",
        summary: "Alpha change",
        files: { modify: ["src/a.js"] },
        dependsOn: [],
        acceptance: ["Alpha works"],
        verification: ["test alpha"],
        risk: "medium",
      },
      {
        id: "B",
        title: "Beta",
        summary: "Beta change",
        files: { modify: ["src/b.js"] },
        dependsOn: [],
        acceptance: ["Beta works"],
        verification: ["test beta"],
        risk: "medium",
      },
    ],
  }

  try {
    await initWork(root, "parallel-safe", plan.goal)
    await importAndApprove(root, "parallel-safe", plan)
    const [startedA, startedB] = await Promise.all([
      startTask(root, "parallel-safe", "A"),
      startTask(root, "parallel-safe", "B"),
    ])
    await Promise.all([
      addPassingReceipt(root, "parallel-safe", "A", startedA.record.runId),
      addPassingReceipt(root, "parallel-safe", "B", startedB.record.runId),
    ])
    await Promise.all([
      completeTask(root, "parallel-safe", "A", { evidence: "alpha PASS", runId: startedA.record.runId }),
      completeTask(root, "parallel-safe", "B", { evidence: "beta PASS", runId: startedB.record.runId }),
    ])

    const status = await workStatus(root, "parallel-safe")
    assert.equal(status.counts.completed, 2)
    assert.equal(status.status, "integration-verification")

    const evidence = JSON.parse(await readFile(path.join(root, ".ues-work", "parallel-safe", "EVIDENCE.json"), "utf8"))
    assert.deepEqual(new Set(evidence.entries.map((item) => item.task)), new Set(["A", "B"]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("work completion requires fresh evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-evidence-"))
  try {
    await initWork(root, "evidence-gate", "Evidence gate")
    const plan = {
      ...fixturePlan,
      goal: "Evidence gate",
      tasks: [fixturePlan.tasks[0]],
    }
    await importAndApprove(root, "evidence-gate", plan)
    const started = await startTask(root, "evidence-gate", "T1")
    await assert.rejects(
      completeTask(root, "evidence-gate", "T1", { runId: started.record.runId, evidence: "" }),
      /fresh evidence/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("finalization requires recorded integration PASS and unchanged workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-finalize-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "core.js"), "export const value = 1\n", "utf8")
    assert.equal(spawnSync("git", ["init"], { cwd: root }).status, 0)
    assert.equal(spawnSync("git", ["add", "."], { cwd: root }).status, 0)
    assert.equal(
      spawnSync("git", ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "fixture"], { cwd: root }).status,
      0,
    )

    await initWork(root, "finalize-gate", "Finalize gate")
    const plan = {
      ...fixturePlan,
      goal: "Finalize gate",
      tasks: [fixturePlan.tasks[0]],
    }
    await importAndApprove(root, "finalize-gate", plan)

    const started = await startTask(root, "finalize-gate", "T1")
    await completeTask(root, "finalize-gate", "T1", {
      runId: started.record.runId,
      evidence: "unit test passed",
    })

    await assert.rejects(
      finalizeWork(root, "finalize-gate", "integration passed"),
      /recorded integration PASS/,
    )

    await addBlocker(root, "finalize-gate", "manual environment unavailable")
    await assert.rejects(
      recordIntegrationVerification(root, "finalize-gate", "PASS", "integration passed"),
      /blockers remain/,
    )
    await resolveBlocker(root, "finalize-gate", "manual environment unavailable")

    const verification = await recordIntegrationVerification(
      root,
      "finalize-gate",
      "PASS",
      "end-to-end verifier => PASS",
    )
    assert.equal(verification.status, "PASS")

    await writeFile(path.join(root, "src", "core.js"), "export const value = 2\n", "utf8")
    await assert.rejects(
      finalizeWork(root, "finalize-gate", "final integration evidence"),
      /workspace changed after integration PASS/,
    )

    await recordIntegrationVerification(
      root,
      "finalize-gate",
      "PASS",
      "end-to-end verifier rerun => PASS",
    )
    const finalized = await finalizeWork(root, "finalize-gate", "final acceptance verified")
    assert.equal(finalized.state.status, "completed")
    assert.equal(finalized.evidence.task, "__integration__")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("strict completion rejects a stale workspace receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-task-stale-receipt-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "core.js"), "export const x = 1\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    await initWork(root, "stale-receipt", fixturePlan.goal)
    await importAndApprove(root, "stale-receipt", fixturePlan)
    const started = await startTask(root, "stale-receipt", "T1")
    await addPassingReceipt(root, "stale-receipt", "T1", started.record.runId)

    await writeFile(path.join(root, "src", "core.js"), "export const x = 2\n")

    await assert.rejects(
      completeTask(root, "stale-receipt", "T1", {
        runId: started.record.runId,
        evidence: "stale receipt should not pass",
      }),
      /current workspace fingerprint/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("strict multi-task plan requires structured approval receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-plan-structured-"))
  try {
    await initWork(root, "structured-plan", fixturePlan.goal)
    await importPlan(root, "structured-plan", fixturePlan)
    await assert.rejects(
      approvePlan(root, "structured-plan", "plain text PASS"),
      /structured plan-verification receipt/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("strict integration PASS requires a receipt bound to current workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-integration-structured-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.js"), "export const a = 1\n")
    await writeFile(path.join(root, "src", "b.js"), "export const b = 1\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const plan = {
      schemaVersion: 1,
      goal: "Strict integration",
      tasks: [
        { ...fixturePlan.tasks[0], id: "A", files: { modify: ["src/a.js"] }, dependsOn: [] },
        { ...fixturePlan.tasks[1], id: "B", files: { modify: ["src/b.js"] }, dependsOn: ["A"] },
      ],
    }
    await initWork(root, "structured-integration", plan.goal)
    await importAndApprove(root, "structured-integration", plan)

    const startedA = await startTask(root, "structured-integration", "A")
    await addPassingReceipt(root, "structured-integration", "A", startedA.record.runId)
    await completeTask(root, "structured-integration", "A", {
      runId: startedA.record.runId,
      evidence: "A verified",
    })

    const startedB = await startTask(root, "structured-integration", "B")
    await addPassingReceipt(root, "structured-integration", "B", startedB.record.runId)
    await completeTask(root, "structured-integration", "B", {
      runId: startedB.record.runId,
      evidence: "B verified",
    })

    await assert.rejects(
      recordIntegrationVerification(root, "structured-integration", "PASS", "plain PASS"),
      /structured integration-verification receipt/,
    )

    const receipt = await createIntegrationVerificationReceipt(root, "structured-integration", {
      verifier: "ues-integration-verifier",
      verdict: "PASS",
      evidence: "integration PASS",
    })
    const verified = await recordIntegrationVerification(
      root,
      "structured-integration",
      "PASS",
      "integration PASS",
      null,
      { receipt },
    )
    assert.equal(verified.status, "PASS")
    assert.equal(verified.receipt.id, receipt.id)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("task-scoped recovery preserves previous executor ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-recover-task-"))
  try {
    const plan = { ...fixturePlan, tasks: [fixturePlan.tasks[0]] }
    await initWork(root, "recover-one", plan.goal)
    await importAndApprove(root, "recover-one", plan)
    const started = await startTask(root, "recover-one", "T1", { leaseMs: 30_000, sessionID: "session-old" })

    await assert.rejects(
      recoverTask(root, "recover-one", "T1"),
      /lease is still active/,
    )

    const recovered = await recoverTask(root, "recover-one", "T1", {
      force: true,
      reason: "manual stale recovery",
    })
    assert.deepEqual(recovered.recovered, ["T1"])
    assert.equal(recovered.previousRunId, started.record.runId)
    assert.equal(recovered.previousOwner.sessionID, "session-old")

    const status = await workStatus(root, "recover-one")
    assert.equal(status.counts.retryable, 1)
    assert.equal(status.counts.failed, 0)
    assert.deepEqual(status.ready, ["T1"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("non-git workspace fingerprint tracks source changes but ignores UES runtime state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-nongit-fingerprint-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "value.txt"), "one\n")
    const first = workspaceFingerprint(root)

    await mkdir(path.join(root, ".ues-work", "demo"), { recursive: true })
    await writeFile(path.join(root, ".ues-work", "demo", "STATE.json"), "{\"status\":\"running\"}\n")
    await mkdir(path.join(root, ".ues-cache"), { recursive: true })
    await writeFile(path.join(root, ".ues-cache", "semantic-index-v1.json"), "{}\n")
    await mkdir(path.join(root, ".ues-traces"), { recursive: true })
    await writeFile(path.join(root, ".ues-traces", "run.jsonl"), "{\"type\":\"tool.call\"}\n")
    assert.equal(workspaceFingerprint(root), first)

    await writeFile(path.join(root, "src", "value.txt"), "two\n")
    assert.notEqual(workspaceFingerprint(root), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("active task mutations require the current runId", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-run-fence-required-"))
  try {
    const plan = { ...fixturePlan, tasks: [fixturePlan.tasks[0]] }
    await initWork(root, "run-fence-required", plan.goal)
    await importAndApprove(root, "run-fence-required", plan)
    const started = await startTask(root, "run-fence-required", "T1")

    await assert.rejects(
      heartbeatTask(root, "run-fence-required", "T1", null),
      /requires the active runId/,
    )
    await assert.rejects(
      failTask(root, "run-fence-required", "T1", "stale caller"),
      /requires the active runId/,
    )
    await assert.rejects(
      completeTask(root, "run-fence-required", "T1", { evidence: "stale caller" }),
      /requires the active runId/,
    )

    await failTask(root, "run-fence-required", "T1", "current caller", {
      runId: started.record.runId,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("stale executor cannot fail a recovered inactive task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-stale-fail-fence-"))
  try {
    const plan = { ...fixturePlan, tasks: [fixturePlan.tasks[0]] }
    await initWork(root, "stale-fail-fence", plan.goal)
    await importAndApprove(root, "stale-fail-fence", plan)
    const started = await startTask(root, "stale-fail-fence", "T1")
    await recoverTask(root, "stale-fail-fence", "T1", { force: true })

    await assert.rejects(
      failTask(root, "stale-fail-fence", "T1", "late stale failure", {
        runId: started.record.runId,
      }),
      /must be running/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("compaction checkpoint persists task identity plan hash evidence pointers and deterministic next action", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-checkpoint-"))
  try {
    const plan = { ...fixturePlan, tasks: [fixturePlan.tasks[0]] }
    await initWork(root, "checkpoint-work", plan.goal)
    await importAndApprove(root, "checkpoint-work", plan)
    const started = await startTask(root, "checkpoint-work", "T1")

    const checkpoint = await checkpointWork(root, "checkpoint-work", {
      taskID: "T1",
      runId: started.record.runId,
      reason: "pre-compaction",
    })
    assert.equal(checkpoint.currentTaskId, "T1")
    assert.equal(checkpoint.runId, started.record.runId)
    assert.ok(checkpoint.planHash)
    assert.ok(checkpoint.workspaceFingerprint)
    assert.equal(checkpoint.nextAction.type, "continue-task")
    assert.equal(checkpoint.nextAction.taskId, "T1")
    assert.equal(checkpoint.resumedAt, null)

    const status = await workStatus(root, "checkpoint-work")
    assert.equal(status.checkpoint.currentTaskId, "T1")
    assert.equal(status.checkpoint.nextAction.type, "continue-task")

    const resumed = await markCheckpointResumed(root, "checkpoint-work", {
      taskID: "T1",
      runId: started.record.runId,
      reason: "tool-action-observed",
    })
    assert.ok(resumed.resumedAt)
    assert.equal(resumed.resumeReason, "tool-action-observed")

    await failTask(root, "checkpoint-work", "T1", "fixture cleanup", {
      runId: started.record.runId,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("stale lease recovery exposes retryable instead of terminal failed state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-retryable-"))
  try {
    const plan = { ...fixturePlan, tasks: [fixturePlan.tasks[0]] }
    await initWork(root, "retryable-work", plan.goal)
    await importAndApprove(root, "retryable-work", plan)
    await startTask(root, "retryable-work", "T1", { leaseMs: 30_000 })
    await recoverTask(root, "retryable-work", "T1", { force: true })

    const status = await workStatus(root, "retryable-work")
    assert.equal(status.counts.retryable, 1)
    assert.equal(status.counts.failed, 0)
    assert.deepEqual(status.ready, ["T1"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("V11 task context pack externalizes oversized declared evidence instead of replaying it inline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-context-pack-v11-"))
  const plan = {
    schemaVersion: 1,
    goal: "Bound large context",
    tasks: [{
      id: "BIG",
      title: "Fix large feature",
      summary: "Update the declared implementation with bounded evidence.",
      files: { modify: ["src/large.js"] },
      dependsOn: [],
      acceptance: ["Large feature remains correct"],
      verification: ["node --check src/large.js"],
      risk: "low",
    }],
  }

  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "large.js"), "export const large = 1\n" + "x".repeat(12000))
    await initWork(root, "bounded-context", plan.goal)
    await importAndApprove(root, "bounded-context", plan)

    const started = await startTask(root, "bounded-context", "BIG")
    const pack = started.contextPack
    assert.ok(pack.contextManifest)
    assert.equal(pack.contextManifest.schemaVersion >= 5, true)
    assert.equal(pack.evidenceStore.refs >= 1, true)
    assert.equal(pack.evidencePointers.context.length >= 1, true)
    const externalized = pack.contextManifest.excerpts.find((item) => item.externalized)
    assert.ok(externalized)
    assert.match(externalized.text, /evidence:sha256:/)
    assert.ok(externalized.text.length < externalized.originalChars)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
