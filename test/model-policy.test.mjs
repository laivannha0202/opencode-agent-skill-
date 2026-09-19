import test from "node:test"
import assert from "node:assert/strict"
import { defaultTier, resolveModel, resolveTier } from "../lib/model-policy.mjs"

test("model policy escalates failed attempts but caps at heavy", () => {
  assert.equal(defaultTier("executor"), "standard")
  assert.equal(defaultTier("architect"), "heavy")
  assert.equal(resolveTier("executor", 1), "standard")
  assert.equal(resolveTier("executor", 2), "heavy")
  assert.equal(resolveTier("executor", 5), "heavy")
})

test("model policy maps tiers to configured model ids without guessing", () => {
  const result = resolveModel("executor", 2, {
    tiers: { light: "provider/cheap", standard: "provider/mid", heavy: "provider/strong" },
  })
  assert.equal(result.tier, "heavy")
  assert.equal(result.model, "provider/strong")
})
