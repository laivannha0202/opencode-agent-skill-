import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { putEvidence } from "../lib/evidence-store.mjs"
import { proposeMemory, retrieveMemories, verifyMemory } from "../lib/memory-engine.mjs"
import {
  approvePlan,
  completeTask,
  finalizeWork,
  importPlan,
  initWork,
  recordIntegrationVerification,
  startTask,
} from "../lib/task-engine.mjs"

test("V14 durable work context recalls verified memory, provider hints, and records final memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-task-v14-context-"))
  try {
    await mkdir(path.join(root, "src", "payments"), { recursive: true })
    await writeFile(path.join(root, "src", "payments", "verify.mjs"), "export const verify = (value) => Boolean(value)\n")

    const evidence = await putEvidence(root, "payments regression verified", { kind: "test-receipt" })
    const candidate = await proposeMemory(root, {
      content: "Payment verification changes must preserve the payments regression contract.",
      type: "procedural",
      scope: "module",
      evidenceRefs: [evidence.ref],
      files: ["src/payments/verify.mjs"],
      taskClass: "standard",
    })
    await verifyMemory(root, candidate.id, {
      verdict: "PASS",
      verifier: "ues-verifier",
      evidenceRefs: [evidence.ref],
    })

    const plan = {
      schemaVersion: 1,
      goal: "Harden durable payment verification",
      tasks: [{
        id: "PAY",
        title: "Harden payment verification",
        summary: "Keep payment verification compatible with its regression contract.",
        files: { modify: ["src/payments/verify.mjs"] },
        dependsOn: [],
        acceptance: ["Payment verification remains compatible"],
        verification: ["node --check src/payments/verify.mjs"],
        risk: "low",
      }],
    }

    await initWork(root, "v14-durable-context", plan.goal)
    await importPlan(root, "v14-durable-context", plan)
    await approvePlan(root, "v14-durable-context", "ues-plan-checker => PASS")

    const started = await startTask(root, "v14-durable-context", "PAY")
    assert.equal(started.contextPack.memories[0].id, candidate.id)
    assert.equal(started.contextPack.memoryRetrieval.returned >= 1, true)
    assert.ok(started.contextPack.capabilityFabric.providers.some((item) =>
      item.capability === "memory" && item.selected === "ues-memory"))
    assert.ok(started.contextPack.contextManifest.hierarchy?.scopes?.length > 0)

    await completeTask(root, "v14-durable-context", "PAY", {
      runId: started.record.runId,
      evidence: "node --check src/payments/verify.mjs => PASS",
    })
    await recordIntegrationVerification(
      root,
      "v14-durable-context",
      "PASS",
      "fresh integration verification => PASS",
    )
    const finalized = await finalizeWork(root, "v14-durable-context", "final acceptance => PASS")
    assert.equal(finalized.state.status, "completed")
    assert.equal(finalized.memory?.status, "verified")
    assert.deepEqual(finalized.memory?.files, ["src/payments/verify.mjs"])

    const recall = await retrieveMemories(root, "durable payment verification", {
      files: ["src/payments/verify.mjs"],
    })
    assert.ok(recall.results.some((item) => item.id === finalized.memory.id))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
