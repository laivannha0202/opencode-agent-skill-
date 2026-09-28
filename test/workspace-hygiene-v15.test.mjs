import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import {
  auditUnicodeSource,
  captureWorkspaceHygieneBaseline,
  postRunFileHygiene,
  preFinalWorkspaceAudit,
} from "../lib/workspace-hygiene.mjs"

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed")
}

async function repoFixture(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  await mkdir(path.join(root, "src"), { recursive: true })
  await writeFile(path.join(root, "src", "app.js"), "export const greeting = 'Xin chào'\n")
  git(root, ["init"])
  git(root, ["add", "."])
  git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])
  return root
}

test("Unicode Source Hygiene allows normal Vietnamese but blocks invisible and mixed-script source", () => {
  assert.equal(auditUnicodeSource("const thôngBao = 'Đăng nhập thành công'\n", { file: "src/a.js" }).safe, true)

  const zeroWidth = auditUnicodeSource("const user\u200bId = 1\n", { file: "src/a.js" })
  assert.equal(zeroWidth.safe, false)
  assert.equal(zeroWidth.findings.some((item) => item.kind === "zero-width-character"), true)

  const bidi = auditUnicodeSource("const safe = 'x'\u202e // hidden\n", { file: "src/a.js" })
  assert.equal(bidi.findings.some((item) => item.kind === "bidi-control"), true)

  const mixed = auditUnicodeSource("const pаypal = 1\n", { file: "src/a.js" })
  assert.equal(mixed.findings.some((item) => item.kind === "mixed-script-token"), true)
})

test("Post-Run File Hygiene removes proven scratch and blocks unexplained debug artifacts", async () => {
  const root = await repoFixture("ues-hygiene-post-")
  try {
    const baseline = captureWorkspaceHygieneBaseline(root)
    await writeFile(path.join(root, "src", "app.js"), "export const greeting = 'Xin chào bạn'\n")
    await writeFile(path.join(root, "scratch.tmp"), "throwaway\n")
    await writeFile(path.join(root, "debug-helper.js"), "export const debug = true\n")

    const result = await postRunFileHygiene(root, {
      baseline,
      taskText: "Update src/app.js only",
      allowSourceMutations: true,
      autoClean: true,
    })

    assert.equal(existsSync(path.join(root, "scratch.tmp")), false)
    assert.equal(result.removed.includes("scratch.tmp"), true)
    assert.equal(result.safe, false)
    assert.equal(result.findings.some((item) => item.file === "debug-helper.js" && item.kind === "unexplained-transient-artifact"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Post-Run File Hygiene blocks Unicode corruption introduced by a writer", async () => {
  const root = await repoFixture("ues-hygiene-unicode-")
  try {
    const baseline = captureWorkspaceHygieneBaseline(root)
    await writeFile(path.join(root, "src", "app.js"), "export const user\u200bId = 1\n")
    const result = await postRunFileHygiene(root, {
      baseline,
      taskText: "Update src/app.js",
      allowSourceMutations: true,
    })
    assert.equal(result.safe, false)
    assert.equal(result.findings.some((item) => item.kind === "zero-width-character"), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Read-only agent transient output is cleaned without becoming a source mutation", async () => {
  const root = await repoFixture("ues-hygiene-readonly-")
  try {
    const baseline = captureWorkspaceHygieneBaseline(root)
    await writeFile(path.join(root, "read-only.tmp"), "should not exist\n")
    const result = await postRunFileHygiene(root, {
      baseline,
      taskText: "Inspect only",
      allowSourceMutations: false,
      autoClean: true,
    })
    assert.equal(existsSync(path.join(root, "read-only.tmp")), false)
    assert.equal(result.safe, true)
    assert.equal(result.changed.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pre-final audit enforces declared final write scope without touching files", async () => {
  const root = await repoFixture("ues-hygiene-final-")
  try {
    const baseline = captureWorkspaceHygieneBaseline(root)
    await writeFile(path.join(root, "src", "app.js"), "export const greeting = 'ok'\n")
    await writeFile(path.join(root, "src", "extra.js"), "export const extra = true\n")
    const result = await preFinalWorkspaceAudit(root, {
      baseline,
      taskText: "Update src/app.js",
      allowedPaths: ["src/app.js"],
      strictScope: true,
      allowSourceMutations: true,
    })
    assert.equal(result.safe, false)
    assert.equal(result.findings.some((item) => item.file === "src/extra.js" && item.kind === "undeclared-source-change"), true)
    assert.equal(await readFile(path.join(root, "src", "extra.js"), "utf8"), "export const extra = true\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
