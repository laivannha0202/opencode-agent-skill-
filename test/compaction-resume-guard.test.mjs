import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildCompactionResumeGuard, renderCompactionResumeGuard } from "../lib/compaction-resume-guard.mjs"
import { putEvidence } from "../lib/evidence-store.mjs"

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}

test("durable compaction guard rebuilds state from contract, phase and receipt artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-resume-guard-"))
  try {
    const dir = path.join(root, ".ues-work", "demo")
    const durable = await putEvidence(root, "resume-critical evidence", {
      kind: "durable-task-evidence",
      source: "task-1",
    })
    await json(path.join(dir, "STATE.json"), {
      schemaVersion: 4,
      status: "executing",
      goal: "upgrade runtime",
      updatedAt: "2026-09-28T00:00:00.000Z",
      planHash: "plan-hash",
      planApproved: true,
      nextAction: "Continue task-1",
      checkpoint: {
        id: "cp-1",
        currentTaskId: "task-1",
        runId: "run-1",
        workspaceFingerprint: "ws-1",
        nextAction: { type: "continue-task", taskId: "task-1" },
        evidencePointers: [{ kind: "context", refs: [durable.ref] }],
      },
      tasks: {
        "task-1": { status: "running", attempts: 1, runId: "run-1" },
      },
    })
    await json(path.join(dir, "PLAN.json"), {
      tasks: [{ id: "task-1", title: "Implement", dependsOn: [] }],
    })
    await json(path.join(dir, "EVIDENCE.json"), {
      receipts: [{ id: "receipt-1", task: "task-1", runId: "run-1", passed: true, command: "node --test" }],
      gateReceipts: [{ id: "gate-1", kind: "plan-verification", verdict: "PASS" }],
    })
    await json(path.join(dir, "EXECUTION_CONTRACT.json"), {
      schemaVersion: 1,
      taskHash: "task-hash",
      gates: { source: true, runtime: true },
      phases: [{ number: 1 }],
    })
    await json(path.join(dir, "phases", "MANIFEST.json"), {
      artifacts: ["phases/phase-01-implement.json"],
    })
    await json(path.join(dir, "phases", "phase-01-implement.json"), {
      phase: 1,
      title: "Implement",
      sourceBodyHash: "body-hash",
      status: "PENDING",
      evidence: [],
    })

    const packet = await buildCompactionResumeGuard(root, { reason: "threshold" })
    assert.equal(packet.modelSummaryTrustedForDurableState, false)
    assert.equal(packet.workspaceCount, 1)
    assert.equal(packet.workspaces[0].state.checkpoint.runId, "run-1")
    assert.equal(packet.workspaces[0].receipts[0].id, "receipt-1")
    assert.equal(packet.workspaces[0].gateReceipts[0].id, "gate-1")
    assert.equal(packet.workspaces[0].phases[0].status, "PENDING")
    assert.equal(packet.workspaces[0].executionContract.taskHash, "task-hash")
    assert.equal(packet.workspaces[0].evidenceIntegrity.status, "OK")
    assert.equal(packet.workspaces[0].evidenceIntegrity.checkedRefs, 1)

    const rendered = renderCompactionResumeGuard(packet)
    assert.match(rendered, /deterministic artifacts win/i)
    assert.match(rendered, /receipt-1/)
    assert.match(rendered, /EXECUTION_CONTRACT\.json/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("V16 compaction resume guard reports missing durable evidence as DEGRADED", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-resume-missing-evidence-"))
  try {
    const dir = path.join(root, ".ues-work", "missing")
    const missingRef = "evidence:sha256:" + "a".repeat(64)
    await json(path.join(dir, "STATE.json"), {
      schemaVersion: 4,
      status: "executing",
      goal: "resume safely",
      updatedAt: "2026-10-02T00:00:00.000Z",
      checkpoint: {
        id: "cp-missing",
        evidencePointers: [{ kind: "context", refs: [missingRef] }],
      },
      tasks: {},
    })
    await json(path.join(dir, "PLAN.json"), { tasks: [] })
    await json(path.join(dir, "EVIDENCE.json"), { receipts: [], gateReceipts: [] })

    const packet = await buildCompactionResumeGuard(root, { reason: "threshold" })
    assert.equal(packet.workspaces[0].evidenceIntegrity.status, "DEGRADED")
    assert.deepEqual(packet.workspaces[0].evidenceIntegrity.missingRefs, [missingRef])
    assert.match(renderCompactionResumeGuard(packet), /fail closed/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
