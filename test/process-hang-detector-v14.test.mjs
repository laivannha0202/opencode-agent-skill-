import assert from "node:assert/strict"
import test from "node:test"

import {
  detectHungToolEvidence,
  isToolExecutionError,
  toolResultText,
} from "../lib/process-hang-detector.mjs"

test("extracts streamed Pi tool text", () => {
  const text = toolResultText({
    content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ],
  })
  assert.equal(text, "first\nsecond")
})

test("detects Jest open-handle warning only for shell tools", () => {
  const sample = [
    "Test Suites: 1 failed, 1 total",
    "Tests: 1 failed, 1 total",
    "Jest did not exit one second after the test run has completed.",
    "This usually means that there are asynchronous operations that weren't stopped in your tests.",
    "Consider running Jest with --detectOpenHandles to troubleshoot this issue.",
  ].join("\n")

  const detected = detectHungToolEvidence({
    toolName: "bash",
    text: sample,
  })
  assert.equal(detected?.kind, "jest-open-handle")
  assert.equal(detected?.confidence, "high")
  assert.match(detected?.diagnosticHint || "", /--detectOpenHandles/)

  assert.equal(
    detectHungToolEvidence({ toolName: "read", text: sample }),
    null,
  )
})

test("ordinary failed tests are not classified as a process hang", () => {
  const detected = detectHungToolEvidence({
    toolName: "bash",
    text: "FAIL test/foo.test.ts\nExpected 1, received 2",
  })
  assert.equal(detected, null)
})

test("recognizes Pi tool execution errors", () => {
  assert.equal(
    isToolExecutionError({ type: "tool_execution_end", isError: true }),
    true,
  )
  assert.equal(
    isToolExecutionError({ type: "tool_execution_end", isError: false }),
    false,
  )
})
