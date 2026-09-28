import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { captureWorkspaceStateV2, runtimeWorkspaceSnapshot } from "../lib/workspace-fingerprint.mjs"
import { captureWorkspaceHygieneBaseline } from "../lib/workspace-hygiene.mjs"
import { captureInheritedDirtyState } from "../lib/execution-contract.mjs"

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed")
}

test("Unified Workspace Snapshot V2 feeds fingerprint, hygiene and dirty-state consumers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-workspace-state-v2-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.js"), "export const a = 1\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])
    await writeFile(path.join(root, "src", "a.js"), "export const a = 2\n")

    const state = captureWorkspaceStateV2(root)
    const runtime = runtimeWorkspaceSnapshot(root, { workspaceState: state })
    const hygiene = captureWorkspaceHygieneBaseline(root, { workspaceState: state })
    const dirty = captureInheritedDirtyState(root, { workspaceState: state })

    assert.equal(state.schemaVersion, 2)
    assert.equal(runtime.workspaceStateVersion, 2)
    assert.equal(runtime.fingerprint, state.fingerprint)
    assert.deepEqual(runtime.changedFiles, ["src/a.js"])
    assert.deepEqual(hygiene.paths, ["src/a.js"])
    assert.deepEqual(dirty.paths, ["src/a.js"])
    assert.equal(typeof state.statusOutput, "string")
    assert.equal(Array.isArray(state.statusEntries), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
