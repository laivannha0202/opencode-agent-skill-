import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { approvePlan, importPlan, initWork, startTask, workPaths, workStatus } from "../lib/task-engine.mjs"

test("V12 task engine fences execution to the active plan snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-task-plan-scope-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.js"), "export const a = 1\n")
    const plan = {
      schemaVersion: 1,
      goal: "Verify active plan fencing",
      tasks: [{
        id: "T1",
        title: "Scoped task",
        summary: "Modify one file under the active plan identity.",
        files: { modify: ["src/a.js"] },
        dependsOn: [],
        acceptance: ["The scoped task remains traceable to its active plan."],
        verification: ["node --check src/a.js"],
        risk: "low",
      }],
    }
    await initWork(root, "plan-scope", plan.goal)
    const imported = await importPlan(root, "plan-scope", plan)
    await approvePlan(root, "plan-scope", "plan reviewed")
    const status = await workStatus(root, "plan-scope")
    assert.equal(status.planScope.planHash, imported.state.planHash)

    const paths = workPaths(root, "plan-scope")
    const active = JSON.parse(await readFile(paths.activePlan, "utf8"))
    await writeFile(paths.activePlan, JSON.stringify({ ...active, planHash: "b".repeat(64) }, null, 2) + "\n")
    await assert.rejects(startTask(root, "plan-scope", "T1"), /scope mismatch/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
