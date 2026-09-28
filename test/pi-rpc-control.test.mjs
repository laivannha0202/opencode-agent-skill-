import assert from "node:assert/strict"
import test from "node:test"
import { PiRpcWorkerPool } from "../lib/pi-rpc-pool.mjs"

function fakeWorker(overrides = {}) {
  const calls = []
  return {
    calls,
    dead: false,
    active: true,
    lastActivityAt: 123,
    async steer(message) {
      calls.push(["steer", message])
      return { accepted: true }
    },
    async followUp(message) {
      calls.push(["follow-up", message])
      return { accepted: true }
    },
    async getState() {
      calls.push(["get-state"])
      return { isStreaming: true, thinkingLevel: "low", pendingMessageCount: 0 }
    },
    async clearQueue() {
      calls.push(["clear-queue"])
      return { steering: ["a"], followUp: ["b"] }
    },
    async setModel(provider, modelId) {
      calls.push(["set-model", provider, modelId])
      return { provider, id: modelId }
    },
    async setThinkingLevel(level) {
      calls.push(["set-thinking", level])
      return { level }
    },
    async compact(customInstructions) {
      calls.push(["compact", customInstructions])
      return { compacted: true }
    },
    async waitForIdle(timeoutMs) {
      calls.push(["wait", timeoutMs])
      return { idle: true, state: { isStreaming: false } }
    },
    async abort() {
      calls.push(["abort"])
      return true
    },
    async stop() {},
    ...overrides,
  }
}

test("native RPC session control preserves steer vs follow-up semantics", async () => {
  const pool = new PiRpcWorkerPool()
  const worker = fakeWorker()
  pool.workers.set("only", worker)

  const steer = await pool.steerActive("change direction")
  const follow = await pool.followUpActive("summarize after finishing")

  assert.equal(steer.accepted, true)
  assert.equal(follow.accepted, true)
  assert.deepEqual(worker.calls.slice(0, 2), [
    ["steer", "change direction"],
    ["follow-up", "summarize after finishing"],
  ])
})

test("active control exposes state, model, thinking, queue, compaction and wait", async () => {
  const pool = new PiRpcWorkerPool()
  const worker = fakeWorker()
  pool.workers.set("only", worker)

  assert.equal((await pool.controlActive("get-state")).data.thinkingLevel, "low")
  assert.equal((await pool.controlActive("set-model", { provider: "kilo", modelId: "demo" })).data.id, "demo")
  assert.equal((await pool.controlActive("set-thinking", { level: "high" })).data.level, "high")
  assert.deepEqual((await pool.controlActive("clear-queue")).data.followUp, ["b"])
  assert.equal((await pool.controlActive("compact", { customInstructions: "keep receipts" })).data.compacted, true)
  assert.equal((await pool.controlActive("wait", { timeoutMs: 2000 })).data.idle, true)
})

test("active control fails closed when a deterministic target is unavailable", async () => {
  const pool = new PiRpcWorkerPool()
  assert.equal((await pool.controlActive("get-state")).reason, "no-active-worker")

  pool.workers.set("one", fakeWorker())
  pool.workers.set("two", fakeWorker())
  const result = await pool.controlActive("get-state")
  assert.equal(result.ok, false)
  assert.equal(result.reason, "multiple-active-workers")
  assert.equal(result.active, 2)
})


test("same-session recovery fails closed without a reusable RPC worker", async () => {
  const pool = new PiRpcWorkerPool()
  await assert.rejects(
    pool.run(
      "missing",
      { command: process.execPath, args: ["-e", ""], cwd: process.cwd(), env: process.env },
      "continue",
      { reuseSession: true },
    ),
    /same-session resume unavailable/i,
  )
})

test("same-session recovery reuses an existing worker instead of allocating a new one", async () => {
  const pool = new PiRpcWorkerPool()
  const calls = []
  const worker = fakeWorker({
    active: false,
    runs: 1,
    async run(message, options) {
      calls.push([message, options.reuseSession])
      return { message: { role: "assistant", content: "ok" }, toolCalls: 0, toolNames: [] }
    },
  })
  pool.workers.set("reuse", worker)

  const result = await pool.run(
    "reuse",
    { command: "unused", args: [], cwd: process.cwd(), env: process.env },
    "continue",
    { reuseSession: true },
  )

  assert.equal(result.workerReused, true)
  assert.deepEqual(calls, [["continue", true]])
})
