import test from "node:test"
import assert from "node:assert/strict"
import { adaptiveWorkerCount, parallelRootBaseline, runEventDrivenDAG } from "../global-config/plugins/ues-router/parallel-runtime.js"
import { taskVerificationCommands, validatePlan } from "../lib/task-graph.mjs"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("event DAG starts a dependent task after its dependency integrates without waiting for unrelated work", async () => {
  const timeline = []
  const tasks = [
    { id: "A", dependsOn: [], files: { modify: ["src/a.js"] } },
    { id: "B", dependsOn: [], files: { modify: ["src/b.js"] } },
    { id: "C", dependsOn: ["A"], files: { modify: ["src/c.js"] } },
  ]
  const result = await runEventDrivenDAG(tasks, {
    maxConcurrent: 2,
    model: "provider/weak",
    worker: async (task, context) => {
      timeline.push(["start", task.id, Date.now(), context.model])
      await sleep(task.id === "A" ? 20 : task.id === "B" ? 100 : 10)
      timeline.push(["worker-done", task.id, Date.now()])
      return { id: task.id }
    },
    integrate: async (task) => {
      await sleep(5)
      timeline.push(["integrated", task.id, Date.now()])
      return { ok: true }
    },
  })
  assert.deepEqual(result.failed, {})
  assert.deepEqual(result.blocked, {})
  assert.equal(result.singleModel, true)
  const cStart = timeline.find((item) => item[0] === "start" && item[1] === "C")
  const bDone = timeline.find((item) => item[0] === "worker-done" && item[1] === "B")
  assert.ok(cStart[2] < bDone[2], "C should start without waiting for B")
  assert.equal(timeline.filter((item) => item[0] === "start").every((item) => item[3] === "provider/weak"), true)
})

test("resource leases serialize overlapping writers", async () => {
  let active = 0
  let maxActive = 0
  const tasks = [
    { id: "A", dependsOn: [], files: { modify: ["src/shared.js"] } },
    { id: "B", dependsOn: [], files: { modify: ["src/shared.js"] } },
  ]
  const result = await runEventDrivenDAG(tasks, {
    maxConcurrent: 2,
    worker: async (task) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(20)
      active -= 1
      return task.id
    },
  })
  assert.equal(maxActive, 1)
  assert.equal(result.completed.length, 2)
  assert.ok(result.conflictDeferrals > 0)
})


test("adaptive worker pool shrinks after repeated failures or conflict pressure", () => {
  assert.equal(adaptiveWorkerCount({ requested: 8, readyCount: 8 }), 8)
  assert.equal(adaptiveWorkerCount({ requested: 8, readyCount: 8, recentFailures: 2 }), 4)
  assert.equal(adaptiveWorkerCount({ requested: 8, readyCount: 8, conflictRate: 0.5 }), 4)
  assert.equal(adaptiveWorkerCount({ requested: 8, readyCount: 8, recentFailures: 2, conflictRate: 0.5 }), 2)
})

test("parallel root baseline accepts inherited dirty work while rejecting non-git roots", () => {
  assert.deepEqual(
    parallelRootBaseline({
      git: true,
      head: "abc123",
      branch: "main",
      clean: false,
      changes: [" M src/existing.js", "?? notes.txt"],
    }),
    {
      head: "abc123",
      branch: "main",
      clean: false,
      inheritedDirtyRoot: true,
      changes: [" M src/existing.js", "?? notes.txt"],
    },
  )
  assert.throws(
    () => parallelRootBaseline({ git: false }),
    /requires a Git repository/,
  )
})

test("shared configuration writer serializes against otherwise independent writers", async () => {
  let active = 0
  let maxActive = 0
  const tasks = [
    { id: "config", dependsOn: [], files: { modify: ["package.json"] } },
    { id: "feature", dependsOn: [], files: { modify: ["src/feature.js"] } },
  ]
  await runEventDrivenDAG(tasks, {
    maxConcurrent: 2,
    worker: async (task) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(15)
      active -= 1
      return task.id
    },
  })
  assert.equal(maxActive, 1)
})


test("structured verification commands are validated and normalized for deterministic receipts", () => {
  const plan = {
    schemaVersion: 1,
    goal: "verify parallel task",
    tasks: [{
      id: "T1",
      title: "Task",
      summary: "Do one bounded change",
      dependsOn: [],
      files: { modify: ["src/a.js"] },
      acceptance: ["behavior is correct"],
      verification: ["run focused unit tests"],
      verificationCommands: [{ command: "node", args: ["--test", "test/a.test.mjs"] }],
      risk: "medium",
    }],
  }
  assert.equal(validatePlan(plan).valid, true)
  assert.deepEqual(taskVerificationCommands(plan.tasks[0]), [
    { command: "node", args: ["--test", "test/a.test.mjs"] },
  ])
  plan.tasks[0].verificationCommands = [{ command: "", args: "not-an-array" }]
  assert.equal(validatePlan(plan).valid, false)
})
