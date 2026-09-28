import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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


test("V15 evidence refresh and GC cannot leave metadata without its blob", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-evidence-gc-race-"))
  try {
    const targetValue = "race-target-" + "z".repeat(4096)
    const target = await putEvidence(root, targetValue, { source: "initial" })
    for (let index = 0; index < 10; index += 1) {
      await putEvidence(root, "race-decoy-" + index + "-" + "x".repeat(1024))
    }

    const hash = target.ref.slice("evidence:sha256:".length)
    const metaFile = path.join(root, ".ues-evidence", hash.slice(0, 2), hash + ".json")
    const meta = JSON.parse(await readFile(metaFile, "utf8"))
    meta.createdAt = "2000-01-01T00:00:00.000Z"
    meta.lastSeenAt = "2000-01-01T00:00:00.000Z"
    await writeFile(metaFile, JSON.stringify(meta, null, 2) + "\n", "utf8")

    for (let round = 0; round < 12; round += 1) {
      await Promise.all([
        putEvidence(root, targetValue, { source: "refresh-" + round }),
        gcEvidenceStore(root, { maxEntries: 10, maxAgeDays: 999, maxBytes: 64 * 1024 * 1024 }),
      ])
      assert.equal(await evidenceExists(root, target.ref), true)
      const viewed = await getEvidence(root, target.ref, { maxBytes: 8192 })
      assert.equal(viewed.content, targetValue)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
