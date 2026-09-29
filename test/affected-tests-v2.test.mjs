import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { clearAffectedTestCache, resolveAffectedTests } from "../lib/affected-tests.mjs"

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed")
}

test("Affected-Test Index V2 uses Git inventory and reuses exact fingerprint results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-affected-index-v2-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "src", "math.js"), "export const add = (a, b) => a + b\n")
    await writeFile(path.join(root, "test", "math.test.js"), "import { add } from '../src/math.js'\nvoid add\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    clearAffectedTestCache()
    await writeFile(path.join(root, "src", "math.js"), "export const add = (a, b) => Number(a) + Number(b)\n")

    const first = await resolveAffectedTests(root)
    const second = await resolveAffectedTests(root)

    assert.equal(first.inventorySource, "git-index")
    assert.equal(first.tests.some((item) => item.path === "test/math.test.js"), true)
    assert.equal(first.cacheHit, false)
    assert.equal(second.cacheHit, true)
    assert.equal(second.tests[0].path, first.tests[0].path)

    await writeFile(path.join(root, "src", "math.js"), "export const add = (a, b) => (+a) + (+b)\n")
    const third = await resolveAffectedTests(root)
    assert.equal(third.inventorySource, "git-index")
    assert.equal(third.tests.some((item) => item.path === "test/math.test.js"), true)

    clearAffectedTestCache()
    const serial = await resolveAffectedTests(root, { ioConcurrency: 1 })
    clearAffectedTestCache()
    const parallel = await resolveAffectedTests(root, { ioConcurrency: 4 })
    assert.deepEqual(parallel.tests, serial.tests)
    assert.deepEqual(parallel.suggestedCommands, serial.suggestedCommands)
  } finally {
    clearAffectedTestCache()
    await rm(root, { recursive: true, force: true })
  }
})


test("Affected-Test Index V2 ignores canonical UES runtime artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-affected-runtime-artifacts-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "src", "real.js"), "export const real = 1\n")
    await writeFile(path.join(root, "test", "real.test.js"), "import { real } from '../src/real.js'\nvoid real\n")
    for (const dir of [".ues-work", ".ues-learning", ".ues-dashboard", ".ues-sandboxes", ".ues-cache", ".ues-traces", ".ues-memory", ".ues-evals", ".ues-services"]) {
      await mkdir(path.join(root, dir), { recursive: true })
      await writeFile(path.join(root, dir, "fake.test.js"), "throw new Error('must not be inventoried')\n")
    }
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    clearAffectedTestCache()
    await writeFile(path.join(root, "src", "real.js"), "export const real = 2\n")
    const plan = await resolveAffectedTests(root)
    assert.equal(plan.tests.some((item) => item.path.startsWith(".ues-")), false)
    assert.equal(plan.tests.some((item) => item.path === "test/real.test.js"), true)
  } finally {
    clearAffectedTestCache()
    await rm(root, { recursive: true, force: true })
  }
})
