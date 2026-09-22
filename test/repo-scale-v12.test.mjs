import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generateRepoScaleFixture } from "../lib/repo-scale-fixture.mjs"
test("V12 repo-scale generator creates deterministic multi-package fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"ues-repo-scale-test-"))
  try {
    const result = await generateRepoScaleFixture(root,{packageCount:3,modulesPerPackage:10})
    assert.equal(result.generatedModules,30); assert.equal(result.packageCount,3)
  } finally { await rm(root,{recursive:true,force:true}) }
})
