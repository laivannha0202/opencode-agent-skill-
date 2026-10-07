// V16.12 Workspace-Scoped Verification Receipt Cache: behavior tests.
//
// The receipt cache exists to skip a REPEAT of a deterministic gate that already
// passed against the SAME workspace. Its entire value depends on ONE property:
// it must NEVER return a reusable PASS for anything other than a genuine,
// completed, exit-0 pass against an UNCHANGED workspace. These tests pin that.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  RECEIPT_CACHE_POLICY,
  RECEIPT_OUTCOME,
  RECEIPT_PROVENANCE,
  ATOMIC_RETRY_CODES,
  atomicWriteJson,
  receiptCacheKey,
  receiptProvesPass,
  finalReleaseMode,
  findReusableReceipt,
  recordReceipt,
  readReceiptOutput,
  enforceBounds,
  purgeReceiptCache,
  receiptCacheStats,
  resetReceiptCacheStats,
} from "../lib/verification-receipt-cache-v16-12.mjs"

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "ues-receipt-"))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

test("receipt cache policy id is byte-stable", () => {
  assert.equal(RECEIPT_CACHE_POLICY, "verification-receipt-cache-v16-12")
})

test("receiptProvesPass: only a completed exit-0 pass proves a pass", () => {
  const base = {
    schemaVersion: 1,
    outcome: RECEIPT_OUTCOME.PASSED,
    exitCode: 0,
    completed: true,
    gateName: "npm test",
    command: "npm",
    finishedAt: new Date().toISOString(),
  }
  assert.equal(receiptProvesPass(base), true)
  assert.equal(receiptProvesPass({ ...base, exitCode: 1 }), false)
  assert.equal(receiptProvesPass({ ...base, outcome: RECEIPT_OUTCOME.FAILED }), false)
  assert.equal(receiptProvesPass({ ...base, completed: false }), false)
  assert.equal(receiptProvesPass({ ...base, aborted: true }), false)
  assert.equal(receiptProvesPass({ ...base, timedOut: true }), false)
  assert.equal(receiptProvesPass({ ...base, partial: true }), false)
  assert.equal(receiptProvesPass({ ...base, schemaVersion: 999 }), false)
  assert.equal(receiptProvesPass(null), false)
})

test("receiptCacheKey: every input component changes the key", () => {
  const root = tempRoot()
  try {
    const base = { root, workspaceFingerprint: "fp", gateName: "npm test", command: "npm", args: ["test"] }
    const k0 = receiptCacheKey(base)
    assert.notEqual(k0, receiptCacheKey({ ...base, gateName: "release:verify" }))
    assert.notEqual(k0, receiptCacheKey({ ...base, command: "node" }))
    assert.notEqual(k0, receiptCacheKey({ ...base, args: ["test", "--x"] }))
    assert.notEqual(k0, receiptCacheKey({ ...base, workspaceFingerprint: "fp2" }))
    assert.notEqual(k0, receiptCacheKey({ ...base, testInventoryVersion: "v2" }))
    assert.notEqual(k0, receiptCacheKey({ ...base, dependencyStateDigest: "d1" }))
    assert.notEqual(k0, receiptCacheKey({ ...base, configDigest: "c1" }))
    assert.notEqual(k0, receiptCacheKey({ ...base, environmentPolicyDigest: "e1" }))
    // Deterministic: same input -> same key.
    assert.equal(k0, receiptCacheKey(base))
  } finally {
    cleanup(root)
  }
})

test("a recorded PASS is reusable against the same workspace", async () => {
  const root = tempRoot()
  resetReceiptCacheStats()
  try {
    await recordReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", stdout: "ok", workspaceFingerprint: "fp1" })
    const hit = await findReusableReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], workspaceFingerprint: "fp1" })
    assert.ok(hit, "expected a reusable receipt")
    assert.equal(hit.reusable, true)
    assert.equal(hit.provenance, RECEIPT_PROVENANCE.REUSED)
    assert.equal(await readReceiptOutput(root, hit.stdoutRef), "ok")
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("a FAILED or partial receipt is NEVER reusable", async () => {
  const root = tempRoot()
  try {
    await recordReceipt(root, { gateName: "suite", command: "npm", args: ["test"], exitCode: 1, outcome: "failed", workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "suite", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    await recordReceipt(root, { gateName: "partial", command: "npm", args: ["test"], exitCode: 0, outcome: "partial", partial: true, workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "partial", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    await recordReceipt(root, { gateName: "aborted", command: "npm", args: ["test"], exitCode: 0, outcome: "aborted", aborted: true, workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "aborted", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    await recordReceipt(root, { gateName: "timeout", command: "npm", args: ["test"], exitCode: 0, outcome: "timed_out", timedOut: true, workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "timeout", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("a workspace change invalidates a previously passing receipt", async () => {
  const root = tempRoot()
  try {
    await recordReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp-before" })
    const stale = await findReusableReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], workspaceFingerprint: "fp-after" })
    assert.equal(stale, null, "a changed workspace must not reuse the old receipt")
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("final-release mode refuses ALL reuse", async () => {
  const root = tempRoot()
  try {
    await recordReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp1" })
    assert.equal(finalReleaseMode({ finalRelease: true }), true)
    assert.equal(finalReleaseMode({ mode: "final-release" }), true)
    assert.equal(finalReleaseMode({}), false)
    assert.equal(await findReusableReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }, { finalRelease: true }), null)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("a corrupt entry is treated as a MISS, never a PASS", async () => {
  const root = tempRoot()
  try {
    const key = receiptCacheKey({ root, workspaceFingerprint: "fp1", gateName: "npm test", command: "npm", args: ["test"] })
    // Write a syntactically invalid file at the exact shard path.
    const dir = path.join(root, ".ues-cache", "verification-receipts-v16-12", key.slice(0, 2))
    const file = path.join(dir, `${key}.json`)
    writeFileSync(path.join(root, "seed.txt"), "x")
    const { mkdirSync } = await import("node:fs")
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, "{ not json")
    assert.equal(await findReusableReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("receipt cache stats account for hits, misses and final-mode refusals", async () => {
  const root = tempRoot()
  resetReceiptCacheStats()
  try {
    await recordReceipt(root, { gateName: "g", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp1" })
    await findReusableReceipt(root, { gateName: "g", command: "npm", args: ["test"], workspaceFingerprint: "fp1" })
    await findReusableReceipt(root, { gateName: "missing", command: "npm", args: ["test"], workspaceFingerprint: "fp1" })
    await findReusableReceipt(root, { gateName: "g", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }, { finalRelease: true })
    const stats = receiptCacheStats()
    assert.equal(stats.hits, 1)
    assert.ok(stats.misses >= 1)
    assert.equal(stats.finalModeRefusals, 1)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("UNVERIFIED / abort / timeout outcomes are never reusable even with exit 0", async () => {
  const root = tempRoot()
  try {
    await recordReceipt(root, { gateName: "u", command: "npm", args: ["test"], exitCode: 0, outcome: "unverified", workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "u", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    // A raw partial/aborted flag with an otherwise-passing shape still fails.
    await recordReceipt(root, { gateName: "p", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", partial: true, workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "p", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    await recordReceipt(root, { gateName: "a", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", aborted: true, workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "a", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    await recordReceipt(root, { gateName: "t", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", timedOut: true, workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "t", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("atomicWriteJson retries Windows EBUSY/EPERM and then succeeds", async () => {
  const root = tempRoot()
  try {
    const file = path.join(root, "nested", "entry.json")
    let calls = 0
    const renameImpl = async (from, to) => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error("busy"), { code: calls === 1 ? "EBUSY" : "EPERM" })
      const { rename } = await import("node:fs/promises")
      return rename(from, to)
    }
    await atomicWriteJson(file, { ok: true }, { renameImpl })
    assert.equal(calls, 3, "must retry the transient failures")
    const { readFileSync } = await import("node:fs")
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ok: true })
    assert.ok(ATOMIC_RETRY_CODES.includes("EBUSY") && ATOMIC_RETRY_CODES.includes("EPERM"))
  } finally {
    cleanup(root)
  }
})

test("atomicWriteJson surfaces a persistent EBUSY as a bounded failure (no wrong answer)", async () => {
  const root = tempRoot()
  try {
    const file = path.join(root, "entry.json")
    let calls = 0
    const renameImpl = async () => { calls += 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }) }
    await assert.rejects(() => atomicWriteJson(file, { ok: true }, { renameImpl, renameRetries: 3 }), /busy/)
    assert.equal(calls, 3)
    // A non-retryable error fails fast (one attempt).
    let fastCalls = 0
    await assert.rejects(() => atomicWriteJson(file, { ok: true }, { renameImpl: async () => { fastCalls += 1; throw Object.assign(new Error("enospc"), { code: "ENOSPC" }) } }), /enospc/)
    assert.equal(fastCalls, 1)
  } finally {
    cleanup(root)
  }
})

test("a failed receipt write degrades to a miss, never a fabricated reuse", async () => {
  const root = tempRoot()
  resetReceiptCacheStats()
  try {
    const result = await recordReceipt(root, { gateName: "g", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp1" }, {
      renameImpl: async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }) },
      renameRetries: 1,
    })
    // The receipt object is still returned (the measurement happened) ...
    assert.equal(result.receipt.gateName, "g")
    // ... but nothing is cached, so a lookup is a MISS.
    assert.equal(await findReusableReceipt(root, { gateName: "g", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    assert.ok(receiptCacheStats().writeFailures >= 1)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("the receipt cache is bounded by entry count", async () => {
  const root = tempRoot()
  try {
    for (let i = 0; i < 6; i += 1) {
      await recordReceipt(root, { gateName: `g${i}`, command: "npm", args: ["test", String(i)], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp1" })
    }
    const bounds = await enforceBounds(root, { maxEntries: 2, maxBytes: 256 * 1024 * 1024 })
    assert.ok(bounds.retained <= 2, `expected <=2 retained, saw ${bounds.retained}`)
    assert.ok(bounds.removed >= 4)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("enforceBounds removes a corrupt entry", async () => {
  const root = tempRoot()
  try {
    await recordReceipt(root, { gateName: "good", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp1" })
    const key = receiptCacheKey({ root, workspaceFingerprint: "fp1", gateName: "bad", command: "npm", args: ["x"] })
    const dir = path.join(root, ".ues-cache", "verification-receipts-v16-12", key.slice(0, 2))
    const { mkdirSync, writeFileSync } = await import("node:fs")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${key}.json`), "{ broken")
    const bounds = await enforceBounds(root, {})
    assert.ok(bounds.removed >= 1)
    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(path.join(dir, `${key}.json`)), false)
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})

test("a second gate with different args is not served by the first gate's receipt", async () => {
  const root = tempRoot()
  try {
    await recordReceipt(root, { gateName: "syntax", command: "npm", args: ["run", "syntax"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp1" })
    assert.equal(await findReusableReceipt(root, { gateName: "test", command: "npm", args: ["test"], workspaceFingerprint: "fp1" }), null)
    assert.ok(await findReusableReceipt(root, { gateName: "syntax", command: "npm", args: ["run", "syntax"], workspaceFingerprint: "fp1" }))
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
})
