import test from "node:test"
import assert from "node:assert/strict"

import { extractValidatedPlan } from "../lib/plan-salvage.mjs"

const VALID_PLAN = {
  "schemaVersion": 1,
  "goal": "Fix mobile catalog behavior",
  "tasks": [
    {
      "id": "task-01",
      "title": "Fix catalog",
      "summary": "Adjust mobile catalog behavior.",
      "dependsOn": [],
      "files": {
        "create": [],
        "modify": [
          "apps/mobile/src/catalog.ts"
        ],
        "test": [],
        "delete": [],
        "read": []
      },
      "acceptance": [
        "Catalog behavior matches the requested rule."
      ],
      "verification": [
        "Run the focused catalog test."
      ],
      "verificationCommands": [
        {
          "command": "npm",
          "args": [
            "test",
            "--",
            "catalog"
          ]
        }
      ],
      "risk": "low"
    }
  ]
}

test("V15.10 plan salvage accepts a marked valid graph", () => {
  const output = "UES_PLAN_JSON:\n" + JSON.stringify(VALID_PLAN) + "\nextra prose"
  const result = extractValidatedPlan(output)
  assert.equal(result.validation.valid, true)
  assert.equal(result.source, "marked")
  assert.equal(result.salvaged, false)
  assert.equal(result.plan.tasks[0].id, "task-01")
})

test("V15.10 plan salvage recovers a complete graph before a transport timeout note", () => {
  const output = [
    "analysis complete",
    "UES_PLAN_JSON:",
    JSON.stringify(VALID_PLAN),
    "[UES transport note: UES RPC absolute-hard-timeout]",
  ].join("\n")
  const result = extractValidatedPlan(output)
  assert.equal(result.validation.valid, true)
  assert.equal(result.plan.goal, VALID_PLAN.goal)
})

test("V15.10 plan salvage can recover a fenced valid graph when the marker is missing", () => {
  const fence = String.fromCharCode(96, 96, 96)
  const output = "planner output\n" + fence + "json\n" + JSON.stringify(VALID_PLAN) + "\n" + fence
  const result = extractValidatedPlan(output)
  assert.equal(result.validation.valid, true)
  assert.equal(result.salvaged, true)
  assert.equal(result.source, "fenced")
})

test("V15.10 plan salvage never upgrades an invalid graph into a valid one", () => {
  const invalid = structuredClone(VALID_PLAN)
  invalid.tasks[0].acceptance = []
  const result = extractValidatedPlan("UES_PLAN_JSON:\n" + JSON.stringify(invalid))
  assert.equal(result.validation.valid, false)
  assert.ok(result.validation.errors.length > 0)
})
