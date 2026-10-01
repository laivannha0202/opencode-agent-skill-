import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { ToolScheduler } from "../lib/tool-scheduler.mjs"
import { buildRuntimeEpoch, runtimeEpochCompatibility } from "../lib/runtime-epoch.mjs"
import { MODEL_RUNTIME_SURFACE, applyModelToolBudget, modelRuntimeProfile } from "../lib/model-runtime-profile.mjs"
import { RuntimeHookBus } from "../lib/runtime-hooks.mjs"
import {
  appendRunJournalEvent,
  createRunJournal,
  readRunJournal,
  recoverRunJournal,
  summarizeRunJournalRows,
} from "../lib/run-journal.mjs"
import { adaptiveCompactionBudgetFromSummary } from "../lib/adaptive-compaction.mjs"
import {
  createWriteCheckpoint,
  finalizeWriteCheckpoint,
  listWriteCheckpoints,
  rollbackWriteCheckpoint,
} from "../lib/write-checkpoints.mjs"
import {
  finalizeRunArtifacts,
  initializeRunArtifacts,
  listRunArtifacts,
} from "../lib/run-artifacts.mjs"
import { compareRunInspections, inspectRun } from "../lib/run-inspector.mjs"

test("V15.6 runtime epochs are deterministic and fence incompatible warm reuse", () => {
  const input = {
    policySnapshotId: "policy:sha256:abc",
    workspaceFingerprint: "workspace-1",
    context: "fix src/a.ts",
    tools: ["read", "edit"],
    skills: ["typescript"],
    modelProfile: { surface: "compact", maxAdvertisedTools: 10 },
    model: "kilo/stepfun/step-3.7-flash:free",
    thinking: "low",
  }
  const left = buildRuntimeEpoch(input)
  const right = buildRuntimeEpoch({ ...input, tools: ["edit", "read"] })
  assert.equal(left.id, right.id)
  assert.match(left.id, /^epoch:sha256:[0-9a-f]{64}$/)
  const changed = buildRuntimeEpoch({ ...input, context: "fix src/b.ts" })
  const compatibility = runtimeEpochCompatibility(left, changed)
  assert.equal(compatibility.compatible, false)
  assert.ok(compatibility.reasons.includes("contextSnapshotId-changed"))

  const skillChanged = buildRuntimeEpoch({ ...input, skills: ["typescript", "test-verification"] })
  const skillCompatibility = runtimeEpochCompatibility(left, skillChanged)
  assert.equal(skillCompatibility.compatible, false)
  assert.ok(skillCompatibility.reasons.includes("skillSurfaceHash-changed"))
})

test("V15.6 compact model profiles reduce tool-choice noise without lowering thinking", () => {
  const compact = modelRuntimeProfile("kilo/stepfun/step-3.7-flash:free", {
    role: "executor",
    executionProfile: "deep",
    attempt: 2,
  })
  assert.equal(compact.surface, MODEL_RUNTIME_SURFACE.COMPACT)
  assert.equal(compact.preservesThinkingLevel, true)
  assert.equal(compact.editPipeline, "architect-editor")
  assert.equal(compact.contextBudgetRatio, 1)
  assert.equal(compact.contextBudgetPolicy, "measurement-gated")
  const tools = Array.from({ length: 20 }, (_, index) => "tool_" + index)
  tools.push("ues_code")
  const selected = applyModelToolBudget(tools, compact, ["ues_code"])
  assert.equal(selected.length, compact.maxAdvertisedTools)
  assert.equal(selected[0], "ues_code")
})

test("V15.6 tool scheduler runs bounded reads together and serializes writes", async () => {
  const scheduler = new ToolScheduler({ maxParallelReads: 2, maxQueueMs: 2_000 })
  const readA = await scheduler.acquire("read-a", "read", { path: "src/a.ts" })
  const readB = await scheduler.acquire("read-b", "grep", { pattern: "value" })
  assert.equal(scheduler.snapshot().active.length, 2)

  let writeStarted = false
  const writePromise = scheduler.acquire("write-a", "edit", { path: "src/a.ts" }).then((lease) => {
    writeStarted = true
    return lease
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(writeStarted, false)

  readA.release()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(writeStarted, false)
  readB.release()
  const write = await writePromise
  assert.equal(write.contract.parallelSafe, false)
  assert.equal(scheduler.snapshot().active.length, 1)

  let unknownStarted = false
  const unknownPromise = scheduler.acquire("unknown", "custom_mutation", {}).then((lease) => {
    unknownStarted = true
    return lease
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(unknownStarted, false)
  write.release()
  const unknown = await unknownPromise
  assert.equal(unknown.contract.parallelSafe, false)
  unknown.release()
  assert.equal(scheduler.snapshot().metrics.released, 4)
})

test("V15.6 preflight admission never waits behind sibling tools", async () => {
  const scheduler = new ToolScheduler({ maxParallelReads: 2, maxQueueMs: 2_000 })
  const readA = scheduler.tryAcquire("read-a", "read", { path: "src/a.ts" })
  const readB = scheduler.tryAcquire("read-b", "grep", { pattern: "value" })
  assert.ok(readA)
  assert.ok(readB)
  const blockedWrite = scheduler.tryAcquire("write-a", "edit", { path: "src/a.ts" })
  assert.equal(blockedWrite, null)
  assert.equal(scheduler.snapshot().queued.length, 0)
  readA.release()
  readB.release()

  const evidence = scheduler.tryAcquire("evidence", "ues_evidence_get", { ref: "sha256:abc" })
  assert.ok(evidence)
  assert.equal(evidence.contract.parallelSafe, true)
  evidence.release()
})

test("V15.6 durable journal admission is idempotent and crash recovery never replays side effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v156-journal-"))
  try {
    const input = {
      runId: "run-1",
      taskHash: "task-hash",
      workspaceFingerprint: "workspace",
      executionProfile: "standard",
      risk: "medium",
    }
    const [first, second] = await Promise.all([
      createRunJournal(root, input),
      createRunJournal(root, input),
    ])
    assert.equal([first, second].filter((row) => row.admitted === true).length, 1)
    assert.equal([first, second].filter((row) => row.idempotent === true).length, 1)

    await appendRunJournalEvent(root, "run-1", "tool.started", {
      toolCallId: "tool-1",
      tool: "edit",
    })
    const recovered = await recoverRunJournal(root, "run-1")
    assert.deepEqual(recovered.interruptedToolCalls, ["tool-1"])
    assert.equal(recovered.replayedSideEffects, false)
    assert.equal(recovered.summary.danglingToolCalls.length, 0)

    const rows = await readRunJournal(root, "run-1")
    const summary = summarizeRunJournalRows(rows)
    assert.ok(summary.events >= 3)
    const interrupted = rows.find((row) => row.type === "tool.interrupted")
    assert.equal(interrupted.replayed, false)

    await assert.rejects(
      createRunJournal(root, { ...input, taskHash: "different" }),
      /idempotency conflict/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.6 adaptive compaction preserves more only after measured recall demand", () => {
  const high = adaptiveCompactionBudgetFromSummary({
    byReducer: {
      tsc: { compacted: 10, recalled: 5, recallDemandRate: 0.5 },
    },
  }, "npx tsc --noEmit", 24 * 1024)
  assert.equal(high.multiplier, 1.5)
  assert.ok(high.maxChars > high.baseMaxChars)

  const low = adaptiveCompactionBudgetFromSummary({
    byReducer: {
      tsc: { compacted: 20, recalled: 0, recallDemandRate: 0 },
    },
  }, "npx tsc --noEmit", 24 * 1024)
  assert.equal(low.multiplier, 0.75)
  assert.ok(low.maxChars < low.baseMaxChars)

  const cold = adaptiveCompactionBudgetFromSummary({ byReducer: {} }, "npx tsc", 24 * 1024)
  assert.equal(cold.multiplier, 1)
})

test("V15.6 hook bus supports deterministic modify and fail-closed critical deny", async () => {
  const bus = new RuntimeHookBus()
  bus.on("tool.before", async () => ({ decision: "modify", patch: { timeoutMs: 1234 } }), {
    name: "bounded-timeout",
    priority: 10,
  })
  bus.on("tool.before", async (payload) => {
    if (payload.toolName === "danger") return { decision: "deny", reason: "blocked-risk" }
    return { decision: "observe" }
  }, { name: "risk-gate", priority: 5, critical: true })

  const allowed = await bus.emit("tool.before", { toolName: "read" })
  assert.equal(allowed.decision, "modify")
  assert.equal(allowed.payload.timeoutMs, 1234)

  const denied = await bus.emit("tool.before", { toolName: "danger" })
  assert.equal(denied.decision, "deny")
  assert.equal(denied.reason, "blocked-risk")
})

test("V15.6 bounded write checkpoints restore exact bytes and refuse diverged rollback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v156-checkpoint-"))
  try {
    const file = path.join(root, "a.txt")
    await writeFile(file, "before\n")

    const checkpoint = await createWriteCheckpoint(root, {
      runId: "run",
      toolCallId: "tool-1",
      tool: "edit",
      files: ["a.txt"],
    })
    await writeFile(file, "after\n")
    await finalizeWriteCheckpoint(root, "run", checkpoint.checkpointId)
    const listed = await listWriteCheckpoints(root, { runId: "run" })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].checkpointId, checkpoint.checkpointId)
    assert.equal("beforeBase64" in listed[0], false)
    assert.equal("beforeBase64" in listed[0].files[0], false)
    const restored = await rollbackWriteCheckpoint(root, "run", checkpoint.checkpointId)
    assert.equal(restored.restored, true)
    assert.equal(await readFile(file, "utf8"), "before\n")

    const checkpoint2 = await createWriteCheckpoint(root, {
      runId: "run",
      toolCallId: "tool-2",
      tool: "edit",
      files: ["a.txt"],
    })
    await writeFile(file, "candidate\n")
    await finalizeWriteCheckpoint(root, "run", checkpoint2.checkpointId)
    await writeFile(file, "user-diverged\n")
    const refused = await rollbackWriteCheckpoint(root, "run", checkpoint2.checkpointId)
    assert.equal(refused.restored, false)
    assert.equal(refused.reason, "workspace-diverged")
    assert.equal(await readFile(file, "utf8"), "user-diverged\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.6 checkpoints never follow symlink paths during capture or rollback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v156-checkpoint-link-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "ues-v156-checkpoint-outside-"))
  try {
    const outsideFile = path.join(outside, "outside.txt")
    await writeFile(outsideFile, "outside-before\n")
    const link = path.join(root, "linked.txt")
    try {
      const { symlink } = await import("node:fs/promises")
      await symlink(outsideFile, link, "file")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(String(error?.code || ""))) {
        t.skip("symlink creation is unavailable on this host")
        return
      }
      throw error
    }

    const checkpoint = await createWriteCheckpoint(root, {
      runId: "run-link",
      toolCallId: "tool-link",
      tool: "edit",
      files: ["linked.txt"],
    })
    assert.equal(checkpoint.files[0].captured, false)
    assert.equal(checkpoint.files[0].reason, "symlink-traversal")
    await writeFile(outsideFile, "outside-after\n")
    const finalized = await finalizeWriteCheckpoint(root, "run-link", checkpoint.checkpointId)
    assert.equal(finalized.files[0].restorable, false)
    const restored = await rollbackWriteCheckpoint(root, "run-link", checkpoint.checkpointId)
    assert.equal(restored.restored, true)
    assert.deepEqual(restored.files, [])
    assert.equal(await readFile(outsideFile, "utf8"), "outside-after\n")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("V15.6 run artifacts and inspector keep bounded operator-visible evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v156-artifacts-"))
  try {
    await createRunJournal(root, {
      runId: "inspect-1",
      taskHash: "hash",
      workspaceFingerprint: "workspace",
    })
    await appendRunJournalEvent(root, "inspect-1", "tool.started", {
      toolCallId: "r1",
      tool: "read",
      inputHash: "same",
      queuedMs: 4,
    })
    await appendRunJournalEvent(root, "inspect-1", "tool.completed", {
      toolCallId: "r1",
      tool: "read",
    })
    await appendRunJournalEvent(root, "inspect-1", "tool.started", {
      toolCallId: "r2",
      tool: "read",
      inputHash: "same",
      queuedMs: 1200,
    })
    await appendRunJournalEvent(root, "inspect-1", "tool.completed", {
      toolCallId: "r2",
      tool: "read",
    })
    await initializeRunArtifacts(root, {
      runId: "inspect-1",
      taskHash: "hash",
      workspaceFingerprint: "workspace",
    })
    await finalizeRunArtifacts(root, "inspect-1", {
      passed: true,
      verdict: "PASS",
      durationMs: 42,
      telemetry: { queueMs: 1204 },
      verification: { final: "PASS" },
      summary: "Verified run.",
    })
    const names = await listRunArtifacts(root, "inspect-1")
    assert.deepEqual(names, ["RUN.json", "SUMMARY.md", "TELEMETRY.json", "VERIFICATION.json"])

    const inspected = await inspectRun(root, "inspect-1")
    assert.equal(inspected.summary.danglingToolCalls.length, 0)
    assert.equal(inspected.duplicateToolSignatures.length, 1)
    assert.ok(inspected.findings.some((row) => row.kind === "tool-queue-delay"))

    const comparison = compareRunInspections(
      { runId: "a", summary: { events: 2 }, totalToolQueueMs: 20, maxToolQueueMs: 20, duplicateToolSignatures: [] },
      inspected,
    )
    assert.equal(comparison.rightRunId, "inspect-1")
    assert.ok(comparison.deltas.events > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
