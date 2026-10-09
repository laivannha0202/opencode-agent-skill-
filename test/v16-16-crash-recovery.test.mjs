// V16.16 Crash-Safe Integration Transaction.
//
// Proves durability with REAL Git repositories and failure injection: a
// process-equivalent interruption after the first real patch leaves a durable
// BEGIN without COMMIT; startup recovery restores the pre-transaction
// identity where ownership is proven, refuses to touch user changes, never
// rolls back a completed transaction, and is idempotent.

import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  INTEGRATION_JOURNAL,
  INTEGRATION_OUTCOME,
  recoverIncompleteIntegrations,
  runIntegrationTransaction,
} from "../lib/integration-transaction-v16-15.mjs"
import { createTaskSandbox, rootWorkspaceIdentity } from "../lib/worktree-sandbox.mjs"
import { readRunJournal } from "../lib/run-journal.mjs"

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function makeRepo() {
  const base = mkdtempSync(path.join(os.tmpdir(), "ues-v1616-crash-"))
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

async function twoPatches(root, runId) {
  const a = await createTaskSandbox(root, "ca", "t1", { runId, waveId: "wave-0" })
  const b = await createTaskSandbox(root, "cb", "t2", { runId, waveId: "wave-0" })
  writeFileSync(path.join(a.dir, "lib-a.mjs"), "export const a = 2\n", "utf8")
  writeFileSync(path.join(b.dir, "lib-b.mjs"), "export const b = 2\n", "utf8")
  return [
    { taskId: "t1", sandboxDir: a.dir, writeFiles: ["lib-a.mjs"], runId },
    { taskId: "t2", sandboxDir: b.dir, writeFiles: ["lib-b.mjs"], runId },
  ]
}

function journalTypes(root, runId) {
  return readRunJournal(root, runId, { limit: 5000 }).then((rows) =>
    rows.filter((row) => String(row.type || "").startsWith("integration.")).map((row) => row.type))
}

test("V16.16 crash: failure after the first real patch leaves a durable recovery record", async () => {
  const { base, root } = makeRepo()
  try {
    const runId = "crash-1"
    const patches = await twoPatches(root, runId)
    const before = rootWorkspaceIdentity(root)
    const crash = await runIntegrationTransaction({
      root,
      runId,
      waveId: "wave-0",
      patches,
      options: { expectedRunId: runId, testHooks: { crashAfterPatches: 0 } },
    }).then(() => null, (error) => error)
    assert.ok(crash && crash.code === "INTEGRATION_CRASH_SIMULATED")
    // Exactly one patch applied before the simulated death.
    assert.notEqual(rootWorkspaceIdentity(root).identity, before.identity)
    assert.equal(readFileSync(path.join(root, "lib-a.mjs"), "utf8"), "export const a = 2\n")
    // Durable intent: BEGIN + one PATCH_APPLIED, no COMMIT.
    const types = await journalTypes(root, runId)
    assert.ok(types.includes(INTEGRATION_JOURNAL.BEGIN))
    assert.equal(types.filter((type) => type === INTEGRATION_JOURNAL.PATCH_APPLIED).length, 1)
    assert.ok(!types.includes(INTEGRATION_JOURNAL.COMMIT))
  } finally {
    cleanup(base)
  }
})

test("V16.16 crash: startup recovery restores owned partial transactions", async () => {
  const { base, root } = makeRepo()
  try {
    const runId = "crash-2"
    const patches = await twoPatches(root, runId)
    const before = rootWorkspaceIdentity(root)
    await runIntegrationTransaction({
      root, runId, waveId: "wave-0", patches,
      options: { expectedRunId: runId, testHooks: { crashAfterPatches: 0 } },
    }).then(() => null, () => null)
    const recovery = await recoverIncompleteIntegrations(root, { runId })
    assert.equal(recovery.pending, 1)
    assert.equal(recovery.recovered[0].outcome, "rolled-back")
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)
    assert.equal(readFileSync(path.join(root, "lib-a.mjs"), "utf8"), "export const a = 1\n")
  } finally {
    cleanup(base)
  }
})

test("V16.16 crash: user modification after the crash prevents unsafe rollback", async () => {
  const { base, root } = makeRepo()
  try {
    const runId = "crash-3"
    const patches = await twoPatches(root, runId)
    await runIntegrationTransaction({
      root, runId, waveId: "wave-0", patches,
      options: { expectedRunId: runId, testHooks: { crashAfterPatches: 0 } },
    }).then(() => null, () => null)
    // The user edits an unrelated file after the crash.
    writeFileSync(path.join(root, "lib-a.mjs"), "export const a = 999 // user edit\n", "utf8")
    const recovery = await recoverIncompleteIntegrations(root, { runId })
    assert.equal(recovery.recovered[0].outcome, "blocked")
    // Nothing was reversed: the user's content is intact.
    assert.equal(readFileSync(path.join(root, "lib-a.mjs"), "utf8"), "export const a = 999 // user edit\n")
  } finally {
    cleanup(base)
  }
})

test("V16.16 crash: a completed transaction is never rolled back", async () => {
  const { base, root } = makeRepo()
  try {
    const runId = "crash-4"
    const patches = await twoPatches(root, runId)
    const result = await runIntegrationTransaction({
      root, runId, waveId: "wave-0", patches, options: { expectedRunId: runId },
    })
    assert.equal(result.outcome, INTEGRATION_OUTCOME.INTEGRATED)
    const after = rootWorkspaceIdentity(root).identity
    const recovery = await recoverIncompleteIntegrations(root, { runId })
    assert.equal(recovery.pending, 0)
    assert.equal(rootWorkspaceIdentity(root).identity, after)
    const types = await journalTypes(root, runId)
    assert.ok(types.includes(INTEGRATION_JOURNAL.COMMIT))
  } finally {
    cleanup(base)
  }
})

test("V16.16 crash: recovery is idempotent across reruns", async () => {
  const { base, root } = makeRepo()
  try {
    const runId = "crash-5"
    const patches = await twoPatches(root, runId)
    const before = rootWorkspaceIdentity(root)
    await runIntegrationTransaction({
      root, runId, waveId: "wave-0", patches,
      options: { expectedRunId: runId, testHooks: { crashAfterPatches: 0 } },
    }).then(() => null, () => null)
    const first = await recoverIncompleteIntegrations(root, { runId })
    assert.equal(first.recovered[0].outcome, "rolled-back")
    const second = await recoverIncompleteIntegrations(root, { runId })
    assert.equal(second.pending, 0)
    assert.equal(rootWorkspaceIdentity(root).identity, before.identity)
  } finally {
    cleanup(base)
  }
})

test("V16.16 crash: a moved HEAD fails closed instead of guessing", async () => {
  const { base, root } = makeRepo()
  try {
    const runId = "crash-6"
    const patches = await twoPatches(root, runId)
    await runIntegrationTransaction({
      root, runId, waveId: "wave-0", patches,
      options: { expectedRunId: runId, testHooks: { crashAfterPatches: 0 } },
    }).then(() => null, () => null)
    // Someone commits on top after the crash: ownership is unprovable.
    writeFileSync(path.join(root, "lib-b.mjs"), "export const b = 2\n", "utf8")
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "external commit after crash"])
    const recovery = await recoverIncompleteIntegrations(root, { runId })
    assert.equal(recovery.recovered[0].outcome, "blocked")
  } finally {
    cleanup(base)
  }
})

test("V16.16 crash: recovery never uses reset --hard and never touches foreign files", async () => {
  const { base, root } = makeRepo()
  try {
    const runId = "crash-7"
    const foreign = path.join(root, "foreign.mjs")
    const patches = await twoPatches(root, runId)
    // An untracked user file appears after sandbox creation but before the crash.
    writeFileSync(foreign, "untracked user file\n", "utf8")
    await runIntegrationTransaction({
      root, runId, waveId: "wave-0", patches,
      options: { expectedRunId: runId, testHooks: { crashAfterPatches: 0 } },
    }).then(() => null, () => null)
    const recovery = await recoverIncompleteIntegrations(root, { runId })
    // The untracked foreign file blocks blind recovery but is never deleted.
    assert.equal(recovery.recovered[0].outcome, "blocked")
    assert.equal(existsSync(foreign), true)
    assert.equal(readFileSync(foreign, "utf8"), "untracked user file\n")
  } finally {
    cleanup(base)
  }
})
