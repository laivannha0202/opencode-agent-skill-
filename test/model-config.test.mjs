import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  applyConfiguredModel,
  readModelPolicy,
  validateModelID,
  writeModelPolicy,
} from "../lib/model-config.mjs"

test("model config persists tier mappings and validates provider/model ids", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-models-"))
  try {
    assert.equal(validateModelID("openai/gpt-5#high"), true)
    assert.equal(validateModelID("broken"), false)

    const written = await writeModelPolicy(dir, {
      enabled: true,
      tiers: { standard: "provider/mid", heavy: "provider/strong" },
      roleTiers: { executor: "standard" },
    })
    assert.equal(written.enabled, true)
    assert.equal(written.tiers.heavy, "provider/strong")

    const reread = await readModelPolicy(dir)
    assert.equal(reread.tiers.standard, "provider/mid")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("configured agent model is inserted into frontmatter without changing body", () => {
  const source = `---
description: Executes one task
mode: subagent
permission:
  task: deny
---

Body
`
  const adapted = applyConfiguredModel(source, "executor", {
    enabled: true,
    maxEscalations: 2,
    tiers: { light: null, standard: "provider/mid", heavy: "provider/strong" },
    roleTiers: { executor: "standard" },
  })
  assert.match(adapted, /model: provider\/mid/)
  assert.match(adapted, /Body/)
})


test("V11 model config persists capability profiles", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-model-caps-"))
  try {
    await writeModelPolicy(dir, {
      enabled: true,
      tiers: { heavy: "provider/vision" },
      capabilities: {
        "provider/vision": {
          coding: true,
          reasoning: true,
          toolCalling: true,
          vision: true,
          browser: true,
          filesystem: true,
          longContext: true,
          quality: 0.9,
          costClass: "high",
          latencyClass: "medium",
        },
      },
    })
    const reread = await readModelPolicy(dir)
    assert.equal(reread.schemaVersion, 2)
    assert.equal(reread.capabilities["provider/vision"].vision, true)
    assert.equal(reread.capabilities["provider/vision"].browser, true)
    assert.equal(reread.capabilities["provider/vision"].quality, 0.9)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
