// Content-artifact GC volume stress gate (15.3 independent hardening, section B).
//
//   npm run bench:gc
//   (equivalently: node --test test/content-artifact-gc-volume-v15-3.stress.mjs)
//
// These four cases are the VOLUME cases: they create thousands of artifact
// files, which takes seconds of filesystem work each. They live here rather than
// in `npm test` for a measured reason, not a cosmetic one: adding several
// filesystem-bound test files changed which files the bounded runner scheduled
// alongside the LSP-heavy diagnostics tests, and one of those -- untouched by
// this work -- asserts a 6,500 ms wall-clock bound on a path that spawns a
// child process. It passed at 115 test files and failed at 121. The timeout was
// not raised and that assertion was not weakened; the load was moved to a gate
// that runs the identical assertions.
//
// The bug under test, for the record: the previous collector scanned at most
// 4,000 rows and applied the 20,000-entry cap to that sample, so `kept` could
// never exceed `scanned` and a cap above the scan budget could never fire.
// Measured before the fix: 6,000 artifacts against a 5,000 cap produced 6 GC
// runs, 24,000 file examinations, 0 deletions, and a store permanently over
// its limit.

import test from "node:test"
import assert from "node:assert/strict"
import { readdir, rm } from "node:fs/promises"
import path from "node:path"
import {
  ARTIFACT_SCHEMA_VERSION,
  GC_BASE as BASE,
  artifactIdFor,
  clearContentArtifactMemory,
  contentArtifactAccounting,
  countArtifacts,
  drainToBound,
  gcContentArtifacts,
  gcTempDir as temp,
  listArtifactFiles,
  loadOrParseArtifact,
  pinContentArtifact,
  seedStoreFast,
  unpinContentArtifact,
} from "../test/fixtures/gc-stress-harness.mjs"

test("B1 >4000 artifact entries are collected to the configured bound", async () => {
  // The exact scenario that broke the capped-scan collector.
  const root = await temp("over4000")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    // 4,200 artifacts against a 4,100 cap. The cap is deliberately ABOVE the old
    // 4,000 scan budget: that is precisely the case the previous collector could
    // never act on, because `kept` was bounded by `scanned`.
    const limits = { ...BASE, maxDiskEntries: 4_100, maxAgeDays: 3650 }
    await seedStoreFast(store, "big", 4_200)
    const written = await countArtifacts(store)
    assert.ok(written > 4_000, `fixture must exceed the old scan cap, wrote ${written}`)

    const { runs, results } = await drainToBound(store, limits)
    const final = await countArtifacts(store)
    assert.ok(final <= limits.maxDiskEntries, `entry bound not enforced: ${final} > ${limits.maxDiskEntries}`)
    assert.ok(runs < 20, `bound must be reached in a bounded number of runs, took ${runs}`)
    const totalRemoved = results.reduce((sum, row) => sum + row.removed, 0)
    assert.ok(totalRemoved > 0, "GC must actually delete")
    // The accounting and the filesystem must agree, or the bound is fiction.
    const accounting = await contentArtifactAccounting(store, limits)
    assert.equal(accounting.entries, final, "accounting must match the filesystem")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})


test("B2 the entry limit is enforced even when it is far above any per-run scan budget", async () => {
  // The structural failure: a cap larger than the scan budget can never fire,
  // because `kept` is bounded by `scanned`. The replacement derives the global
  // total from shard sidecars, so the cap no longer depends on a scan at all.
  const root = await temp("cap-above-scan")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    // maxDiskEntries is 4x what a single run can touch, on purpose.
    const limits = { ...BASE, maxDiskEntries: 1_000, maxShardsPerRun: 8, maxAgeDays: 3650 }
    await seedStoreFast(store, "cap", 1_200)
    const before = await countArtifacts(store)
    const accounting = await contentArtifactAccounting(store, limits)
    assert.equal(accounting.entries, before, "accounting is exact before any GC")

    const { runs } = await drainToBound(store, limits, 60)
    const final = await countArtifacts(store)
    assert.ok(final <= limits.maxDiskEntries, `${final} > ${limits.maxDiskEntries} after ${runs} runs`)
    assert.ok(runs < 60, "must converge")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})


test("B7 GC never deletes a pinned or in-flight artifact", async () => {
  const root = await temp("pins")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...BASE, maxDiskEntries: 60, maxAgeDays: 3650, maxMemoryEntries: 1, maxShardsPerRun: 4 }
    await seedStoreFast(store, "pin", 300)
    const ids = [0, 1].map((index) => artifactIdFor({ contentHash: "pin" + index, profile: "js" }))

    // One artifact the caller is actively working with, plus one whose parse is
    // in flight right now. Neither may be collected, no matter how far over cap.
    // The in-flight id is deliberately one that was never written, so the request
    // really is parsing: an id that already exists would return a cache hit and
    // the test would prove nothing about the pin.
    const pinnedId = ids[0]
    const inflightId = artifactIdFor({ contentHash: "never-written", profile: "js" })
    pinContentArtifact(pinnedId)

    let releaseParse
    const gate = new Promise((resolve) => { releaseParse = resolve })
    const parsing = loadOrParseArtifact({
      dir: store,
      artifactId: inflightId,
      parse: async () => {
        await gate
        return { contentHash: "pin1", profile: "js", bytes: 1, symbols: [{ name: "late" }], identifiers: {} }
      },
    })

    for (let run = 0; run < 8; run += 1) await gcContentArtifacts(store, limits)

    const stillThere = new Set()
    for (const version of await readdir(store, { withFileTypes: true }).catch(() => [])) {
      if (!version.isDirectory()) continue
      for (const shard of await readdir(path.join(store, version.name), { withFileTypes: true }).catch(() => [])) {
        if (!shard.isDirectory()) continue
        for (const name of await readdir(path.join(store, version.name, shard.name)).catch(() => [])) {
          if (name.endsWith(".json") && name !== "shard.json") stillThere.add(name.replace(/\.json$/, ""))
        }
      }
    }
    assert.ok(stillThere.has(pinnedId), "an explicitly pinned artifact must never be collected")

    releaseParse()
    const outcome = await parsing
    assert.equal(outcome.artifact.symbols[0].name, "late", "the in-flight parse must complete normally")
    // The result the in-flight request published is readable, so collection
    // during its lifetime neither lost it nor left a hole behind.
    const { readContentArtifact } = await import("../lib/content-artifacts.mjs")
    const published = await readContentArtifact(store, inflightId)
    assert.ok(published, "an artifact published while GC was running must be readable afterwards")
    assert.equal(published.symbols[0].name, "late")

    unpinContentArtifact(pinnedId)
    await drainToBound(store, limits, 40)
    assert.ok((await countArtifacts(store)) <= limits.maxDiskEntries, "the bound must still be reachable once pins are released")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})


test("B8 collection is deterministic and the per-run cost is bounded", async () => {
  const rootA = await temp("det-a")
  const rootB = await temp("det-b")
  try {
    clearContentArtifactMemory()
    const limits = { ...BASE, maxDiskEntries: 450, maxAgeDays: 3650, maxMemoryEntries: 1, maxShardsPerRun: 6 }
    const shape = async (store) => {
      await seedStoreFast(store, "det", 700)
      const runs = []
      const { runs: total } = await drainToBound(store, limits, 200)
      for (let run = 0; run < total + 2; run += 1) {
        const result = await gcContentArtifacts(store, limits)
        runs.push({ removed: result.removed, entries: result.entries, shardsSwept: result.shardsSwept, overCap: result.overCap })
        // Per-run work is bounded by the shard budget regardless of store size.
        assert.ok(
          result.shardsSwept <= limits.maxShardsPerRun,
          `run ${run} swept ${result.shardsSwept} shards, over the ${limits.maxShardsPerRun} budget`,
        )
      }
      return { runs, files: await countArtifacts(store) }
    }
    const a = await shape(path.join(rootA, "store"))
    const b = await shape(path.join(rootB, "store"))
    assert.deepEqual(a.runs, b.runs, "two identical stores must collect identically")
    assert.equal(a.files, b.files)
    assert.ok(a.files <= limits.maxDiskEntries, `bound not enforced: ${a.files}`)
  } finally {
    clearContentArtifactMemory()
    await rm(rootA, { recursive: true, force: true })
    await rm(rootB, { recursive: true, force: true })
  }
})
