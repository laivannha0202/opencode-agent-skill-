import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readRouterConfig, writeRouterConfig } from "../lib/router-config.mjs"

test("router config defaults on, persists toggles and clamps supported configuration", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ues-router-config-"))
  try {
    const initial = await readRouterConfig(temp)
    assert.equal(initial.enabled, true)
    assert.equal(initial.maxSkills, 4)

    await writeRouterConfig(temp, { enabled: false, maxSkills: 3 })
    const saved = await readRouterConfig(temp)
    assert.equal(saved.enabled, false)
    assert.equal(saved.maxSkills, 3)

    await assert.rejects(() => writeRouterConfig(temp, { maxSkills: 7 }), RangeError)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
