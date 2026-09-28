import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildAdaptiveTaskContext } from "../lib/context-engine-v11.mjs"

test("Context preparation exposes parallel-build timing without changing the context contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-context-parallel-v2-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "value.js"), "export const value = 1\n")
    const result = await buildAdaptiveTaskContext(root, {
      id: "value",
      title: "Inspect value",
      summary: "Inspect src/value.js",
      files: { modify: ["src/value.js"] },
      acceptance: ["value remains valid"],
    }, {
      policy: {
        contextBudget: 8000,
        executionProfile: "fast",
        profile: { contextStrategy: "incremental-semantic" },
      },
    })
    assert.equal(result.contextSchemaVersion, 6)
    assert.equal(result.performance.parallelContextPreparation, true)
    assert.equal(Number.isFinite(result.performance.totalMs), true)
    assert.equal(result.performance.totalMs >= 0, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
