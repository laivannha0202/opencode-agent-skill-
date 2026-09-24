import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { adaptiveContextBudget } from "../lib/adaptive-context-budget.mjs"
import { compileSkillContext, selectSkillNames } from "../lib/skill-compiler.mjs"
import { resolveAffectedTests } from "../lib/affected-tests.mjs"
import { findReusableVerification, recordVerification } from "../lib/verification-broker.mjs"
import { runtimeWorkspaceFingerprint } from "../lib/workspace-fingerprint.mjs"
import { runSupervisedProcess } from "../lib/process-supervisor.mjs"
import { selectBrowserToolsForTask } from "../lib/browser-mcp-routing.mjs"

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function gitRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v142-"))
  git(root, ["init"])
  git(root, ["config", "user.email", "ues@example.invalid"])
  git(root, ["config", "user.name", "UES Test"])
  return root
}

test("adaptive context shrinks low-risk roles and expands after failure", () => {
  const policy = {
    executionProfile: "standard",
    risk: "low",
    contextBudget: 20_000,
    profile: { contextBudget: 20_000 },
  }
  assert.equal(adaptiveContextBudget(policy, "verifier", 1).budget, 8_000)
  assert.equal(adaptiveContextBudget(policy, "verifier", 2).budget, 12_000)
  assert.equal(adaptiveContextBudget(policy, "verifier", 3).budget, 20_000)

  const highRisk = { ...policy, risk: "high", contextBudget: 48_000, profile: { contextBudget: 48_000 } }
  assert.equal(adaptiveContextBudget(highRisk, "verifier", 1).budget, 48_000)
})

test("micro-skill compiler selects bounded role/domain skills", async () => {
  const policy = { maxSkills: 3, domains: ["payment", "database"] }
  const selected = selectSkillNames(policy, "executor")
  assert.ok(selected.includes("implementation-engineer"))
  assert.ok(selected.includes("payment-engineering"))
  const compiled = await compileSkillContext(policy, "executor", { totalChars: 1800 })
  assert.ok(compiled.loaded.length >= 1)
  assert.ok(compiled.chars <= 1800)
  assert.ok(compiled.text.length <= 1800)
})

test("affected-test resolver ranks a nearby referencing test", async () => {
  const root = await gitRepo()
  try {
    await mkdir(path.join(root, "src", "payment"), { recursive: true })
    await mkdir(path.join(root, "test"), { recursive: true })
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: { test: "jest" },
    }))
    await writeFile(path.join(root, "src", "payment", "refund.ts"), "export const refund = () => 1\n")
    await writeFile(path.join(root, "test", "refund.spec.ts"), "import { refund } from '../src/payment/refund'\ntest('refund',()=>refund())\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    await writeFile(path.join(root, "src", "payment", "refund.ts"), "export const refund = () => 2\n")

    const plan = await resolveAffectedTests(root, { limit: 5 })
    assert.equal(plan.changedFiles.includes("src/payment/refund.ts"), true)
    assert.equal(plan.tests[0]?.path, "test/refund.spec.ts")
    assert.ok(plan.tests[0]?.score > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verification broker reuses PASS only for unchanged workspace", async () => {
  const root = await gitRepo()
  try {
    await writeFile(path.join(root, "a.txt"), "one\n")
    git(root, ["add", "."])
    git(root, ["commit", "-m", "base"])
    const fp = runtimeWorkspaceFingerprint(root)
    await recordVerification(root, {
      command: process.execPath,
      args: ["--version"],
      exitCode: 0,
      stdout: process.version,
      stderr: "",
      workspaceBefore: fp,
      workspaceAfter: fp,
      durationMs: 1,
    })
    const reused = await findReusableVerification(root, process.execPath, ["--version"])
    assert.equal(reused?.receipt?.passed, true)

    await writeFile(path.join(root, "a.txt"), "two\n")
    const stale = await findReusableVerification(root, process.execPath, ["--version"])
    assert.equal(stale, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("process supervisor caps output and times out process trees", async () => {
  const output = await runSupervisedProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(10000))"], {
    stdoutLimit: 2048,
    hardTimeoutMs: 5_000,
  })
  assert.equal(output.exitCode, 0)
  assert.equal(output.stdout.length, 2048)
  assert.equal(output.stdoutTruncated, true)

  const hung = await runSupervisedProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdoutLimit: 2048,
    hardTimeoutMs: 150,
    drainTimeoutMs: 200,
    killGraceMs: 50,
  })
  assert.equal(hung.stopReason, "hard-timeout")
})

test("browser task routing exposes a smaller task-specific subset", () => {
  const names = [
    "browser_snapshot", "browser_screenshot", "browser_console_messages",
    "browser_network_requests", "browser_navigate", "browser_click",
    "browser_fill_form", "browser_press_key", "browser_hover", "browser_evaluate",
    "browser_close", "browser_resize",
  ]
  const selected = selectBrowserToolsForTask(names, "verify responsive screenshot", "visual-verifier")
  assert.ok(selected.includes("browser_snapshot"))
  assert.ok(selected.includes("browser_screenshot"))
  assert.ok(selected.length <= 10)
  assert.ok(selected.length < names.length)
})
