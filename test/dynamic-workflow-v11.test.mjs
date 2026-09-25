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


test("V11 workflow scheduler keeps tiny serial LLM work inline instead of spawning needless agents", () => {
  const plan = planDynamicWorkflow([
    { id: "one", title: "Rename one local helper", files: { modify: ["helper.js"] } },
  ])
  assert.equal(plan.agentTaskCount, 0)
  assert.equal(plan.inlineTaskCount, 1)
  assert.equal(plan.waves[0].tasks[0].execution, "inline")
})

test("V11 workflow scheduler bounds vision workers separately from general LLM concurrency", () => {
  const tasks = Array.from({ length: 4 }, (_, index) => ({
    id: "v" + index,
    title: "Visual screenshot fidelity pass " + index,
    acceptance: ["match geometry", "match pixels"],
    verification: ["render screenshot"],
    files: { modify: ["component-" + index + ".tsx"] },
  }))
  const plan = planDynamicWorkflow(tasks, {
    maxConcurrent: 4,
    maxVisionConcurrent: 1,
    minVisionAgentCost: 2,
  })
  assert.equal(plan.visionAgentTaskCount, 4)
  assert.ok(plan.waves.every((wave) => wave.visionAgentSlots <= 1))
})

test("V14.2 structured runtime can disable phantom inline savings", () => {
  const plan = planDynamicWorkflow([
    { id: "one", title: "Rename one local helper", files: { modify: ["helper.js"] } },
  ], { allowInline: false })
  assert.equal(plan.agentTaskCount, 1)
  assert.equal(plan.inlineTaskCount, 0)
  assert.equal(plan.waves[0].tasks[0].execution, "agent")
  assert.equal(plan.estimatedCoordinationSaved, 0)
})
