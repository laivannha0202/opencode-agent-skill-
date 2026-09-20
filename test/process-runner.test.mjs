import test from "node:test"
import assert from "node:assert/strict"
import { runProcess } from "../lib/process-runner.mjs"

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
