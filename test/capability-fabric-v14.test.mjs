import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { capabilityFabricStatus, selectCapabilityProvider } from "../lib/capability-fabric.mjs"

test("V14 capability fabric prefers a healthy provider and keeps bounded fallbacks", () => {
  const selected = selectCapabilityProvider("research.web", [
    { id: "primary", status: "unavailable", priority: 100, quality: 0.95, costClass: "low", latencyClass: "fast" },
    { id: "fallback", status: "healthy", priority: 60, quality: 0.75, costClass: "low", latencyClass: "fast" },
    { id: "slow", status: "healthy", priority: 40, quality: 0.8, costClass: "high", latencyClass: "slow" },
  ])
  assert.equal(selected.selected.id, "fallback")
  assert.equal(selected.fallbacks[0].id, "slow")
  assert.equal(selected.candidates.find((item) => item.id === "primary").eligible, false)
})

test("V14 capability fabric health-checks deterministic providers without making optional tools fatal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-capability-v14-"))
  try {
    const status = await capabilityFabricStatus(root, {
      registry: {
        capabilities: {
          memory: [{ id: "memory", kind: "builtin", priority: 100 }],
          optional: [{ id: "missing", kind: "path", path: "definitely-missing", priority: 100 }],
        },
      },
    })
    assert.equal(status.capabilities.memory.selected.id, "memory")
    assert.equal(status.capabilities.optional.selected, null)
    assert.equal(status.capabilities.optional.fallbackNeeded, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
