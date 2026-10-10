// V16.17.1 structured execution deadline/context bridge regression coverage.
import assert from "node:assert/strict"
import test from "node:test"

import {
  PiRpcWorkerPool,
  prepareAgentExecution,
  resolveRpcRunTimeouts,
} from "../lib/pi-rpc-pool.mjs"
import { createRunBudgetLedger } from "../lib/run-budget-ledger-v16-17.mjs"
import {
  LAZY_RUNTIME_MODULES,
  hydrateRuntimeModule,
  resetLazyRuntimeForTests,
} from "../lib/lazy-runtime.mjs"
import {
  clearStructuredExecutionMeter,
  recordStructuredContextMeasurement,
  registerStructuredRunDeadline,
  resolveStructuredRunDeadline,
  structuredExecutionMeterStatus,
} from "../lib/structured-execution-meter-v16-17.mjs"

const BASE = {
  agent: "ues-executor",
  cwd: "/repo",
  command: "pi",
  args: ["--mode", "rpc"],
  compactToolOutput: true,
  toolOutputLimit: 8192,
  verificationTimeoutSec: 300,
  toolTimeoutMs: 60_000,
  allowLocalEnvWrite: false,
  policySnapshotId: "policy",
  runtimeEpochId: "epoch",
  journalRoot: "/repo",
  model: "demo",
  thinking: "low",
  systemPromptHash: "prompt",
}

test("V16.17.1 absolute run deadline can tighten but never extend", () => {
  const runId = `deadline-${Date.now()}-${Math.random()}`
  const first = Date.now() + 10_000
  const tighter = first - 2_000
  const looser = first + 20_000
  registerStructuredRunDeadline({ runId, deadlineAt: first })
  assert.equal(resolveStructuredRunDeadline(runId), first)
  registerStructuredRunDeadline({ runId, deadlineAt: looser })
  assert.equal(resolveStructuredRunDeadline(runId), first)
  registerStructuredRunDeadline({ runId, deadlineAt: tighter })
  assert.equal(resolveStructuredRunDeadline(runId), tighter)
  clearStructuredExecutionMeter(runId)
})

test("V16.17.1 real RPC resolver applies absolute run deadline after ordinary policy", () => {
  const now = 1_000_000
  const noDeadline = resolveRpcRunTimeouts({ hardTimeoutMs: 60_000 }, now)
  assert.equal(noDeadline.hardTimeoutMs, 60_000)
  assert.equal(noDeadline.runDeadlineBound, false)

  const bounded = resolveRpcRunTimeouts({ hardTimeoutMs: 60_000, absoluteHardTimeoutMs: 120_000, runDeadlineAtMs: now + 5_000 }, now)
  assert.equal(bounded.hardTimeoutMs, 5_000)
  assert.equal(bounded.absoluteHardTimeoutMs, 5_000)
  assert.equal(bounded.runDeadlineBound, true)
  assert.equal(bounded.deadlineExhausted, false)

  const expired = resolveRpcRunTimeouts({ hardTimeoutMs: 60_000, runDeadlineAtMs: now - 1 }, now)
  assert.equal(expired.hardTimeoutMs, 1)
  assert.equal(expired.deadlineExhausted, true)
})

test("V16.17.1 pool threads the ledger absolute deadline into the real worker run boundary", async () => {
  const runId = `pool-${Date.now()}-${Math.random()}`
  const startedAt = Date.now()
  const ledger = createRunBudgetLedger({ runId, runStartedAt: startedAt, runWallClockMs: 5_000 })
  const deadlineAt = ledger.snapshot().runDeadlineAt
  let capturedOptions = null

  const pool = new PiRpcWorkerPool({
    createWorker: () => ({
      dead: false,
      active: false,
      runs: 0,
      proc: null,
      async run(_message, options) {
        this.runs += 1
        capturedOptions = options
        return { message: { role: "assistant", content: "ok" }, toolCalls: 0, toolNames: [] }
      },
      async stop() { this.dead = true },
    }),
  })

  const prepared = prepareAgentExecution({
    ...BASE,
    runId,
    env: { UES_CHILD_PROCESS: "1", UES_CHILD_RUN_ID: runId },
  })
  await pool.run(prepared.key, prepared.spec, "task", { hardTimeoutMs: 60_000 })
  assert.equal(capturedOptions.runDeadlineAtMs, deadlineAt)
  await pool.stopAll()
  clearStructuredExecutionMeter(runId)
})

test("V16.17.1 measured context bridge settles chars without inventing provider tokens", () => {
  const runId = `context-${Date.now()}-${Math.random()}`
  const ledger = createRunBudgetLedger({ runId })
  recordStructuredContextMeasurement({
    runId,
    waveId: "wave-1",
    snapshotId: "snapshot-1",
    chars: 1234,
    provenance: "MEASURED",
  })
  const snapshot = ledger.settle({ childTurns: 1, totalTokens: null })
  assert.equal(snapshot.spent.childContextChars, 1234)
  assert.equal(snapshot.contextCharsMeasured, true)
  assert.equal(snapshot.contextCharProvenance, "MEASURED")
  assert.equal(snapshot.totalTokens, null)
  assert.equal(snapshot.tokensMeasured, false)
  assert.equal(snapshot.tokenProvenance, "NOT_MEASURED")
  clearStructuredExecutionMeter(runId)
})

test("V16.17.1 production lazy parallel runtime records canonical measured wave chars", async () => {
  const runId = `wave-${Date.now()}-${Math.random()}`
  clearStructuredExecutionMeter(runId)
  resetLazyRuntimeForTests()
  const runtime = await hydrateRuntimeModule(LAZY_RUNTIME_MODULES.PARALLEL_CODING_RUNTIME)
  const ledger = createRunBudgetLedger({ runId })
  const snapshot = runtime.buildWaveSnapshot({
    waveId: "wave-1",
    goal: "edit one bounded file",
    constraints: ["local verifier owns PASS"],
    workspaceGeneration: runId,
  }).snapshot
  const delta = runtime.buildChildDelta({
    snapshot,
    child: {
      childId: "child-1",
      taskId: "task-1",
      goal: "edit file",
      writeFiles: ["lib/example.mjs"],
      acceptance: ["focused proof"],
    },
  })
  const accounting = runtime.waveAccounting({ snapshot, deltas: [delta] })
  const settled = ledger.settle({ childTurns: 1, totalTokens: null })
  assert.equal(settled.spent.childContextChars, accounting.totalWaveChars.value)
  assert.equal(settled.contextCharsMeasured, true)
  assert.equal(settled.tokenProvenance, "NOT_MEASURED")
  assert.equal(settled.totalTokens, null)
  clearStructuredExecutionMeter(runId)
})

test("V16.17.1 meter is bounded and exposes no token claim", () => {
  const status = structuredExecutionMeterStatus()
  assert.equal(status.maxRuns, 64)
  assert.ok(status.deadlines <= 64)
  assert.ok(status.pendingContext <= 64)
})
