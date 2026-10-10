import assert from "node:assert/strict"
import test from "node:test"
import {
  PiRpcWorkerPool,
  prepareAgentExecution,
  resolveRpcRunTimeouts,
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

// V16.17 §5 FAIL-CLOSED FENCING ENV: the pool key deliberately excludes the
// spawn env, so a same-key run with a DIFFERENT ownership fence must NOT reuse
// the warm worker. These tests exercise the real pool reuse logic (only the
// process factory is faked): the pool must discard the incompatible worker and
// cold-start, never hand a run another scope's worker.

const FENCE_A = { UES_CHILD_PROCESS: "1", UES_CHILD_EXECUTION_OWNER_TOKEN: "owner-aaa", UES_CHILD_EXECUTION_OWNER_SCOPE: "root\0epoch\0run" }
const FENCE_B = { ...FENCE_A, UES_CHILD_EXECUTION_OWNER_TOKEN: "owner-bbb" }

function poolWithCountingWorkers() {
  const pool = new PiRpcWorkerPool()
  const created = []
  pool.createWorker = (spec) => {
    const worker = fakeWorker()
    worker.stopped = 0
    const stop = worker.stop.bind(worker)
    worker.stop = async () => {
      worker.stopped += 1
      return stop()
    }
    created.push({ spec, worker })
    return worker
  }
  return { pool, created }
}

test("V16.17 §5: same key + identical fencing env reuses one warm worker", async () => {
  const { pool, created } = poolWithCountingWorkers()
  const prepared = prepareAgentExecution({ ...BASE_PARTS, env: FENCE_A })
  await pool.prewarm(prepared.key, prepared.spec)
  const result = await pool.run(prepared.key, prepared.spec, "task", {})
  assert.equal(result.workerReused, true)
  assert.equal(created.length, 1)
  assert.equal(created[0].spec.env.UES_CHILD_EXECUTION_OWNER_TOKEN, "owner-aaa")
})

test("V16.17 §5: same key + DIFFERENT fencing env fails closed (discard + cold start)", async () => {
  const { pool, created } = poolWithCountingWorkers()
  const warm = prepareAgentExecution({ ...BASE_PARTS, env: FENCE_A })
  await pool.prewarm(warm.key, warm.spec)

  const drifted = prepareAgentExecution({ ...BASE_PARTS, env: FENCE_B })
  // The pool key is IDENTICAL (env is excluded from the key) ...
  assert.equal(warm.key, drifted.key)
  // ... but the fencing spec fingerprint differs, so the run must NOT reuse.
  assert.notEqual(warm.specFingerprint, drifted.specFingerprint)

  const result = await pool.run(drifted.key, drifted.spec, "task", {})
  assert.equal(result.workerReused, false)
  // A second worker was cold-started for the drifted fence; the warm one died.
  assert.equal(created.length, 2)
  assert.equal(created[0].worker.dead, true)
  assert.equal(created[0].worker.stopped >= 1, true)
  assert.equal(created[1].spec.env.UES_CHILD_EXECUTION_OWNER_TOKEN, "owner-bbb")
})

test("V16.17 §5: a prewarm with a DIFFERENT fence replaces the incompatible warm worker", async () => {
  const { pool, created } = poolWithCountingWorkers()
  const warm = prepareAgentExecution({ ...BASE_PARTS, env: FENCE_A })
  await pool.prewarm(warm.key, warm.spec)

  const drifted = prepareAgentExecution({ ...BASE_PARTS, env: FENCE_B })
  const second = await pool.prewarm(drifted.key, drifted.spec)
  // Never reported as a no-op reuse of an incompatible worker.
  assert.equal(second.reused, false)
  assert.equal(second.prewarmed, true)
  assert.equal(created.length, 2)
  assert.equal(created[0].worker.dead, true)
  assert.equal(created[1].spec.env.UES_CHILD_EXECUTION_OWNER_TOKEN, "owner-bbb")
})

test("V16.17 §5: the fence fingerprint covers every correctness-sensitive child env key", async () => {
  const { RPC_WORKER_FENCE_ENV_KEYS, rpcWorkerSpecFingerprint } = await import("../lib/pi-rpc-pool.mjs")
  for (const key of [
    "UES_CHILD_EXECUTION_OWNER_TOKEN",
    "UES_CHILD_EXECUTION_OWNER_SCOPE",
    "UES_CHILD_OWNERSHIP_ROOT",
    "UES_CHILD_POLICY_SNAPSHOT_ID",
    "UES_CHILD_RUNTIME_EPOCH_ID",
    "UES_CHILD_RUN_ID",
    "UES_CHILD_JOURNAL_ROOT",
    "UES_CHILD_ROLE",
    "UES_CHILD_WRITER",
  ]) {
    assert.ok(RPC_WORKER_FENCE_ENV_KEYS.includes(key), `fence key missing: ${key}`)
    const a = rpcWorkerSpecFingerprint({ command: "pi", args: [], cwd: "/repo", env: { [key]: "a" } })
    const b = rpcWorkerSpecFingerprint({ command: "pi", args: [], cwd: "/repo", env: { [key]: "b" } })
    assert.notEqual(a, b, `fence key does not affect the fingerprint: ${key}`)
  }
})

// V16.17.1 hardening: the actual timeout resolver consumed by RpcWorker must
// preserve explicit run-deadline caps instead of applying the historical 30s
// minimum a second time.
test("V16.17.1: explicit RPC timeout caps are never inflated", () => {
  assert.equal(resolveRpcRunTimeouts({ hardTimeoutMs: 5_000 }).hardTimeoutMs, 5_000)
  assert.equal(resolveRpcRunTimeouts({ hardTimeoutMs: 1_000 }).hardTimeoutMs, 1_000)
  assert.equal(resolveRpcRunTimeouts({ hardTimeoutMs: 250 }).hardTimeoutMs, 250)
  assert.equal(resolveRpcRunTimeouts({}).hardTimeoutMs, 30 * 60_000)
})

test("V16.17.1: absolute timeout cannot undercut the explicit hard cap", () => {
  const resolved = resolveRpcRunTimeouts({ hardTimeoutMs: 5_000, absoluteHardTimeoutMs: 2_000 })
  assert.equal(resolved.hardTimeoutMs, 5_000)
  assert.equal(resolved.absoluteHardTimeoutMs, 5_000)
})

test("V16.17.1: prune removes worker metadata with the worker", async () => {
  const { pool, created } = poolWithFakeWorkers()
  pool.maxWorkers = 1
  const a = prepareAgentExecution({ ...BASE_PARTS, runId: "run-a" })
  const b = prepareAgentExecution({ ...BASE_PARTS, runId: "run-b" })
  await pool.prewarm(a.key, a.spec)
  created[0].worker.active = false
  await pool.prewarm(b.key, b.spec)
  assert.equal(pool.workers.has(a.key), false)
  assert.equal(pool.workerSpecs.has(a.key), false)
  assert.equal(pool.workers.has(b.key), true)
  assert.equal(pool.workerSpecs.has(b.key), true)
})

test("V16.17.1: run failure removes worker metadata", async () => {
  const pool = new PiRpcWorkerPool()
  pool.createWorker = () => ({
    dead: false,
    active: false,
    runs: 0,
    proc: null,
    async run() { throw new Error("run-failed") },
    async stop() { this.dead = true },
  })
  const prepared = prepareAgentExecution({ ...BASE_PARTS, runId: "run-failure" })
  await assert.rejects(pool.run(prepared.key, prepared.spec, "task", {}), /run-failed/)
  assert.equal(pool.workers.has(prepared.key), false)
  assert.equal(pool.workerSpecs.has(prepared.key), false)
})

test("V16.17.1: prewarm failure removes worker metadata", async () => {
  const pool = new PiRpcWorkerPool()
  pool.createWorker = () => ({
    dead: false,
    active: false,
    runs: 0,
    proc: null,
    async start() { throw new Error("prewarm-failed") },
    async stop() { this.dead = true },
  })
  const prepared = prepareAgentExecution({ ...BASE_PARTS, runId: "prewarm-failure" })
  await assert.rejects(pool.prewarm(prepared.key, prepared.spec), /prewarm-failed/)
  assert.equal(pool.workers.has(prepared.key), false)
  assert.equal(pool.workerSpecs.has(prepared.key), false)
})

test("V16.17.1: discard and stopAll clear worker metadata and reservations", async () => {
  const { pool, created } = poolWithFakeWorkers()
  const a = prepareAgentExecution({ ...BASE_PARTS, runId: "discard-a" })
  const b = prepareAgentExecution({ ...BASE_PARTS, runId: "discard-b" })
  await pool.prewarm(a.key, a.spec)
  created[0].worker.active = false
  await pool.discard(a.key)
  assert.equal(pool.workers.has(a.key), false)
  assert.equal(pool.workerSpecs.has(a.key), false)

  await pool.prewarm(b.key, b.spec)
  pool.reserve("synthetic-reservation")
  await pool.stopAll()
  assert.equal(pool.workers.size, 0)
  assert.equal(pool.workerSpecs.size, 0)
  assert.equal(pool.reservations.size, 0)
})
