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


test("runProcess bounds captured stdout and stderr", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(5000)); process.stderr.write('y'.repeat(5000))"],
    { maxBuffer: 1024, heartbeatMs: 0 },
  )
  assert.equal(result.status, 0)
  assert.ok(result.stdout.length <= 1024)
  assert.ok(result.stderr.length <= 1024)
  assert.ok(result.stdout.endsWith("x"))
  assert.ok(result.stderr.endsWith("y"))
})

// V16.17.1 §17/§18: the shared tail byte buffer accounts BYTES (not JS
// chars) and reports the omitted middle honestly. "đ" is 2 bytes in UTF-8.
test("runProcess output accounting is byte-accurate for multibyte text", async () => {
  const small = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('đ'.repeat(100))"],
    { maxBuffer: 1024, heartbeatMs: 0 },
  )
  assert.equal(small.status, 0)
  assert.equal(small.stdout, "đ".repeat(100))
  assert.equal(small.stdoutTruncated, false)
  assert.equal(small.stdoutOmittedBytes, 0)

  const big = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('đ'.repeat(20000))"],
    { maxBuffer: 8192, heartbeatMs: 0 },
  )
  assert.equal(big.status, 0)
  assert.equal(big.stdoutTruncated, true)
  assert.ok(big.stdoutOmittedBytes > 0, "omitted bytes must be byte-counted")
  assert.ok(
    Buffer.byteLength(big.stdout, "utf8") <= 8192 + 4,
    "rendered tail must stay within the byte budget (plus at most one cut character)",
  )
})

test("createTailByteBuffer keeps the tail and counts omitted bytes exactly", async () => {
  const { createTailByteBuffer } = await import("../lib/process-supervisor.mjs")
  const buffer = createTailByteBuffer(1024)
  buffer.append(Buffer.from("héllo "))
  buffer.append("world")
  assert.equal(buffer.truncated, false)
  assert.equal(buffer.omittedBytes, 0)
  assert.equal(buffer.text(), "héllo world")
  assert.equal(buffer.bytes, Buffer.byteLength("héllo world", "utf8"))

  const capped = createTailByteBuffer(1024)
  capped.append("x".repeat(5000))
  assert.equal(capped.text(), "x".repeat(1024))
  assert.equal(capped.truncated, true)
  assert.equal(capped.omittedBytes, 5000 - 1024)
  assert.equal(capped.bytes, 5000)
})
