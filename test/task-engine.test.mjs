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
      evidence: "node --test test/core.test.js => PASS",
      report: "# T1 report\n\nCore implemented and verified.",
    })

    status = await workStatus(root, "checkout-upgrade")
    assert.deepEqual(status.ready, ["T2"])
    assert.equal(status.counts.completed, 1)

    await startTask(root, "checkout-upgrade", "T2")
    const failed = await failTask(root, "checkout-upgrade", "T2", "consumer test still fails")
    assert.equal(failed.attempts, 1)

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
    await startTask(root, "evidence-gate", "T1")
    await assert.rejects(
      completeTask(root, "evidence-gate", "T1", { evidence: "" }),
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

    await startTask(root, "finalize-gate", "T1")
    await completeTask(root, "finalize-gate", "T1", { evidence: "unit test passed" })

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
    assert.equal(status.counts.failed, 1)
    assert.deepEqual(status.ready, ["T1"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
