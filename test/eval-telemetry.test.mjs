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
  assert.deepEqual(result.firstUsage, { input: 120, output: 30, total: 150 })
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
  assert.deepEqual(result.firstUsage, { input: 6360, output: 100, total: 8252 })
  assert.equal(result.usageSamples, 1)
})

test("live eval telemetry preserves the first usage sample separately from cumulative usage", () => {
  const stdout = [
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 6000, output: 10, total: 6010 } } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 3000, output: 20, total: 3020 } } }),
  ].join("\n")

  const result = parseOpenCodeTelemetry(stdout)
  assert.deepEqual(result.firstUsage, { input: 6000, output: 10, total: 6010 })
  assert.deepEqual(result.tokens, { input: 9000, output: 30, total: 9030 })
  assert.equal(result.usageSamples, 2)
})


test("initial input telemetry skips output-only usage samples", () => {
  const stdout = [
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 0, output: 5, total: 5 } } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 4200, output: 20, total: 4220 } } }),
  ].join("\n")

  const result = parseOpenCodeTelemetry(stdout)
  assert.deepEqual(result.firstUsage, { input: 4200, output: 20, total: 4220 })
  assert.equal(result.usageSamples, 2)
})

test("V11 telemetry captures cacheable prompt and evidence reuse without inventing unavailable metrics", () => {
  const ref = "evidence:sha256:" + "a".repeat(64)
  const stdout = [
    JSON.stringify({ type: "ues.context", promptCache: { cacheableRatio: 0.8, stableChars: 2400, dynamicChars: 600, repeatedStableChars: 1200 }, evidencePointers: { spec: ref } }),
    JSON.stringify({ type: "ues.context", evidence: [ref] }),
    JSON.stringify({ type: "visual.repair" }),
    JSON.stringify({ type: "context.expand" }),
    JSON.stringify({ type: "model.escalated" }),
  ].join("\n")
  const result = parseOpenCodeTelemetry(stdout)
  assert.equal(result.v11.avgCacheableRatio, 0.8)
  assert.equal(result.v11.avgStableChars, 2400)
  assert.equal(result.v11.avgDynamicChars, 600)
  assert.equal(result.v11.repeatedStableChars, 1200)
  assert.equal(result.v11.repeatedStableRatio, 0.5)
  assert.equal(result.v11.evidenceRefOccurrences, 2)
  assert.equal(result.v11.uniqueEvidenceRefs, 1)
  assert.equal(result.v11.evidenceReuseRatio, 0.5)
  assert.equal(result.v11.visualRepairAttempts, 1)
  assert.equal(result.v11.contextExpansions, 1)
  assert.equal(result.v11.modelEscalations, 1)
})

test("V11 telemetry keeps unavailable adaptive metrics null", () => {
  const result = parseOpenCodeTelemetry(JSON.stringify({ type: "message", usage: { input: 10, output: 2, total: 12 } }))
  assert.equal(result.v11.avgCacheableRatio, null)
  assert.equal(result.v11.repeatedStableChars, null)
  assert.equal(result.v11.evidenceReuseRatio, null)
})
