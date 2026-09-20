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
