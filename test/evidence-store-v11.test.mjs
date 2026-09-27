import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { evidenceExists, evidenceStoreStatus, gcEvidenceStore, getEvidence, putEvidence } from "../lib/evidence-store.mjs"

test("V11 evidence store deduplicates content by hash and returns bounded slices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-evidence-"))
  try {
    const a = await putEvidence(root, "hello ".repeat(1000), { kind: "tool-output", source: "grep" })
    const b = await putEvidence(root, "hello ".repeat(1000), { kind: "tool-output", source: "grep" })
    assert.equal(a.ref, b.ref)
    assert.equal(await evidenceExists(root, a.ref), true)
    const viewed = await getEvidence(root, a.ref, { maxChars: 50 })
    assert.equal(viewed.returnedBytes, 50)
    assert.equal(viewed.truncated, true)
    const status = await evidenceStoreStatus(root)
    assert.equal(status.entries, 1)
    assert.ok(status.bytes > 1000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V11 evidence store GC keeps newest bounded entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-evidence-gc-"))
  try {
    for (let i = 0; i < 15; i += 1) await putEvidence(root, "value-" + i)
    const result = await gcEvidenceStore(root, { maxEntries: 10, maxAgeDays: 999 })
    assert.equal(result.status.entries, 10)
    assert.equal(result.removedCount, 5)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("V15.12 evidence GC enforces a byte quota", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-evidence-bytes-"))
  try {
    for (let i = 0; i < 6; i += 1) {
      await putEvidence(root, String(i) + "-" + "x".repeat(300 * 1024))
    }
    const result = await gcEvidenceStore(root, {
      maxEntries: 100,
      maxBytes: 1024 * 1024,
      maxAgeDays: 999,
    })
    assert.ok(result.removedCount >= 3)
    assert.ok(result.status.bytes <= 1024 * 1024)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("V15.12 evidence GC preserves blobs referenced by verified memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-evidence-memory-"))
  try {
    const protectedItem = await putEvidence(root, "protected-" + "x".repeat(64 * 1024))
    await putEvidence(root, "newer-" + "y".repeat(64 * 1024))
    const memoryDir = path.join(root, ".ues-memory")
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      path.join(memoryDir, "MEMORY.json"),
      JSON.stringify({
        schemaVersion: 1,
        memories: [{
          id: "memory-1",
          status: "verified",
          supersededBy: null,
          expiresAt: null,
          evidenceRefs: [protectedItem.ref],
        }],
      }),
      "utf8",
    )

    const result = await gcEvidenceStore(root, {
      maxEntries: 1,
      maxBytes: 1024 * 1024,
      maxAgeDays: 999,
    })
    assert.equal(await evidenceExists(root, protectedItem.ref), true)
    assert.equal(result.protectedEntries, 1)
    assert.ok(result.protectedBytes > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
