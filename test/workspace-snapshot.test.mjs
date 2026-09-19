import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { snapshotWorkspace, diffWorkspaceSnapshots } from "../lib/workspace-snapshot.mjs"

test("workspace snapshot reports added, removed and modified files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ues-snapshot-"))
  try {
    await mkdir(path.join(temp, "src"), { recursive: true })
    await writeFile(path.join(temp, "src", "a.js"), "a")
    await writeFile(path.join(temp, "src", "remove.js"), "x")
    const before = await snapshotWorkspace(temp)

    await writeFile(path.join(temp, "src", "a.js"), "changed")
    await rm(path.join(temp, "src", "remove.js"))
    await writeFile(path.join(temp, "src", "new.js"), "new")
    const after = await snapshotWorkspace(temp)

    assert.deepEqual(diffWorkspaceSnapshots(before, after), [
      { path: path.join("src", "a.js"), change: "modified" },
      { path: path.join("src", "new.js"), change: "added" },
      { path: path.join("src", "remove.js"), change: "removed" },
    ])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
