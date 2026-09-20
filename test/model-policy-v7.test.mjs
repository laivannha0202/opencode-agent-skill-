import test from "node:test"
import assert from "node:assert/strict"
import { resolveAdaptiveModel } from "../lib/model-policy.mjs"

test("adaptive model policy raises a standard executor to heavy for high-risk work", () => {
  const result = resolveAdaptiveModel(
    "executor",
    1,
    { modelTier: "heavy", mode: "long-horizon", risk: "high", score: 6 },
    {
      maxEscalations: 2,
      roleTiers: { executor: "standard" },
      tiers: { light: "p/light", standard: "p/mid", heavy: "p/heavy" },
    },
  )
  assert.equal(result.tier, "heavy")
  assert.equal(result.model, "p/heavy")
  assert.equal(result.policy.risk, "high")
})
