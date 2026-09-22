import test from "node:test"
import assert from "node:assert/strict"
import { defaultTier, resolveAdaptiveModel, resolveCapabilityModel, resolveModel, resolveTier } from "../lib/model-policy.mjs"

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


test("V11 capability model routing selects vision-capable model only when required", () => {
  const config = {
    enabled: true,
    roleTiers: { executor: "standard", "visual-verifier": "standard" },
    tiers: { light: "provider/cheap", standard: "provider/mid", heavy: "provider/vision" },
    capabilities: {
      "provider/cheap": { coding: true, toolCalling: true, filesystem: true, costClass: "low", latencyClass: "fast", quality: 0.6 },
      "provider/mid": { coding: true, toolCalling: true, filesystem: true, reasoning: true, costClass: "medium", latencyClass: "fast", quality: 0.8 },
      "provider/vision": { coding: true, toolCalling: true, filesystem: true, reasoning: true, vision: true, browser: true, longContext: true, costClass: "high", latencyClass: "medium", quality: 0.9 },
    },
  }
  const normal = resolveCapabilityModel("executor", 1, "fix this helper", { modelTier: "standard" }, config)
  assert.equal(normal.model, "provider/mid")
  const visual = resolveCapabilityModel("visual-verifier", 1, "match this screenshot in the browser", { modelTier: "standard" }, config)
  assert.equal(visual.model, "provider/vision")
  assert.equal(visual.capabilityRequirements.required.vision, true)
})


test("V11 capability routing never downshifts the configured executor tier", () => {
  const config = {
    enabled: true,
    roleTiers: { executor: "standard" },
    tiers: { light: "provider/cheap", standard: "provider/mid", heavy: "provider/heavy" },
    capabilities: {
      "provider/cheap": { coding: true, toolCalling: true, filesystem: true, costClass: "low", latencyClass: "fast", quality: 1 },
      "provider/mid": { coding: true, toolCalling: true, filesystem: true, costClass: "medium", latencyClass: "fast", quality: 0.7 },
      "provider/heavy": { coding: true, toolCalling: true, filesystem: true, reasoning: true, longContext: true, costClass: "high", latencyClass: "slow", quality: 1 },
    },
  }
  const resolved = resolveCapabilityModel("executor", 1, "fix a small helper", { modelTier: "light" }, config)
  assert.equal(resolved.tier, "standard")
  assert.equal(resolved.model, "provider/mid")
})
