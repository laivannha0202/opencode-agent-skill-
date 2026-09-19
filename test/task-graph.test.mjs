import test from "node:test"
import assert from "node:assert/strict"
import { analyzePlan, validatePlan } from "../lib/task-graph.mjs"

function plan() {
  return {
    schemaVersion: 1,
    goal: "Ship a safe checkout change",
    tasks: [
      {
        id: "T1",
        title: "Schema",
        summary: "Add persisted idempotency key",
        files: { modify: ["db/schema.sql"], test: ["test/schema.test.js"] },
        dependsOn: [],
        acceptance: ["Existing rows remain valid"],
        verification: ["npm test -- schema"],
        risk: "high",
      },
      {
        id: "T2",
        title: "Service",
        summary: "Use persisted idempotency key",
        files: { modify: ["src/payment.js"], test: ["test/payment.test.js"] },
        dependsOn: ["T1"],
        acceptance: ["Duplicate key does not charge twice"],
        verification: ["npm test -- payment"],
        risk: "high",
      },
      {
        id: "T3",
        title: "Controller",
        summary: "Return stable retry response",
        files: { modify: ["src/payment.js"], test: ["test/controller.test.js"] },
        dependsOn: ["T1"],
        acceptance: ["Retry response is stable"],
        verification: ["npm test -- controller"],
        risk: "medium",
      },
    ],
  }
}

test("task graph validates dependencies and serializes same-wave file overlap", () => {
  const result = analyzePlan(plan())
  assert.equal(result.valid, true)
  assert.deepEqual(result.topologicalWaves, [["T1"], ["T2", "T3"]])
  assert.deepEqual(result.safeWaves, [["T1"], ["T2"], ["T3"]])
  assert.equal(result.serialized.length, 1)
  assert.equal(result.serialized[0].task, "T3")
})

test("task graph rejects cycles and missing verification", () => {
  const value = plan()
  value.tasks[0].dependsOn = ["T2"]
  value.tasks[0].verification = []
  const result = validatePlan(value)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((item) => item.includes("verification")))
  assert.ok(result.errors.some((item) => item.includes("dependency cycle")))
})


test("safe waves allow shared read-only scope but serialize write/read conflicts", async () => {
  const { computeSafeWaves } = await import("../lib/task-graph.mjs")
  const readOnly = {
    schemaVersion: 1,
    goal: "read sharing",
    tasks: [
      { id: "A", title: "A", summary: "read", files: { read: ["src/shared.js"] }, dependsOn: [], acceptance: ["a"], verification: ["check"], risk: "low" },
      { id: "B", title: "B", summary: "read", files: { read: ["src/shared.js"] }, dependsOn: [], acceptance: ["b"], verification: ["check"], risk: "low" },
    ],
  }
  assert.deepEqual(computeSafeWaves(readOnly).waves[0], ["A", "B"])

  const writeRead = structuredClone(readOnly)
  writeRead.tasks[0].files = { modify: ["src/shared.js"] }
  assert.equal(computeSafeWaves(writeRead).waves[0].length, 1)
})
