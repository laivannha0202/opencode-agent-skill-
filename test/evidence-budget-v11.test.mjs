import test from "node:test"
import assert from "node:assert/strict"
import { bucketLimit, evidenceValueScore, planEvidenceBudget } from "../lib/evidence-budget.mjs"

test("V11 adaptive evidence budget stays bounded and reallocates for visual/browser work", () => {
  const normal = planEvidenceBudget({ contextBudget: 8000, risk: "low" }, { title: "fix helper" })
  const visual = planEvidenceBudget({ contextBudget: 8000, risk: "low" }, { title: "match this screenshot in browser" })
  assert.equal(normal.total, 8000)
  assert.equal(Object.values(normal.buckets).reduce((a, b) => a + b, 0), 8000)
  assert.equal(Object.values(visual.buckets).reduce((a, b) => a + b, 0), 8000)
  assert.ok(visual.buckets.tools > normal.buckets.tools)
  assert.equal(bucketLimit(visual, "tools", 100), 100)
})

test("V11 evidence value score rewards useful evidence per context unit", () => {
  const concise = evidenceValueScore({ relevance: 1, freshness: 1, confidence: 1, chars: 100 })
  const bloated = evidenceValueScore({ relevance: 1, freshness: 1, confidence: 1, chars: 1000 })
  assert.ok(concise > bloated)
})
