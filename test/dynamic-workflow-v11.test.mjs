import test from "node:test"
import assert from "node:assert/strict"
import { classifyWorkflowTask, planDynamicWorkflow } from "../lib/dynamic-workflow.mjs"

test("V11 workflow scheduler keeps deterministic checks out of agent fan-out and serializes write conflicts", () => {
  const tasks = [
    { id: "a", title: "build index", deterministic: true, files: [] },
    { id: "b", title: "edit auth", files: { modify: ["auth.js"] } },
    { id: "c", title: "edit auth tests", files: { modify: ["auth.js"] } },
    { id: "d", title: "visual verify screenshot", dependsOn: ["b"], files: [] },
  ]
  assert.equal(classifyWorkflowTask(tasks[0]).kind, "deterministic")
  assert.equal(classifyWorkflowTask(tasks[3]).kind, "vision")
  const plan = planDynamicWorkflow(tasks, { maxConcurrent: 4 })
  assert.equal(plan.taskCount, 4)
  const first = plan.waves[0].tasks.map((task) => task.id)
  assert.ok(first.includes("a"))
  assert.ok(!(first.includes("b") && first.includes("c")))
  assert.ok(plan.deterministicTaskCount >= 1)
})
