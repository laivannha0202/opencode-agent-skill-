import assert from "node:assert/strict"
import test from "node:test"
import {
  PiRpcWorkerPool,
  prepareAgentExecution,
  sameExecution,
  PREPARED_EXECUTION_POLICY,
} from "../lib/pi-rpc-pool.mjs"

// V16.17 §1 Prepared Agent Execution: PREPARE ONCE → PREWARM + RUN consume the
// SAME descriptor. These tests fail if prewarm and run ever assemble key/spec
// pairs independently again.

const BASE_PARTS = {
  agent: "ues-executor",
  cwd: "/repo",
  command: "pi",
  args: ["--mode", "rpc", "--model", "demo-model", "--tools", "ues_code"],
  compactToolOutput: true,
  toolOutputLimit: 8192,
  verificationTimeoutSec: 300,
  toolTimeoutMs: 60_000,
  allowLocalEnvWrite: false,
  policySnapshotId: "policy-1",
  runtimeEpochId: "epoch-1",
  runId: "run-1",
  journalRoot: "/repo",
  model: "demo-model",
  thinking: "low",
  systemPromptHash: "aaaabbbbccccdddd",
}

function fakeWorker() {
  return {
    dead: false,
    active: false,
    runs: 0,
    proc: {},
    lastActivityAt: Date.now(),
    async start() {
      this.active = true
    },
    async run(message) {
      this.runs += 1
      this.active = true
      return { message: { role: "assistant", content: String(message) }, toolCalls: 0, toolNames: [] }
    },
    async stop() {
      this.dead = true
      this.active = false
    },
  }
}

function poolWithFakeWorkers() {
  const pool = new PiRpcWorkerPool()
  const created = []
  pool.createWorker = (spec) => {
    const worker = fakeWorker()
    created.push({ spec, worker })
    return worker
  }
  return { pool, created }
}

test("prepare once: prewarm and run consume the same descriptor and reuse one warm worker", async () => {
  const { pool, created } = poolWithFakeWorkers()
  const prepared = prepareAgentExecution(BASE_PARTS)

  const pre = await pool.prewarm(prepared.key, prepared.spec)
  assert.equal(pre.prewarmed, true)

  const result = await pool.run(prepared.key, prepared.spec, "implement the task", {})
  assert.equal(result.workerReused, true)
  // Exactly one worker process for the whole prepare→prewarm→run chain.
  assert.equal(created.length, 1)
  assert.equal(created[0].spec.command, "pi")
})

test("prepared descriptor is immutable and carries its fencing dimensions", () => {
  const prepared = prepareAgentExecution(BASE_PARTS)
  assert.equal(prepared.policy, PREPARED_EXECUTION_POLICY)
  assert.equal(prepared.model, "demo-model")
  assert.equal(prepared.thinking, "low")
  assert.equal(prepared.systemPromptHash, "aaaabbbbccccdddd")
  assert.equal(prepared.policySnapshotId, "policy-1")
  assert.equal(prepared.canProduceVerdict, false)
  assert.ok(Object.isFrozen(prepared))
  assert.ok(Object.isFrozen(prepared.spec))
})

test("changing the policy snapshot invalidates the worker key", () => {
  const a = prepareAgentExecution(BASE_PARTS)
  const b = prepareAgentExecution({ ...BASE_PARTS, policySnapshotId: "policy-2" })
  assert.notEqual(a.key, b.key)
  assert.equal(sameExecution(a, b), false)
})

test("changing the system prompt invalidates compatibility even when the key matches", () => {
  const a = prepareAgentExecution(BASE_PARTS)
  const b = prepareAgentExecution({ ...BASE_PARTS, systemPromptHash: "zzzzyyyyxxxxwwww" })
  // The prompt hash travels in the descriptor, not the pool key: the pool
  // alone cannot see the change, so the descriptor compatibility question
  // must refuse it.
  assert.equal(a.key, b.key)
  assert.equal(sameExecution(a, b), false)
})

test("changing the model invalidates compatibility", () => {
  const a = prepareAgentExecution(BASE_PARTS)
  const b = prepareAgentExecution({ ...BASE_PARTS, model: "other-model" })
  assert.equal(sameExecution(a, b), false)
})

test("changing only ordinary task text keeps the descriptor (task travels as the message)", () => {
  const a = prepareAgentExecution(BASE_PARTS)
  const b = prepareAgentExecution(BASE_PARTS)
  assert.equal(a.key, b.key)
  assert.equal(sameExecution(a, b), true)
})

test("an incompatible prewarm is discarded and never counted as a warm reuse", async () => {
  const { pool } = poolWithFakeWorkers()
  const prewarmed = prepareAgentExecution(BASE_PARTS)
  await pool.prewarm(prewarmed.key, prewarmed.spec)

  const drifted = prepareAgentExecution({ ...BASE_PARTS, policySnapshotId: "policy-2" })
  assert.equal(sameExecution(prewarmed, drifted), false)
  const result = await pool.run(drifted.key, drifted.spec, "task", {})
  assert.equal(result.workerReused, false)

  const discard = await pool.discard(prewarmed.key)
  assert.equal(discard.discarded, true)
  assert.equal(pool.workers.has(prewarmed.key), false)
})
