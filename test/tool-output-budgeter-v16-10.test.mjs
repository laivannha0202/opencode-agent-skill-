// V16.10 Tool Output Budgeter: behavior tests.
//
// These test BEHAVIOR, not strings: a bounded view must be honest about what it
// hid, a search must route rather than dump, a passing suite must collapse, and
// a reduced conversation must never contain an orphan tool result.

import test from "node:test"
import assert from "node:assert/strict"
import {
  TOOL_OUTPUT_BUDGETER_POLICY,
  TOOL_OUTPUT_STRATEGY,
  shapeToolOutput,
  resolveStrategy,
  omissionNotice,
  assertToolPairIntegrity,
  DEFAULT_READ_WINDOW_LINES,
} from "../lib/tool-output-budgeter-v16-10.mjs"

const HANDLE = "evidence:sha256:" + "a".repeat(64)

function bigSource(lines = 600) {
  return Array.from({ length: lines }, (_, index) => `line ${index + 1}: const value${index} = ${index}`).join("\n")
}

test("V16.10 budgeter: routing is deterministic and model-independent", () => {
  assert.equal(resolveStrategy("read", ""), TOOL_OUTPUT_STRATEGY.READ_FILE)
  assert.equal(resolveStrategy("ues_code", "", { strategy: undefined }), TOOL_OUTPUT_STRATEGY.GENERIC)
  assert.equal(resolveStrategy("grep", ""), TOOL_OUTPUT_STRATEGY.SEARCH)
  assert.equal(resolveStrategy("bash", "not ok 1 - x\n# tests 1\n# fail 1"), TOOL_OUTPUT_STRATEGY.TEST)
  assert.equal(resolveStrategy("bash", "diff --git a/x b/x\n@@ -1 +1 @@"), TOOL_OUTPUT_STRATEGY.DIFF)
  // An unknown tool with an unknown shape is generic, never guessed.
  assert.equal(resolveStrategy("mystery-tool", "hello"), TOOL_OUTPUT_STRATEGY.GENERIC)
})

test("V16.10 budgeter: a complete read is returned untouched and marked complete", () => {
  const text = bigSource(40)
  const out = shapeToolOutput("read", text, { maxLines: DEFAULT_READ_WINDOW_LINES })
  assert.equal(out.truncated, false)
  assert.equal(out.text, text)
  assert.equal(out.omittedChars, 0)
  assert.equal(out.receipt.honest, true)
  assert.equal(out.receipt.expansionAvailable, false)
})

test("V16.10 budgeter: a huge read is bounded, honest, and expandable", () => {
  const text = bigSource(2000)
  const out = shapeToolOutput("read", text, { handle: HANDLE, maxLines: 120 })
  assert.equal(out.strategy, TOOL_OUTPUT_STRATEGY.READ_FILE)
  assert.equal(out.truncated, true)
  assert.ok(out.visibleChars < out.originalChars)
  // The omission notice must name original/visible/omitted and the handle.
  assert.match(out.text, /original=\d+ visible=\d+ omitted=\d+/)
  assert.match(out.text, /retrieve=evidence:sha256:/)
  assert.equal(out.receipt.omittedChars, out.originalChars - out.visibleChars + out.receipt.noticeOverheadChars)
  assert.ok(out.receipt.omittedChars > 0)
  assert.equal(out.receipt.expansionAvailable, true)
  // Head AND tail must both survive: the API lives at the top, the closing
  // logic at the bottom, and a blind prefix cut would drop one of them.
  assert.match(out.text, /line 1:/)
  assert.match(out.text, /line 2000:/)
})

test("V16.10 budgeter: an exact symbol range wins over head/tail", () => {
  const text = bigSource(1000)
  const out = shapeToolOutput("read", text, {
    symbolRange: { startLine: 500, endLine: 512 },
    handle: HANDLE,
  })
  assert.equal(out.shownLines.start, 494)
  assert.equal(out.shownLines.end, 518)
  assert.match(out.text, /line 500:/)
  assert.doesNotMatch(out.text, /line 1:/)
})

test("V16.10 budgeter: search routes rows, never dumps every match body", () => {
  const rows = Array.from({ length: 200 }, (_, index) => `src/mod${index}.ts:${index + 1}:12:export const handler${index} = () => {}`)
  const out = shapeToolOutput("grep", rows.join("\n"), { handle: HANDLE, maxResults: 30 })
  assert.equal(out.strategy, TOOL_OUTPUT_STRATEGY.SEARCH)
  assert.equal(out.totalRows, 200)
  assert.equal(out.rows.length, 30)
  assert.equal(out.truncated, true)
  assert.match(out.text, /search rows: total=200 shown=30 omitted=170/)
  assert.match(out.text, /src\/mod0\.ts:1:12:/)
})

test("V16.10 budgeter: a large passing suite collapses to a count summary", () => {
  const lines = Array.from({ length: 5000 }, (_, index) => `ok ${index + 1} - test number ${index + 1}`)
  lines.push("# tests 5000", "# pass 5000", "# fail 0")
  const out = shapeToolOutput("bash", lines.join("\n"), { command: "npm test", handle: HANDLE })
  assert.equal(out.strategy, TOOL_OUTPUT_STRATEGY.TEST)
  assert.equal(out.summary.passed, 5000)
  assert.equal(out.summary.failed, 0)
  // 5000 passing lines must not be re-sent.
  assert.ok(out.visibleChars < 2000)
  assert.doesNotMatch(out.text, /test number 4999/)
})

test("V16.10 budgeter: a failing suite exposes the failure, not the passing lines", () => {
  const lines = Array.from({ length: 3000 }, (_, index) => `ok ${index + 1} - test ${index + 1}`)
  lines.push("not ok 3001 - adds two numbers", "  AssertionError: expected 1 to equal 2", "  at /repo/src/math.ts:42:9", "# tests 3001", "# pass 3000", "# fail 1")
  const out = shapeToolOutput("bash", lines.join("\n"), { command: "npm test", handle: HANDLE, exitCode: 1 })
  assert.equal(out.outcome, "fail")
  assert.deepEqual(out.failures.failedTests, ["not ok 3001 - adds two numbers"])
  assert.match(out.failures.firstAssertion, /AssertionError/)
  assert.ok(out.failures.stackFrames.length >= 1)
  assert.ok(out.failures.affectedFiles.includes("/repo/src/math.ts"))
  assert.equal(out.failures.rawHandle, HANDLE)
  assert.doesNotMatch(out.text, /ok 2999 - test 2999/)
})

test("V16.10 budgeter: a diff shows changed files and hunks with a raw handle", () => {
  const lines = ["diff --git a/x.ts b/x.ts", "@@ -1 +1 @@", "-old", "+new", "diff --git a/y.ts b/y.ts", "@@ -2 +2 @@", "-a", "+b"]
  const out = shapeToolOutput("bash", lines.join("\n"), { strategy: TOOL_OUTPUT_STRATEGY.DIFF, handle: HANDLE })
  assert.deepEqual(out.files, ["x.ts", "y.ts"])
  assert.equal(out.hunkCount, 2)
  assert.match(out.text, /diff: files=2 hunks=2/)
})

test("V16.10 budgeter: omission notice is machine-readable and never lies", () => {
  const notice = omissionNotice({ originalChars: 1000, visibleChars: 200, handle: HANDLE })
  assert.match(notice, /original=1000 visible=200 omitted=800/)
  assert.match(notice, /retrieve=evidence:sha256:/)
  // An explicit omittedChars always wins over the derived value.
  const explicit = omissionNotice({ originalChars: 1000, visibleChars: 200, omittedChars: 5 })
  assert.match(explicit, /omitted=5/)
})

test("V16.10 budgeter: structural pair integrity catches orphan results and calls", () => {
  const ok = assertToolPairIntegrity([
    { role: "assistant", toolCallId: "call-1" },
    { role: "tool", toolCallId: "call-1" },
  ])
  assert.equal(ok.ok, true)

  const orphanResult = assertToolPairIntegrity([{ role: "tool", toolCallId: "call-9" }])
  assert.equal(orphanResult.ok, false)
  assert.deepEqual(orphanResult.orphanResults, ["call-9"])

  const unanswered = assertToolPairIntegrity([{ role: "assistant", toolCallId: "call-2" }])
  assert.equal(unanswered.ok, false)
  assert.deepEqual(unanswered.unansweredCalls, ["call-2"])
})

test("V16.10 budgeter: token counts are never fabricated as MEASURED", () => {
  const out = shapeToolOutput("read", bigSource(10), {})
  assert.equal(out.tokens.provenance, "NOT_MEASURED")
  assert.equal(out.tokens.input.provenance, "NOT_MEASURED")
  assert.equal(out.policy, TOOL_OUTPUT_BUDGETER_POLICY)
})
