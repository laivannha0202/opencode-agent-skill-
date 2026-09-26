import test from "node:test"
import assert from "node:assert/strict"
import { analyzePlan, normalizePlanForValidation, validatePlan } from "../lib/task-graph.mjs"

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


test("task graph normalizes common weak-model plan aliases without inventing evidence", () => {
  const raw = {
    schemaVersion: 1,
    goal: "Clean demo data safely",
    tasks: [
      {
        id: "task-01",
        title: "Cleanup",
        summary: "Remove fixture rows",
        dependsOn: [],
        files: { modify: ["apps/api/src/seed.ts"], read: ["apps/api/prisma/schema.prisma"] },
        acceptanceCriteria: [{ criterion: "Fixture rows are absent while canonical rows remain" }],
        verificationChecks: [{ check: "Run targeted cleanup test and inspect resulting catalog" }],
        risk: "Cascade FK constraints if child entities are not unlinked first.",
      },
    ],
  }

  const normalized = normalizePlanForValidation(raw)
  assert.deepEqual(normalized.tasks[0].acceptance, ["Fixture rows are absent while canonical rows remain"])
  assert.deepEqual(normalized.tasks[0].verification, ["Run targeted cleanup test and inspect resulting catalog"])
  assert.equal(normalized.tasks[0].risk, "high")
  assert.match(normalized.tasks[0].riskNotes, /Cascade FK constraints/)
  assert.equal(validatePlan(normalized).valid, true)
})

test("task graph normalizer stays fail-closed when acceptance and verification are genuinely absent", () => {
  const raw = {
    schemaVersion: 1,
    goal: "Do work",
    tasks: [
      {
        id: "task-01",
        title: "Work",
        summary: "No evidence fields",
        dependsOn: [],
        files: { modify: ["src/a.js"] },
        risk: "low",
      },
    ],
  }
  const normalized = normalizePlanForValidation(raw)
  const result = validatePlan(normalized)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((item) => item.includes("acceptance")))
  assert.ok(result.errors.some((item) => item.includes("verification")))
})
