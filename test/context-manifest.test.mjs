import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { buildContextManifest } from "../lib/context-manifest.mjs"

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test("context manifest ranks task terms, tests and changed references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-context-v8-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
    await writeFile(path.join(root, "src", "auth.js"), "import { policy } from './policy.js'\nexport function canEdit(){ return policy }\n")
    await writeFile(path.join(root, "src", "policy.js"), "export const policy = 'tenant permission auth'\n")
    await writeFile(path.join(root, "test", "auth.test.js"), "import '../src/auth.js'\n// tenant permission auth test\n")

    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])
    await writeFile(path.join(root, "src", "policy.js"), "export const policy = 'tenant permission auth ownership'\n")

    const manifest = await buildContextManifest(root, {
      id: "T1",
      title: "Fix tenant auth permission ownership",
      summary: "Prevent cross-tenant edits",
      files: { modify: ["src/auth.js"], test: ["test/auth.test.js"] },
      acceptance: ["Cross-tenant edit is denied"],
      verification: ["node --test"],
    }, { budget: 12000 })

    assert.equal(manifest.schemaVersion, 2)
    assert.ok(manifest.queryTerms.includes("tenant"))
    assert.ok(manifest.changed.includes("src/policy.js"))
    assert.ok(manifest.tests.includes("test/auth.test.js"))
    assert.ok(manifest.rankedReferences.some((item) => item.path === "src/policy.js"))
    assert.ok(manifest.excerpts.some((item) => item.role === "declared"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
