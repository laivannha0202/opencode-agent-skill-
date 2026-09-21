import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { addDecision, initWork, workPaths } from "../lib/task-engine.mjs"

test("stale state lock is taken over without leaving an orphan lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-state-lock-"))
  try {
    await initWork(root, "lock-safe", "Exercise stale lock recovery")
    const paths = workPaths(root, "lock-safe")
    await mkdir(paths.lock)
    const ownerFile = path.join(paths.lock, "owner.json")
    await writeFile(ownerFile, JSON.stringify({
      pid: 999999,
      token: "stale-owner",
      at: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    }) + "\n")
    const stale = new Date(Date.now() - 10 * 60_000)
    await utimes(ownerFile, stale, stale)
    await utimes(paths.lock, stale, stale)

    const state = await addDecision(root, "lock-safe", "state lock takeover succeeded")
    assert.equal(existsSync(paths.lock), false)
    assert.ok(
      state.decisions.some((item) => item.text === "state lock takeover succeeded"),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
