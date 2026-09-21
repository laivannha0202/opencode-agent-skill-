import test from "node:test"
import assert from "node:assert/strict"
import { defaultTier, resolveAdaptiveModel, resolveModel, resolveTier } from "../lib/model-policy.mjs"

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

test("V10 FAST context does not silently downshift executor capability", () => {
  const taskPolicy = {
    mode: "inline",
    risk: "low",
    executionProfile: "fast",
    modelTier: "light",
    contextBudget: 8000,
  }
  const first = resolveAdaptiveModel("executor", 1, taskPolicy, {
    roleTiers: { executor: "standard" },
    tiers: { light: "provider/light", standard: "provider/standard", heavy: "provider/heavy" },
  })
  const retry = resolveAdaptiveModel("executor", 2, taskPolicy, {
    roleTiers: { executor: "standard" },
    tiers: { light: "provider/light", standard: "provider/standard", heavy: "provider/heavy" },
  })

  assert.equal(first.tier, "standard")
  assert.equal(first.model, "provider/standard")
  assert.equal(first.recoveryStage, "initial")
  assert.equal(retry.tier, "heavy")
  assert.equal(retry.model, "provider/heavy")
  assert.equal(retry.recoveryStage, "diagnose")
})
