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


test("adaptive model policy raises minimum tier from risk/context but honors disabled routing", () => {
  const configured = {
    enabled: true,
    tiers: { light: "provider/cheap", standard: "provider/mid", heavy: "provider/strong" },
  }
  const result = resolveAdaptiveModel("executor", 1, configured, {
    risk: "critical",
    files: 10,
    contextBytes: 70000,
  })
  assert.equal(result.tier, "heavy")
  assert.equal(result.model, "provider/strong")
  assert.equal(result.adaptive.isolationRecommended, true)

  const disabled = resolveAdaptiveModel("executor", 1, { ...configured, enabled: false }, {
    risk: "critical",
  })
  assert.equal(disabled.model, null)
})
