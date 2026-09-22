import test from "node:test"
import assert from "node:assert/strict"
import { inferTaskCapabilities, selectCapabilityCandidate } from "../lib/capability-registry.mjs"

test("V11 capability inference routes screenshot/browser work to multimodal browser-capable candidates", () => {
  const needs = inferTaskCapabilities("Use Playwright to match this screenshot exactly in the browser")
  assert.equal(needs.required.vision, true)
  assert.equal(needs.required.browser, true)
  const result = selectCapabilityCandidate(needs, [
    { id: "cheap-code", capabilities: { coding: true, toolCalling: true, filesystem: true, quality: 0.8, costClass: "low", latencyClass: "fast" } },
    { id: "vision", capabilities: { coding: true, toolCalling: true, filesystem: true, vision: true, browser: true, quality: 0.75, costClass: "medium", latencyClass: "medium" } },
  ])
  assert.equal(result.selected.id, "vision")
  assert.ok(result.candidates.find((item) => item.id === "cheap-code").missing.includes("vision"))
})
