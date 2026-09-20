import test from "node:test"
import assert from "node:assert/strict"
import { computeSafeWaves } from "../lib/task-graph.mjs"

function task(id, files) {
  return {
    id,
    title: id,
    summary: id,
    files,
    dependsOn: [],
    acceptance: ["observable"],
    verification: ["check"],
    risk: "low",
  }
}

test("safe waves allow parallel reads but serialize write-read conflicts", () => {
  const readOnly = {
    schemaVersion: 1,
    goal: "parallel reads",
    tasks: [
      task("A", { read: ["src/shared.js"] }),
      task("B", { read: ["src/shared.js"] }),
    ],
  }
  assert.deepEqual(computeSafeWaves(readOnly).waves, [["A", "B"]])

  const conflict = {
    schemaVersion: 1,
    goal: "write read conflict",
    tasks: [
      task("A", { modify: ["src/shared.js"] }),
      task("B", { read: ["src/shared.js"] }),
    ],
  }
  assert.deepEqual(computeSafeWaves(conflict).waves, [["A"], ["B"]])
})
