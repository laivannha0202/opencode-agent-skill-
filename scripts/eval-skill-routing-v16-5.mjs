// V16.5 Phase 13: deterministic routing-matrix check for the Adaptive Skill Router V3.
// Usage: node scripts/eval-skill-routing-v16-5.mjs
// Reads only evals/v16.5-routing-matrix.json. No model, no network, no live provider.
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { routeSkills } from "../lib/skill-router.mjs"
import { skillRegistry } from "../lib/skill-registry.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const matrix = JSON.parse(readFileSync(path.join(root, "evals", "v16.5-routing-matrix.json"), "utf8"))
const DEFAULT_MAX_ACTIVATED = 3
const rows = []

for (const testCase of matrix.cases) {
  const result = routeSkills({ task: testCase.task })
  const activated = new Set(result.activated)
  const missing = (testCase.expect || []).filter((id) => !activated.has(id))
  const rejected = (testCase.reject || []).filter((id) => activated.has(id))
  const maxActivated = Number(testCase.maxActivated || DEFAULT_MAX_ACTIVATED)
  const overBudget = result.activated.length > maxActivated
  const languageOk = testCase.language ? result.language === testCase.language : true
  const ambiguousOk = testCase.ambiguous ? result.ambiguous === true : true
  const confidenceOk = testCase.ambiguous ? result.confidence === "none" : result.confidence !== "none"
  const pass = !missing.length && !rejected.length && !overBudget && languageOk && ambiguousOk && confidenceOk
  rows.push({
    id: testCase.id,
    pass,
    task: testCase.task,
    activated: result.activated,
    missing,
    rejected,
    overBudget,
    maxActivated,
    language: result.language,
    ambiguous: result.ambiguous,
    confidence: result.confidence,
    cutoff: result.scoreCutoff,
    consideredPositive: result.consideredPositive,
    activationRatio: result.activationRatio,
    expandedReason: result.expandedReason,
  })
}

const passed = rows.filter((row) => row.pass).length
const summary = {
  schemaVersion: 1,
  release: "v16.5",
  deterministic: true,
  registrySkills: skillRegistry().contracts.length,
  cases: rows.length,
  passed,
  failed: rows.length - passed,
  pass: passed === rows.length,
  averageActivated: Number((rows.reduce((sum, row) => sum + row.activated.length, 0) / Math.max(1, rows.length)).toFixed(3)),
  maxActivatedObserved: rows.reduce((max, row) => Math.max(max, row.activated.length), 0),
  consideredPositiveAverage: Number((rows.reduce((sum, row) => sum + row.consideredPositive, 0) / Math.max(1, rows.length)).toFixed(3)),
  rows,
}
console.log(JSON.stringify(summary, null, 2))
if (!summary.pass) process.exitCode = 1
