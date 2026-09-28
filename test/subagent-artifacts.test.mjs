import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSubagentArtifact, finalizeSubagentArtifact, listSubagentArtifacts, readSubagentArtifact } from "../lib/subagent-artifacts.mjs"
import { getEvidenceSelected } from "../lib/evidence-store.mjs"

test("subagent artifacts provide small durable handles with exact task/output evidence refs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-subagent-artifact-"))
  try {
    const created = await createSubagentArtifact(root, {
      agent: "ues-verifier",
      role: "verifier",
      attempt: 1,
      task: "Verify checkout idempotency with fresh executable evidence.",
      model: "provider/model",
      traceID: "trace-1",
      workspaceFingerprint: "ws-1",
    })
    assert.match(created.handle, /^sa-/)
    assert.equal(created.status, "running")
    assert.ok(created.taskRef)

    const finalized = await finalizeSubagentArtifact(root, created.handle, {
      exitCode: 0,
      verdict: "PASS",
      output: "UES_VERDICT: PASS\nFresh test receipt passed.",
      durationMs: 123,
      toolCalls: 2,
      toolNames: ["read", "bash"],
      childRuntime: "rpc",
      workerReused: true,
    })
    assert.equal(finalized.status, "completed")
    assert.ok(finalized.result.outputRef)
    assert.equal(finalized.resume.state, "completed")

    const output = await getEvidenceSelected(root, finalized.result.outputRef, { maxBytes: 16000 })
    assert.match(output.content, /UES_VERDICT: PASS/)

    const read = await readSubagentArtifact(root, created.handle)
    assert.equal(read.handle, created.handle)
    const listed = await listSubagentArtifacts(root)
    assert.equal(listed.count, 1)
    assert.equal(listed.artifacts[0].handle, created.handle)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
