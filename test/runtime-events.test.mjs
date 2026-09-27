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


test("V15.12 runtime event journal compacts before unbounded growth", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-events-compact-"))
  const file = path.join(root, "EVENTS.jsonl")
  const previous = process.env.UES_EVENT_LOG_MAX_BYTES
  process.env.UES_EVENT_LOG_MAX_BYTES = String(256 * 1024)
  try {
    const payload = "x".repeat(12 * 1024)
    for (let i = 0; i < 40; i += 1) {
      await appendRuntimeEvent(file, "task.progress", { index: i, payload })
    }
    const recent = await readRuntimeEvents(file, { limit: 5000 })
    assert.ok(recent.length < 40)
    assert.ok(recent.some((item) => item.type === "runtime-events.compacted"))
    assert.equal(recent.at(-1)?.type, "task.progress")
  } finally {
    if (previous === undefined) delete process.env.UES_EVENT_LOG_MAX_BYTES
    else process.env.UES_EVENT_LOG_MAX_BYTES = previous
    await rm(root, { recursive: true, force: true })
  }
})
