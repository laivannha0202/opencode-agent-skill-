import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import {
  createTaskSandbox,
  integrateTaskSandbox,
  listTaskSandboxes,
} from "../lib/worktree-sandbox.mjs"

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test("sandbox integration applies isolated changes and cleans worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-root-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-base-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "value.js"), "export const value = 1\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const sandbox = await createTaskSandbox(root, "demo", "T1", { baseDir: base })
    await writeFile(path.join(sandbox.dir, "src", "value.js"), "export const value = 2\n")
    await writeFile(path.join(sandbox.dir, "src", "new.js"), "export const extra = true\n")

    const integrated = await integrateTaskSandbox(root, sandbox.dir)
    assert.equal(integrated.integrated, true)
    assert.ok(integrated.changed.includes("src/value.js"))
    assert.ok(integrated.changed.includes("src/new.js"))
    const valueSource = await readFile(path.join(root, "src", "value.js"), "utf8")
    const newSource = await readFile(path.join(root, "src", "new.js"), "utf8")
    assert.equal(valueSource.replaceAll("\r\n", "\n"), "export const value = 2\n")
    assert.equal(newSource.replaceAll("\r\n", "\n"), "export const extra = true\n")
    assert.equal(listTaskSandboxes(root).some((item) => path.resolve(item.path) === path.resolve(sandbox.dir)), false)
    assert.equal(git(root, ["branch", "--list", sandbox.branch]), "")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})

test("sandbox integration refuses overlap with dirty root files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-conflict-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-conflict-base-"))
  try {
    await writeFile(path.join(root, "value.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const sandbox = await createTaskSandbox(root, "demo", "T2", { baseDir: base })
    await writeFile(path.join(sandbox.dir, "value.txt"), "sandbox\n")
    await writeFile(path.join(root, "value.txt"), "root\n")

    await assert.rejects(
      integrateTaskSandbox(root, sandbox.dir, { keep: true }),
      /conflicts with existing root changes/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})


test("sandbox creation refuses dirty root state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-dirty-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-dirty-base-"))
  try {
    await writeFile(path.join(root, "value.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])
    await writeFile(path.join(root, "value.txt"), "dirty\n")

    await assert.rejects(
      createTaskSandbox(root, "demo", "T3", { baseDir: base }),
      /clean root working tree/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})
