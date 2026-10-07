// V16.12 Tool Result Reuse: behavior tests.
//
// The reuse memo is an OPTIMIZATION, never an authority. Its one safety property
// is that it can never serve a result that is stale for the current workspace.
// These tests pin: identical repeat -> CACHE_HIT; changed content hash -> MISS;
// different range/query/path/root -> MISS; a forced fresh read bypasses the
// cache; large results spill to the evidence store instead of being duplicated.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  TOOL_RESULT_REUSE_POLICY,
  TOOL_RESULT_PROVENANCE,
  toolResultKey,
  argsDigest,
  fileContentHash,
  withResultReuse,
  invalidateResult,
  invalidateFile,
  toolResultReuseStats,
  clearToolResultReuse,
} from "../lib/tool-result-reuse-v16-12.mjs"

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "ues-tool-result-"))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

test("tool result reuse policy id is byte-stable", () => {
  assert.equal(TOOL_RESULT_REUSE_POLICY, "tool-result-reuse-v16-12")
})

test("argsDigest is stable and order-independent over keys", () => {
  assert.equal(argsDigest({ a: 1, b: "x" }), argsDigest({ b: "x", a: 1 }))
  assert.notEqual(argsDigest({ a: 1 }), argsDigest({ a: 2 }))
  assert.notEqual(argsDigest({ a: [1, 2] }), argsDigest({ a: [2, 1] }))
})

test("toolResultKey: every identity component changes the key", () => {
  const base = { root: "/w", operation: "read", workspaceFingerprint: "fp", file: "a.txt", range: "1-10", args: { q: "x" } }
  const k = toolResultKey(base)
  assert.notEqual(k, toolResultKey({ ...base, file: "b.txt" }))
  assert.notEqual(k, toolResultKey({ ...base, range: "1-20" }))
  assert.notEqual(k, toolResultKey({ ...base, operation: "search" }))
  assert.notEqual(k, toolResultKey({ ...base, workspaceFingerprint: "fp2" }))
  assert.notEqual(k, toolResultKey({ ...base, args: { q: "y" } }))
  assert.notEqual(k, toolResultKey({ ...base, root: "/other" }))
  assert.equal(k, toolResultKey(base))
})

test("a repeated identical read is served from cache", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "hello world")
    let computes = 0
    const compute = async () => { computes += 1; return { text: "hello world" } }
    const first = await withResultReuse(root, { operation: "read", file: "a.txt", range: "1-10" }, compute)
    const second = await withResultReuse(root, { operation: "read", file: "a.txt", range: "1-10" }, compute)
    assert.equal(first.provenance, TOOL_RESULT_PROVENANCE.FRESH_READ)
    assert.equal(first.cacheHit, false)
    assert.equal(second.provenance, TOOL_RESULT_PROVENANCE.CACHE_HIT)
    assert.equal(second.cacheHit, true)
    assert.equal(computes, 1, "the second identical read must not recompute")
    assert.deepEqual(second.value, { text: "hello world" })
    assert.equal(toolResultReuseStats().hits, 1)
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("a changed content hash is a MISS (reuse is never stale)", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "v1")
    let computes = 0
    const compute = async () => { computes += 1; return { text: "x" } }
    await withResultReuse(root, { operation: "read", file: "a.txt" }, compute)
    // Change a single byte.
    writeFileSync(path.join(root, "a.txt"), "v2")
    const again = await withResultReuse(root, { operation: "read", file: "a.txt" }, compute)
    assert.equal(again.provenance, TOOL_RESULT_PROVENANCE.FRESH_READ)
    assert.equal(again.cacheHit, false)
    assert.equal(computes, 2, "a changed file must force a recompute")
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("fileContentHash returns null for a missing file", async () => {
  const root = tempRoot()
  try {
    assert.equal(await fileContentHash(root, "nope.txt"), null)
    writeFileSync(path.join(root, "a.txt"), "abc")
    assert.match(await fileContentHash(root, "a.txt"), /^[0-9a-f]{64}$/)
  } finally {
    cleanup(root)
  }
})

test("different range / query / path / root each produce a MISS", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "data")
    let computes = 0
    const compute = async () => { computes += 1; return computes }
    await withResultReuse(root, { operation: "read", file: "a.txt", range: "1-10" }, compute)
    await withResultReuse(root, { operation: "read", file: "a.txt", range: "11-20" }, compute)
    await withResultReuse(root, { operation: "read", file: "a.txt", range: "1-10", args: { q: "different" } }, compute)
    await withResultReuse(root, { operation: "search", workspaceFingerprint: "fp", args: { q: "a" } }, compute)
    await withResultReuse(root, { operation: "search", workspaceFingerprint: "fp", args: { q: "b" } }, compute)
    assert.equal(computes, 5, "each distinct identity must compute once")
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("a forced fresh read bypasses the cache but refreshes it", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "same")
    let computes = 0
    const compute = async () => { computes += 1; return computes }
    await withResultReuse(root, { operation: "read", file: "a.txt" }, compute)
    const forced = await withResultReuse(root, { operation: "read", file: "a.txt", fresh: true }, compute)
    assert.equal(forced.provenance, TOOL_RESULT_PROVENANCE.FRESH_READ)
    assert.equal(computes, 2)
    // The forced read refreshed the entry, so the next read is a hit.
    const next = await withResultReuse(root, { operation: "read", file: "a.txt" }, compute)
    assert.equal(next.provenance, TOOL_RESULT_PROVENANCE.CACHE_HIT)
    assert.equal(computes, 2)
    assert.equal(toolResultReuseStats().forced, 1)
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("concurrent identical operations are coalesced into one compute", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "x")
    let computes = 0
    const compute = async () => { computes += 1; await new Promise((r) => setTimeout(r, 20)); return { n: computes } }
    const [a, b, c] = await Promise.all([
      withResultReuse(root, { operation: "read", file: "a.txt" }, compute),
      withResultReuse(root, { operation: "read", file: "a.txt" }, compute),
      withResultReuse(root, { operation: "read", file: "a.txt" }, compute),
    ])
    assert.equal(computes, 1, "concurrent identical ops must share one compute")
    assert.equal(a.value.n, 1)
    assert.equal(b.value.n, 1)
    assert.equal(c.value.n, 1)
    assert.ok(toolResultReuseStats().coalesced >= 1)
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("explicit invalidation forces the next read to be fresh", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "x")
    let computes = 0
    const compute = async () => { computes += 1; return computes }
    const first = await withResultReuse(root, { operation: "read", file: "a.txt" }, compute)
    assert.equal(invalidateResult(first.key), true)
    const second = await withResultReuse(root, { operation: "read", file: "a.txt" }, compute)
    assert.equal(second.provenance, TOOL_RESULT_PROVENANCE.FRESH_READ)
    assert.equal(computes, 2)
    assert.equal(toolResultReuseStats().invalidations, 1)
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("a large result spills to the evidence store and is rehydrated on a hit", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "big.txt"), "x")
    const big = "z".repeat(4000)
    let computes = 0
    const compute = async () => { computes += 1; return { text: big } }
    const first = await withResultReuse(root, { operation: "read", file: "big.txt" }, compute, { spillBytes: 1024 })
    assert.equal(first.cacheHit, false)
    assert.equal(toolResultReuseStats().spilled, 1)
    const second = await withResultReuse(root, { operation: "read", file: "big.txt" }, compute, { spillBytes: 1024 })
    assert.equal(second.provenance, TOOL_RESULT_PROVENANCE.CACHE_HIT)
    assert.equal(second.value.text.length, 4000, "the spilled result must rehydrate intact")
    assert.equal(computes, 1)
    assert.equal(toolResultReuseStats().spillReads, 1)
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("invalidateFile removes every cached range for a file", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "x")
    const compute = async () => ({ __uesFile: "a.txt" })
    await withResultReuse(root, { operation: "read", file: "a.txt", range: "1-10" }, compute)
    await withResultReuse(root, { operation: "read", file: "a.txt", range: "11-20" }, compute)
    const removed = invalidateFile(root, "a.txt")
    assert.ok(removed >= 2, `expected >=2 invalidated, saw ${removed}`)
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})

test("an unreadable file never reuses: it computes fresh", async () => {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    let computes = 0
    const compute = async () => { computes += 1; return computes }
    const result = await withResultReuse(root, { operation: "read", file: "ghost.txt" }, compute)
    assert.equal(result.provenance, TOOL_RESULT_PROVENANCE.FRESH_READ)
    assert.equal(result.cacheHit, false)
    assert.equal(computes, 1)
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
})
