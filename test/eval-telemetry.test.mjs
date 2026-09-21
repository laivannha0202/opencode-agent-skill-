import test from "node:test"
import assert from "node:assert/strict"
import { parseOpenCodeTelemetry } from "../lib/eval-telemetry.mjs"

test("live eval telemetry extracts tools, skills, subagents, tokens and cost without requiring one exact event shape", () => {
  const stdout = [
    JSON.stringify({ type: "tool.call", id: "1", name: "skill", input: { id: "ues-bug-diagnosis" } }),
    JSON.stringify({ event: "tool", tool: "bash", callID: "2", args: { command: "npm test" } }),
    JSON.stringify({ type: "tool.call", id: "3", toolName: "subagent", input: { agent: "ues-verifier" } }),
    JSON.stringify({ type: "message", usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 }, cost: 0.012 }),
    "not-json",
  ].join("\n")

  const result = parseOpenCodeTelemetry(stdout)
  assert.equal(result.jsonLines, 4)
  assert.equal(result.parseErrors, 1)
  assert.equal(result.toolCalls, 3)
  assert.deepEqual(result.skillsLoaded, ["ues-bug-diagnosis"])
  assert.deepEqual(result.subagents, ["ues-verifier"])
  assert.equal(result.tools.bash, 1)
  assert.equal(result.tokens.input, 120)
  assert.equal(result.tokens.output, 30)
  assert.equal(result.tokens.total, 150)
  assert.equal(result.usageSamples, 1)
  assert.equal(result.cost, 0.012)
  assert.equal(result.costSamples, 1)
})

test("live eval telemetry reads OpenCode step_finish part.tokens payloads", () => {
  const stdout = JSON.stringify({
    type: "step_finish",
    part: {
      type: "step-finish",
      tokens: {
        input: 6360,
        output: 100,
        total: 8252,
        cache: { write: 0, read: 1792 },
      },
    },
  })

  const result = parseOpenCodeTelemetry(stdout)
  assert.equal(result.jsonLines, 1)
  assert.equal(result.parseErrors, 0)
  assert.equal(result.tokens.input, 6360)
  assert.equal(result.tokens.output, 100)
  assert.equal(result.tokens.total, 8252)
  assert.equal(result.usageSamples, 1)
})

