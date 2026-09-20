import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { appendRuntimeEvent, readRuntimeEvents } from "../lib/runtime-events.mjs"

test("runtime event journal is append-only and bounded on read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-events-"))
  const file = path.join(root, "EVENTS.jsonl")
  try {
    await appendRuntimeEvent(file, "task.started", { task: "T1" })
    await appendRuntimeEvent(file, "task.completed", { task: "T1" })
    const all = await readRuntimeEvents(file)
    assert.deepEqual(all.map((item) => item.type), ["task.started", "task.completed"])
    const last = await readRuntimeEvents(file, { limit: 1 })
    assert.equal(last.length, 1)
    assert.equal(last[0].type, "task.completed")
    const malformed = await readRuntimeEvents(file, { limit: Number.NaN })
    assert.equal(malformed.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
