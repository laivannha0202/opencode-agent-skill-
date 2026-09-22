import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { lintSkillCatalog } from "../lib/skill-quality.mjs"

test("V11 skill linter catches routing-description collisions without loading all bodies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-skills-"))
  try {
    const base = path.join(root, "global-config", "skills")
    for (const name of ["one", "two"]) {
      const dir = path.join(base, name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, "SKILL.md"), `---
name: ${name}
description: Verify browser visual screenshot layout and pixel fidelity for web UI.
---

# ${name}
Small body.
`)
    }
    const result = await lintSkillCatalog(root, { collisionThreshold: 0.5 })
    assert.equal(result.valid, true)
    assert.equal(result.skillCount, 2)
    assert.equal(result.collisions.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
