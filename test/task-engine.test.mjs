import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  addBlocker,
  completeTask,
  failTask,
  finalizeWork,
  importPlan,
  initWork,
  resolveBlocker,
  resumeWork,
  startTask,
  workStatus,
} from "../lib/task-engine.mjs"

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

test("persistent work state resumes from dependency-safe boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-work-"))
  try {
    await initWork(root, "checkout-upgrade", "Implement two dependent changes")
    const planFile = path.join(root, "plan.json")
    await writeFile(planFile, JSON.stringify(fixturePlan), "utf8")
    await importPlan(root, "checkout-upgrade", planFile)

    let status = await workStatus(root, "checkout-upgrade")
    assert.deepEqual(status.ready, ["T1"])

    const started = await startTask(root, "checkout-upgrade", "T1")
    assert.equal(started.record.status, "running")
    assert.equal(started.contextPack.task.id, "T1")

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

test("work completion requires fresh evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-evidence-"))
  try {
    await initWork(root, "evidence-gate", "Evidence gate")
    const plan = {
      ...fixturePlan,
      goal: "Evidence gate",
      tasks: [fixturePlan.tasks[0]],
    }
    const planFile = path.join(root, "plan.json")
    await writeFile(planFile, JSON.stringify(plan), "utf8")
    await importPlan(root, "evidence-gate", planFile)
    await startTask(root, "evidence-gate", "T1")
    await assert.rejects(
      completeTask(root, "evidence-gate", "T1", { evidence: "" }),
      /fresh evidence/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("work finalization requires every task, no blockers, and fresh integration evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-finalize-"))
  try {
    await initWork(root, "finalize-gate", "Finalize gate")
    const plan = {
      ...fixturePlan,
      goal: "Finalize gate",
      tasks: [fixturePlan.tasks[0]],
    }
    const planFile = path.join(root, "plan.json")
    await writeFile(planFile, JSON.stringify(plan), "utf8")
    await importPlan(root, "finalize-gate", planFile)

    await assert.rejects(
      finalizeWork(root, "finalize-gate", "integration passed"),
      /incomplete tasks/,
    )

    await startTask(root, "finalize-gate", "T1")
    await completeTask(root, "finalize-gate", "T1", {
      evidence: "unit test passed",
    })

    await addBlocker(root, "finalize-gate", "manual integration environment unavailable")
    await assert.rejects(
      finalizeWork(root, "finalize-gate", "integration passed"),
      /blockers remain/,
    )
    await resolveBlocker(root, "finalize-gate", "manual integration environment unavailable")

    await assert.rejects(
      finalizeWork(root, "finalize-gate", ""),
      /fresh integration evidence/,
    )

    const finalized = await finalizeWork(root, "finalize-gate", "end-to-end verification passed")
    assert.equal(finalized.state.status, "completed")
    assert.equal(finalized.evidence.task, "__integration__")

    const status = await workStatus(root, "finalize-gate")
    assert.equal(status.status, "completed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

