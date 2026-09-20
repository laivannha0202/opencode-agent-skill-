import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  approvePlan,
  completeTask,
  heartbeatTask,
  importPlan,
  initWork,
  recordVerificationReceipt,
  recoverStaleTasks,
  startTask,
  workStatus,
} from "../lib/task-engine.mjs"
import { createVerificationReceipt } from "../lib/evidence-receipt.mjs"

const plan = {
  schemaVersion: 1,
  goal: "Exercise V7 runtime state",
  tasks: [{
    id: "T1",
    title: "One",
    summary: "One task",
    files: { modify: ["src/a.js"] },
    dependsOn: [],
    acceptance: ["works"],
    verification: ["node --test"],
    risk: "medium",
  }],
}

async function setup(root, slug) {
  await initWork(root, slug, plan.goal)
  const file = path.join(root, "plan.json")
  await writeFile(file, JSON.stringify(plan), "utf8")
  await importPlan(root, slug, file)
  await approvePlan(root, slug, "plan checker PASS")
}

test("V7 task lease heartbeat is fenced by runId and stale work can recover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v7-lease-"))
  try {
    await setup(root, "lease-test")
    const started = await startTask(root, "lease-test", "T1")
    assert.ok(started.record.runId)
    const beat = await heartbeatTask(root, "lease-test", "T1", started.record.runId)
    assert.equal(beat.runId, started.record.runId)
    await assert.rejects(
      heartbeatTask(root, "lease-test", "T1", "wrong-run"),
      /fence mismatch/,
    )
    const recovered = await recoverStaleTasks(root, "lease-test", { force: true })
    assert.deepEqual(recovered.recovered, ["T1"])
    assert.deepEqual((await workStatus(root, "lease-test")).ready, ["T1"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("structured verification receipt strengthens task completion evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v7-receipt-"))
  try {
    await setup(root, "receipt-test")
    const started = await startTask(root, "receipt-test", "T1")
    const receipt = createVerificationReceipt({
      task: "T1",
      runId: started.record.runId,
      command: "node",
      args: ["--test"],
      exitCode: 0,
      stdout: "pass",
      stderr: "",
    })
    await recordVerificationReceipt(root, "receipt-test", "T1", receipt)
    const completed = await completeTask(root, "receipt-test", "T1", {
      runId: started.record.runId,
      evidence: "node --test => PASS",
    })
    assert.equal(completed.state.tasks.T1.evidenceStrength, "receipt-backed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
