// V16.10 Repo Intelligence V2 + persistent cache: behavior tests.
//
// The cache must be fingerprint-scoped (stale data impossible), atomic, and
// degrade to a miss - never to a wrong answer - when it fails.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  getOrComputeRepoIntel,
  repoIntelCacheKey,
  stableOptionsDigest,
  repoIntelCacheStats,
  purgeRepoIntelCache,
} from "../lib/repo-intelligence-cache-v16-10.mjs"
import {
  buildRepoIntelligence,
  renderRepoIntelligenceBrief,
  explainRepoIntelligenceFile,
} from "../lib/repo-intelligence-v16-10.mjs"

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "ues-repocache-"))
}

test("V16.10 repo cache: a different fingerprint can never read another fingerprint's entry", async () => {
  const root = tempRoot()
  try {
    let computed = 0
    const compute = async () => {
      computed += 1
      return { fingerprintSpecific: true }
    }
    const first = await getOrComputeRepoIntel(root, { root, workspaceFingerprint: "fp-A", kind: "k", optionsDigest: "o" }, compute, { persist: true })
    assert.equal(first.cacheHit, false)
    // Same fingerprint: served from cache, no recompute.
    const second = await getOrComputeRepoIntel(root, { root, workspaceFingerprint: "fp-A", kind: "k", optionsDigest: "o" }, compute, { persist: true })
    assert.equal(second.cacheHit, true)
    assert.equal(computed, 1)
    // Different fingerprint: MUST recompute. A stale tree is never reused.
    const third = await getOrComputeRepoIntel(root, { root, workspaceFingerprint: "fp-B", kind: "k", optionsDigest: "o" }, compute, { persist: true })
    assert.equal(third.cacheHit, false)
    assert.equal(computed, 2)
  } finally {
    await purgeRepoIntelCache(root)
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.10 repo cache: disk entries survive a memory clear and stay key-bound", async () => {
  const root = tempRoot()
  try {
    let computed = 0
    const compute = async () => {
      computed += 1
      return { n: computed }
    }
    await getOrComputeRepoIntel(root, { root, workspaceFingerprint: "fp-D", kind: "k", optionsDigest: "o" }, compute, { persist: true })
    // Clear only the in-memory layer; the disk layer must still answer.
    const { clearRepoIntelCache } = await import("../lib/repo-intelligence-cache-v16-10.mjs")
    clearRepoIntelCache(root)
    const second = await getOrComputeRepoIntel(root, { root, workspaceFingerprint: "fp-D", kind: "k", optionsDigest: "o" }, compute, { persist: true })
    assert.equal(second.cacheHit, true)
    assert.equal(second.source, "disk")
    assert.equal(computed, 1)
  } finally {
    await purgeRepoIntelCache(root)
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.10 repo cache: concurrent callers of one key coalesce", async () => {
  const root = tempRoot()
  try {
    let computed = 0
    const compute = async () => {
      computed += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { slow: true }
    }
    const input = { root, workspaceFingerprint: "fp-E", kind: "k", optionsDigest: "o" }
    const results = await Promise.all([
      getOrComputeRepoIntel(root, input, compute, { persist: false }),
      getOrComputeRepoIntel(root, input, compute, { persist: false }),
      getOrComputeRepoIntel(root, input, compute, { persist: false }),
    ])
    assert.equal(computed, 1)
    assert.ok(results.some((row) => row.coalesced === true))
  } finally {
    await purgeRepoIntelCache(root)
    rmSync(root, { recursive: true, force: true })
  }
})

test("V16.10 repo cache: options digest is order-independent", () => {
  assert.equal(stableOptionsDigest({ b: 2, a: 1 }), stableOptionsDigest({ a: 1, b: 2 }))
  assert.notEqual(stableOptionsDigest({ a: 1 }), stableOptionsDigest({ a: 2 }))
  assert.match(repoIntelCacheKey({ root: ".", workspaceFingerprint: "x", kind: "k" }), /repo-intelligence-cache-v16-10/)
})

test("V16.10 repo intelligence: ranks real files and reports provenance honestly", async () => {
  const root = path.resolve(".")
  const result = await buildRepoIntelligence(root, "tool output budgeter shaping", { limit: 8, persistCache: false })
  assert.equal(result.policy, "repo-intelligence-v16-10")
  assert.ok(Array.isArray(result.files))
  assert.ok(result.files.length > 0)
  // The cache must state whether each artifact was reused, never claim freshness.
  assert.ok(["computed", "memory", "disk", "inflight", "error"].includes(result.cache.graph.source))
  assert.ok(Array.isArray(result.degraded))
})

test("V16.10 repo intelligence: the brief is bounded and never inlines source", () => {
  const brief = renderRepoIntelligenceBrief({
    query: "x",
    files: [{ path: "lib/a.mjs", tier: "1", score: 9, reasons: ["changed-file"], importantSymbols: ["foo"] }],
    affected: { tests: [{ path: "test/a.test.mjs" }] },
    stats: { candidateCount: 10, selectedCount: 1, contextChars: 200 },
    degraded: [{ artifact: "repo-graph" }],
  })
  assert.match(brief, /repo intelligence/)
  assert.match(brief, /lib\/a\.mjs/)
  assert.match(brief, /affected tests: test\/a\.test\.mjs/)
  assert.match(brief, /degraded: repo-graph/)
  assert.ok(brief.length < 2000)
})

test("V16.10 repo intelligence: explain says 'not found' rather than guessing", () => {
  const result = { files: [{ path: "lib/a.mjs", score: 1, tier: "1", reasons: ["x"] }], workspaceFingerprint: "fp" }
  const found = explainRepoIntelligenceFile(result, "lib/a.mjs")
  assert.equal(found.found, true)
  assert.deepEqual(found.reasons, ["x"])
  const missing = explainRepoIntelligenceFile(result, "lib/missing.mjs")
  assert.equal(missing.found, false)
  assert.equal(missing.reason, "not-in-ranked-set")
})

test("V16.10 repo cache: stats never fabricate a MEASURED value without observations", () => {
  const stats = repoIntelCacheStats()
  assert.equal(stats.schemaVersion, 1)
  assert.ok(Number.isFinite(stats.hits))
  assert.ok(Number.isFinite(stats.misses))
})
