import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  evidenceExists,
  gcEvidenceStore,
  putEvidence,
} from "../lib/evidence-store.mjs"

async function seedNoise(root, count) {
  for (let index = 0; index < count; index += 1) {
    await putEvidence(root, "noise-" + index + "-" + "x".repeat(64), {
      kind: "verification-stdout",
      source: "v16-active-work-test",
    })
  }
}

async function writeActiveState(root, ref, status = "executing") {
  const dir = path.join(root, ".ues-work", "active-demo")
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "STATE.json"), JSON.stringify({
    schemaVersion: 4,
    status,
    checkpoint: {
      evidencePointers: [{ kind: "context", ref }],
    },
  }, null, 2) + "\n")
  await writeFile(path.join(dir, "EVIDENCE.json"), JSON.stringify({
    schemaVersion: 4,
    entries: [{ task: "task-1", evidenceRef: ref }],
    receipts: [],
    gateReceipts: [],
  }, null, 2) + "\n")
}

test("V16 evidence GC preserves refs reachable from active durable work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v16-active-evidence-"))
  try {
    const durable = await putEvidence(root, "authoritative durable evidence", {
      kind: "durable-task-evidence",
      source: "task-1",
    })
    await writeActiveState(root, durable.ref, "executing")
    await new Promise((resolve) => setTimeout(resolve, 10))
    await seedNoise(root, 16)

    const result = await gcEvidenceStore(root, {
      maxEntries: 10,
      maxBytes: 64 * 1024 * 1024,
      maxAgeDays: 365,
      protectMemoryRefs: false,
    })

    assert.equal(await evidenceExists(root, durable.ref), true)
    assert.ok(result.protectedEntries >= 1)
    assert.ok(result.removedCount > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V16 evidence GC releases durable refs after work is finalized", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v16-finalized-evidence-"))
  try {
    const durable = await putEvidence(root, "old finalized evidence", {
      kind: "durable-task-evidence",
      source: "task-1",
    })
    await writeActiveState(root, durable.ref, "completed")
    await new Promise((resolve) => setTimeout(resolve, 10))
    await seedNoise(root, 16)

    await gcEvidenceStore(root, {
      maxEntries: 10,
      maxBytes: 64 * 1024 * 1024,
      maxAgeDays: 365,
      protectMemoryRefs: false,
    })

    assert.equal(await evidenceExists(root, durable.ref), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
