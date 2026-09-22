import test from "node:test"
import assert from "node:assert/strict"
import { designTokenEvidence, extractDesignTokens, inspectResponsiveLayout } from "../lib/ui-inspector.mjs"

test("V11 design token extractor returns compact CSS evidence", () => {
  const css = `
:root { --space-2: 8px; --brand: #0a7f42; --radius-card: 12px; }
.card { padding: 16px; border-radius: 12px; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,.15); color: #0a7f42; }
`
  const tokens = extractDesignTokens(css)
  assert.equal(tokens.variables["--space-2"], "8px")
  assert.ok(tokens.colors.includes("#0a7f42"))
  assert.ok(tokens.spacingCandidates.includes(8))
  assert.ok(tokens.radii.includes("12px"))
  const evidence = designTokenEvidence(tokens)
  assert.ok(evidence.summary.variables.length >= 1)
})

test("V11 responsive inspector detects overflow, touch targets and real sibling overlap", () => {
  const result = inspectResponsiveLayout([
    { id: "container", x: 0, y: 0, width: 300, height: 300 },
    { id: "inside", x: 20, y: 20, width: 100, height: 100 },
    { id: "a", x: 100, y: 100, width: 100, height: 80 },
    { id: "b", x: 150, y: 120, width: 100, height: 80 },
    { id: "tiny", role: "button", x: 10, y: 320, width: 20, height: 20 },
  ], { width: 300, height: 340 })
  assert.equal(result.verdict, "FAIL")
  assert.ok(result.issues.some((issue) => issue.kind === "small-touch-target" && issue.id === "tiny"))
  assert.ok(result.issues.some((issue) => issue.kind === "element-overlap" && issue.a === "a" && issue.b === "b"))
  assert.equal(result.issues.some((issue) => issue.kind === "element-overlap" && issue.a === "container"), false)
})

test("V11 responsive inspector passes bounded non-overlapping boxes", () => {
  const result = inspectResponsiveLayout([
    { id: "title", x: 10, y: 10, width: 200, height: 40 },
    { id: "cta", role: "button", x: 10, y: 80, width: 120, height: 48 },
  ], { width: 390, height: 844 })
  assert.equal(result.verdict, "PASS")
  assert.deepEqual(result.issues, [])
})
