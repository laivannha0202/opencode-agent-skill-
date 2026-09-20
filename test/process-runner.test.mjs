import test from "node:test"
import assert from "node:assert/strict"
import { runProcess } from "../lib/process-runner.mjs"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("runProcess captures output and exit status", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
    timeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    heartbeatMs: 0,
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "ok")
  assert.equal(result.timedOut, false)
})

test("runProcess enforces a hard timeout", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], {
    timeoutMs: 100,
    heartbeatMs: 0,
  })
  assert.equal(result.timedOut, true)
  assert.notEqual(result.status, 0)
})


test("runProcess enforces an idle timeout", async () => {
  const result = await runProcess(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], {
    idleTimeoutMs: 100,
    heartbeatMs: 0,
  })
  assert.equal(result.idleTimedOut, true)
  assert.notEqual(result.status, 0)
})

test("runProcess honors AbortSignal cancellation", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 50)
  const result = await runProcess(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], {
    signal: controller.signal,
    heartbeatMs: 0,
  })
  assert.equal(result.aborted, true)
  assert.notEqual(result.status, 0)
})

test("runProcess bounds captured output", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], {
    maxBuffer: 1024,
    heartbeatMs: 0,
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.length, 1024)
})


test("runProcess kills descendant processes on timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-process-tree-"))
  const sentinel = path.join(root, "grandchild-survived.txt")
  const grandchildCode = [
    "const fs=require('node:fs')",
    "const file=process.argv[1]",
    "setTimeout(()=>fs.writeFileSync(file,'survived'),1200)",
    "setTimeout(()=>{},5000)",
  ].join(";")
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    "spawn(process.execPath,['-e'," + JSON.stringify(grandchildCode) + "," + JSON.stringify(sentinel) + "],{stdio:'ignore'})",
    "setTimeout(()=>{},5000)",
  ].join(";")

  try {
    const result = await runProcess(process.execPath, ["-e", parentCode], {
      timeoutMs: 150,
      heartbeatMs: 0,
    })
    assert.equal(result.timedOut, true)
    assert.notEqual(result.status, 0)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(existsSync(sentinel), false, "grandchild survived process-tree cancellation")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("runProcess escalates SIGTERM-resistant children", { skip: process.platform === "win32" }, async () => {
  const started = Date.now()
  const result = await runProcess(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
    {
      timeoutMs: 120,
      killGraceMs: 120,
      heartbeatMs: 0,
    },
  )
  assert.equal(result.timedOut, true)
  assert.notEqual(result.status, 0)
  assert.ok(Date.now() - started < 2500, "timeout escalation did not terminate the process promptly")
})


test("runProcess reports cancellation as nonzero even when child exits cleanly", { skip: process.platform === "win32" }, async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 80)
  const result = await runProcess(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)"],
    { signal: controller.signal, heartbeatMs: 0, killGraceMs: 100 },
  )
  assert.equal(result.aborted, true)
  assert.notEqual(result.status, 0)
})
