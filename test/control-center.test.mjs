import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeControlCenter } from "../lib/control-center.mjs"

test("control center renders durable work and evaluation data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-dashboard-"))
  try {
    const work = path.join(root, ".ues-work", "demo")
    await mkdir(work, { recursive: true })
    await writeFile(path.join(work, "STATE.json"), JSON.stringify({
      status: "executing",
      goal: "Demo goal",
      tasks: { T1: { status: "running", attempts: 1 } },
      blockers: [],
      nextAction: "Continue",
      updatedAt: new Date().toISOString(),
    }))
    await writeFile(path.join(work, "PLAN.json"), JSON.stringify({
      tasks: [{ id: "T1", title: "Task one", risk: "medium" }],
    }))
    await writeFile(path.join(work, "EVIDENCE.json"), JSON.stringify({ receipts: [] }))
    const result = await writeControlCenter(root)
    const html = await readFile(result.file, "utf8")
    assert.match(html, /UES Control Center/)
    assert.match(html, /Demo goal/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
