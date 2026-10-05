import assert from "node:assert/strict"
import test from "node:test"

import uesLoopRecoveryCompat, {
  UES_EXECUTION_ECONOMY_MARKER,
  applyExecutionEconomy,
  executionEconomyContract,
  isEngineeringTurnText,
} from "../pi/extensions/ues-loop-recovery.ts"

test("V16.7.1 execution economy keeps strength gates while removing duplicate local reasoning", () => {
  const contract = executionEconomyContract()
  assert.match(contract, /accepted UES\/DeepSeek advisor evidence/)
  assert.match(contract, /next concrete tool call/)
  assert.match(contract, /Do not repeat read\/search\/audit work/)
  assert.match(contract, /reason locally as much as required/)
  assert.match(contract, /Never skip permission checks, local evidence binding, tests, verification gates, or final verifier authority/)
  assert.doesNotMatch(contract, /lower thinking|disable verification|skip verification/i)
})

test("V16.7.1 execution economy injection is engineering-only and idempotent", async () => {
  const handlers = new Map()
  const pi = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
      return () => {}
    },
    sendMessage() {},
  }
  uesLoopRecoveryCompat(pi)
  const fire = async (name, event, ctx = {}) => {
    let result
    for (const fn of handlers.get(name) || []) {
      const value = await fn(event, ctx)
      if (value !== undefined) result = value
    }
    return result
  }

  const base = "BASE SYSTEM PROMPT"
  await fire("input", { source: "interactive", text: "hello there" })
  const casual = await fire("before_agent_start", { systemPrompt: base }, { getSystemPrompt: () => base })
  assert.equal(casual, undefined)

  await fire("input", { source: "interactive", text: "fix the API bug and run the tests" })
  const engineering = await fire("before_agent_start", { systemPrompt: base }, { getSystemPrompt: () => base })
  assert.ok(engineering?.systemPrompt)
  assert.match(engineering.systemPrompt, /BASE SYSTEM PROMPT/)
  assert.match(engineering.systemPrompt, new RegExp(UES_EXECUTION_ECONOMY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

  const twice = applyExecutionEconomy(engineering.systemPrompt)
  assert.equal(twice, engineering.systemPrompt, "economy contract must not duplicate itself")
})

test("V16.7.1 engineering classifier covers coding work without classifying tiny casual text", () => {
  assert.equal(isEngineeringTurnText("fix the TypeScript API bug"), true)
  assert.equal(isEngineeringTurnText("tối ưu dự án và kiểm tra lỗi"), true)
  assert.equal(isEngineeringTurnText("hi"), false)
})
