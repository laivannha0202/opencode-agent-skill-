// V16.16 Run / Wave / Sandbox Identity.
//
// Proves end-to-end identity enforcement with REAL Git repositories: a sandbox
// from another run, another root, an advanced root or a stale base is never
// integrated, while a valid same-run transaction still works.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { INTEGRATION_OUTCOME, runIntegrationTransaction } from "../lib/integration-transaction-v16-15.mjs"
import { createTaskSandbox, preflightTaskSandbox } from "../lib/worktree-sandbox.mjs"

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function makeRepo() {
  const base = mkdtempSync(path.join(os.tmpdir(), "ues-v1616-id-"))
  const root = path.join(base, "repo")
  mkdirSync(root, { recursive: true })
  git(root, ["init", "-q"])
  git(root, ["config", "core.autocrlf", "false"])
  git(root, ["config", "core.eol", "lf"])
  git(root, ["config", "user.email", "test@example.invalid"])
  git(root, ["config", "user.name", "UES Test"])
  writeFileSync(path.join(root, "lib-a.mjs"), "export const a = 1\n", "utf8")
  writeFileSync(path.join(root, "lib-b.mjs"), "export const b = 1\n", "utf8")
  git(root, ["add", "-A"])
  git(root, ["commit", "-q", "-m", "init"])
  return { base, root }
}

function cleanup(base) {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}

async function sandboxWithEdit(root, slug, taskId, file, content, identity = {}) {
  const sandbox = await createTaskSandbox(root, slug, taskId, { runId: "run-1", waveId: "wave-0", ...identity })
  writeFileSync(path.join(sandbox.dir, file), content, "utf8")
  return sandbox
}

test("V16.16 identity: a valid same-run transaction integrates", async () => {
  const { base, root } = makeRepo()
  try {
    const head = git(root, ["rev-parse", "HEAD"])
    const a = await sandboxWithEdit(root, "sa", "t1", "lib-a.mjs", "export const a = 2\n")
    const b = await sandboxWithEdit(root, "sb", "t2", "lib-b.mjs", "export const b = 2\n")
    const result = await runIntegrationTransaction({
      root,
      runId: "run-1",
      waveId: "wave-0",
      patches: [
        { taskId: "t1", sandboxDir: a.dir, writeFiles: ["lib-a.mjs"], runId: "run-1" },
        { taskId: "t2", sandboxDir: b.dir, writeFiles: ["lib-b.mjs"], runId: "run-1" },
      ],
      options: { expectedRunId: "run-1", expectedWaveId: "wave-0", expectedRootHead: head },
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.INTEGRATED)
    assert.equal(result.durable, true)
    assert.ok(result.transactionId.startsWith("itx-"))
  } finally {
    cleanup(base)
  }
})

test("V16.16 identity: a stale-run sandbox is rejected before any mutation", async () => {
  const { base, root } = makeRepo()
  try {
    const before = git(root, ["rev-parse", "HEAD"])
    const foreign = await sandboxWithEdit(root, "foreign", "t9", "lib-a.mjs", "export const a = 9\n", { runId: "run-other" })
    const verdict = await preflightTaskSandbox(root, foreign.dir, { expectedRunId: "run-1" })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reason, "run-mismatch")
    const result = await runIntegrationTransaction({
      root,
      runId: "run-1",
      waveId: "wave-0",
      patches: [{ taskId: "t9", sandboxDir: foreign.dir, writeFiles: ["lib-a.mjs"], runId: "run-other" }],
      options: { expectedRunId: "run-1", expectedWaveId: "wave-0" },
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.PREFLIGHT_REJECTED)
    assert.equal(result.rootUnchanged, true)
    assert.equal(git(root, ["rev-parse", "HEAD"]), before)
  } finally {
    cleanup(base)
  }
})

test("V16.16 identity: a wrong owner root is rejected", async () => {
  const first = makeRepo()
  const second = makeRepo()
  try {
    const sandbox = await sandboxWithEdit(first.root, "s", "t1", "lib-a.mjs", "export const a = 2\n")
    const verdict = await preflightTaskSandbox(second.root, sandbox.dir, {})
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reason, "owner-root-mismatch")
  } finally {
    cleanup(first.base)
    cleanup(second.base)
  }
})

test("V16.16 identity: an advanced root is rejected", async () => {
  const { base, root } = makeRepo()
  try {
    const staleHead = git(root, ["rev-parse", "HEAD"])
    writeFileSync(path.join(root, "lib-a.mjs"), "export const a = 100\n", "utf8")
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "someone else advanced the root"])
    const a = await createTaskSandbox(root, "sa", "t1", { runId: "run-1", waveId: "wave-0" })
    const result = await runIntegrationTransaction({
      root,
      runId: "run-1",
      waveId: "wave-0",
      patches: [{ taskId: "t1", sandboxDir: a.dir, writeFiles: [], runId: "run-1" }],
      options: { expectedRunId: "run-1", expectedRootHead: staleHead },
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.PREFLIGHT_REJECTED)
    assert.ok(result.rejected.some((row) => row.reason === "root-advanced-since-wave-start"))
  } finally {
    cleanup(base)
  }
})

test("V16.16 identity: a stale integration base is rejected", async () => {
  const { base, root } = makeRepo()
  try {
    const a = await sandboxWithEdit(root, "sa", "t1", "lib-a.mjs", "export const a = 2\n")
    const verdict = await preflightTaskSandbox(root, a.dir, { expectedBaseSha: "deadbeef".repeat(5).slice(0, 40) })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reason, "stale-generation")
  } finally {
    cleanup(base)
  }
})

test("V16.16 identity: a foreign wave sandbox is rejected when a wave is expected", async () => {
  const { base, root } = makeRepo()
  try {
    const other = await sandboxWithEdit(root, "other", "t1", "lib-a.mjs", "export const a = 2\n", { waveId: "wave-9" })
    const verdict = await preflightTaskSandbox(root, other.dir, { expectedRunId: "run-1", expectedWaveId: "wave-0" })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reason, "wave-mismatch")
    // ...but the same sandbox is admissible when its own wave is expected.
    const own = await preflightTaskSandbox(root, other.dir, { expectedRunId: "run-1", expectedWaveId: "wave-9" })
    assert.equal(own.ok, true)
  } finally {
    cleanup(base)
  }
})

test("V16.16 identity: a legacy sandbox without identity fails closed under an expectation", async () => {
  const { base, root } = makeRepo()
  try {
    const legacy = await createTaskSandbox(root, "legacy", "t1")
    writeFileSync(path.join(legacy.dir, "lib-a.mjs"), "export const a = 2\n", "utf8")
    const verdict = await preflightTaskSandbox(root, legacy.dir, { expectedRunId: "run-1" })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.reason, "run-mismatch")
    // ...and still preflights fine when no expectation is supplied.
    const open = await preflightTaskSandbox(root, legacy.dir, {})
    assert.equal(open.ok, true)
  } finally {
    cleanup(base)
  }
})
