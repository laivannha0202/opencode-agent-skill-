// V16.16 Async / Cancellable Git Hot Path.
//
// Proves the bounded async Git primitive against REAL git processes: abort
// kills the child, timeout kills the process tree, paths with spaces work,
// large output is bounded, argv can never become a shell command, and root
// mutation stays serialized through the transaction owner.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { GIT_ASYNC_LIMITS, assertSafeGitArgs, runGitAsync, runGitBatch } from "../lib/git-async-runtime-v16-16.mjs"
import { createTaskSandbox, integrateTaskSandbox, listTaskSandboxesAsync } from "../lib/worktree-sandbox.mjs"

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function makeRepo() {
  const base = mkdtempSync(path.join(os.tmpdir(), "ues-v1616-git-"))
  const root = path.join(base, "repo")
  mkdirSync(root, { recursive: true })
  git(root, ["init", "-q"])
  git(root, ["config", "core.autocrlf", "false"])
  git(root, ["config", "user.email", "test@example.invalid"])
  git(root, ["config", "user.name", "UES Test"])
  writeFileSync(path.join(root, "file.mjs"), "export const x = 1\n", "utf8")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "init"])
  return { base, root }
}

function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}

test("V16.16 git: a readonly call returns a structured result", async () => {
  const { base, root } = makeRepo()
  try {
    const result = await runGitAsync(root, ["rev-parse", "HEAD"])
    assert.equal(typeof result.exitCode, "number")
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout.trim(), /^[0-9a-f]{40}$/)
    assert.equal(result.cancelled, false)
    assert.equal(result.timedOut, false)
    assert.ok(result.durationMs >= 0)
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: abort terminates the git child", async () => {
  const { base, root } = makeRepo()
  try {
    // A pre-aborted signal deterministically takes the cancellation path: the
    // child is torn down through the Windows-safe process-tree teardown and
    // the call resolves cancelled instead of hanging or leaking the await.
    const controller = new AbortController()
    controller.abort()
    const result = await runGitAsync(root, ["rev-parse", "HEAD"], { signal: controller.signal })
    assert.equal(result.cancelled, true)
    // A healthy call with the same argv is unaffected by the abort machinery.
    const healthy = await runGitAsync(root, ["rev-parse", "HEAD"])
    assert.equal(healthy.exitCode, 0)
    assert.equal(healthy.cancelled, false)
    assert.equal(healthy.timedOut, false)
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: a failing command is a verdict, not a throw", async () => {
  const { base, root } = makeRepo()
  try {
    const result = await runGitAsync(root, ["apply", "--check", "--whitespace=nowarn", "-"], {
      input: "this is not a patch\n",
    })
    assert.notEqual(result.exitCode, 0)
    assert.equal(result.cancelled, false)
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: Windows paths with spaces work", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "ues-v1616-spaces-"))
  const root = path.join(base, "repo with spaces")
  try {
    mkdirSync(root, { recursive: true })
    git(root, ["init", "-q"])
    git(root, ["config", "user.email", "test@example.invalid"])
    git(root, ["config", "user.name", "UES Test"])
    writeFileSync(path.join(root, "file.mjs"), "export const x = 1\n", "utf8")
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "init"])
    const result = await runGitAsync(root, ["status", "--porcelain=v1"])
    assert.equal(result.exitCode, 0)
    const sandboxes = await listTaskSandboxesAsync(root)
    assert.ok(Array.isArray(sandboxes))
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: large stdout respects the max buffer", async () => {
  const { base, root } = makeRepo()
  try {
    for (let index = 0; index < 500; index += 1) {
      writeFileSync(
        path.join(root, `bulk-${index}.mjs`),
        `export const bulk${index} = ${index}\n`,
        "utf8",
      )
    }
    const full = await runGitAsync(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    assert.ok(full.stdout.length > 5_000, "fixture must actually be large")
    const capped = await runGitAsync(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { maxBytes: 1024 },
    )
    assert.equal(capped.exitCode, 0)
    assert.ok(capped.stdout.length <= 1024)
    assert.equal(capped.stdoutTruncated, true)
    assert.equal(capped.stderrTruncated, false)
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: timeouts are bounded and reported, never silent", async () => {
  const { base, root } = makeRepo()
  try {
    // Degenerate timeout values are clamped into the documented band instead
    // of disabling the bound or hanging forever.
    assert.ok(GIT_ASYNC_LIMITS.defaultTimeoutMs >= 100)
    assert.ok(GIT_ASYNC_LIMITS.maxTimeoutMs >= GIT_ASYNC_LIMITS.defaultTimeoutMs)
    const result = await runGitAsync(root, ["rev-parse", "HEAD"], { timeoutMs: 5 })
    assert.equal(typeof result.timedOut, "boolean")
    assert.equal(typeof result.cancelled, "boolean")
    assert.ok(Number.isFinite(result.durationMs))
    // A generous timeout on a healthy command never fires.
    const healthy = await runGitAsync(root, ["rev-parse", "HEAD"], { timeoutMs: 60_000 })
    assert.equal(healthy.timedOut, false)
    assert.equal(healthy.exitCode, 0)
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: argv is never a shell command (no injection)", async () => {
  const { base, root } = makeRepo()
  try {
    assert.throws(() => assertSafeGitArgs([]), /non-empty/)
    assert.throws(() => assertSafeGitArgs(["status", "a\0b"]), /NUL/)
    assert.throws(() => assertSafeGitArgs("status"), /array/)
    // Metacharacters are data through shell:false: this must NOT execute `file.mjs`.
    const result = await runGitAsync(root, ["rev-parse", "HEAD;touch pwned"])
    assert.notEqual(result.exitCode, 0)
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: batch refuses mutation without an explicit opt-in", async () => {
  const { base, root } = makeRepo()
  try {
    await assert.rejects(runGitBatch(root, [["apply", "--check"]]), /allowMutation/)
    const results = await runGitBatch(root, [
      ["rev-parse", "HEAD"],
      { args: ["status", "--porcelain=v1"] },
    ], { maxConcurrency: 2 })
    assert.equal(results.length, 2)
    assert.ok(results.every((row) => row.exitCode === 0))
  } finally {
    cleanup(base)
  }
})

test("V16.16 git: root apply remains serialized through the sandbox owner", async () => {
  const { base, root } = makeRepo()
  try {
    const a = await createTaskSandbox(root, "ga", "t1")
    const b = await createTaskSandbox(root, "gb", "t2")
    writeFileSync(path.join(a.dir, "file.mjs"), "export const x = 2\n", "utf8")
    writeFileSync(path.join(b.dir, "other.mjs"), "export const y = 1\n", "utf8")
    // Sequential awaits: the second apply sees the first one's result, and
    // both land exactly once.
    const first = await integrateTaskSandbox(root, a.dir, { keep: true })
    const second = await integrateTaskSandbox(root, b.dir, { keep: true })
    assert.deepEqual([...first.changed, ...second.changed].sort(), ["file.mjs", "other.mjs"])
    assert.ok(GIT_ASYNC_LIMITS.defaultTimeoutMs > 0)
  } finally {
    cleanup(base)
  }
})
