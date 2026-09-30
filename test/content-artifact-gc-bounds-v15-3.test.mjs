// 15.3 independent hardening, section B (part 2) - content artifact GC global
// bound: the volume cases.
//
// Split from part 1 purely for scheduling. The suite's per-file budget is 45 s
// and is not raised; these cases write thousands of files and, at the suite's
// concurrency, one file holding all of them ran over that. Same coverage, two
// processes, real headroom.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  ARTIFACT_SCHEMA_VERSION,
  CONTENT_STORE_DEFAULTS,
  GC_BASE as BASE,
  artifactIdFor,
  clearContentArtifactMemory,
  contentArtifactAccounting,
  countArtifacts,
  drainToBound,
  gcContentArtifacts,
  gcTempDir as temp,
  listArtifactFiles,
  pinContentArtifact,
  seed,
  seedStoreFast,
  unpinContentArtifact,
} from "./fixtures/gc-stress-harness.mjs"
import { loadOrParseArtifact, resetContentArtifactMetrics } from "../lib/content-artifacts.mjs"

test("B9 production defaults are globally bounded, not merely annotated", async () => {
  // The configured defaults must satisfy the same invariant the reduced-limit
  // tests do, with the real numbers. This is the property the candidate report
  // claimed and could not previously demonstrate.
  const root = await temp("production-shape")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...CONTENT_STORE_DEFAULTS, gcEveryWrites: 1_000_000, maxMemoryEntries: 1 }
    assert.equal(limits.maxDiskEntries, 20_000)
    assert.equal(limits.maxDiskBytes, 256 * 1024 * 1024)
    assert.equal(limits.maxShardDirs, 256)

    // A store well under the default 20,000 cap must be recognised as compliant
    // from the accounting alone, with no scan budget anywhere near the cap.
    await seed(store, "prod", 600, limits)
    const accounting = await contentArtifactAccounting(store, limits)
    assert.equal(accounting.entries, 600, "global total is O(shards), not O(entries)")
    assert.equal(accounting.inexact, 0, "a store written through the API is fully accounted")
    assert.ok(accounting.shardsExamined <= limits.maxShardDirs)

    // Lower the cap to force work, keeping the production byte/age/shard shape.
    const tight = { ...limits, maxDiskEntries: 300 }
    const { runs } = await drainToBound(store, tight, 60)
    assert.ok((await countArtifacts(store)) <= tight.maxDiskEntries, "bound must be enforced with production defaults")
    assert.ok(runs < 60)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("B10 a store with no sidecars self-heals instead of looking empty", async () => {
  // A store produced by an older build, or by a crashed write, has artifacts but
  // no accounting. It must be discovered and bounded, not treated as empty.
  const root = await temp("drift")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...BASE, maxDiskEntries: 130, maxAgeDays: 3650, maxMemoryEntries: 1 }
    await seedStoreFast(store, "drift", 260)
    // Destroy the accounting, leaving the artifacts behind.
    for (const version of await readdir(store, { withFileTypes: true }).catch(() => [])) {
      if (!version.isDirectory()) continue
      for (const shard of await readdir(path.join(store, version.name), { withFileTypes: true }).catch(() => [])) {
        if (!shard.isDirectory()) continue
        await rm(path.join(store, version.name, shard.name, "shard.json"), { force: true }).catch(() => {})
      }
    }
    clearContentArtifactMemory()
    const unaccounted = await contentArtifactAccounting(store, limits)
    assert.ok(unaccounted.inexact > 0, "the store must be recognised as unaccounted")
    assert.equal(unaccounted.entries, 0, "an unaccounted store must not report phantom entries")

    const { runs, last } = await drainToBound(store, limits, 200)
    assert.ok(runs > 1, "an unaccounted store must take more than one run to reconcile")
    assert.equal(last.accountingComplete, true, "the collector must not claim a bound it has not proven")
    assert.ok((await countArtifacts(store)) <= limits.maxDiskEntries, "bound must be enforced on a drifted store")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("B11 metrics stay bounded and never grow a collection per run", async () => {
  resetContentArtifactMetrics()
  const root = await temp("metrics")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...BASE, maxDiskEntries: 130, maxAgeDays: 3650, maxMemoryEntries: 2 }
    await seed(store, "m", 320, limits)
    await drainToBound(store, limits, 40)
    const { contentArtifactStoreStats } = await import("../lib/content-artifacts.mjs")
    const stats = contentArtifactStoreStats(limits)
    assert.ok(stats.memoryEntries <= limits.maxMemoryEntries, "memory cache stays bounded")
    assert.ok(stats.gcRuns > 0)
    assert.ok(stats.gcShardsSwept > 0)
    assert.equal(Number.isFinite(stats.bytesRead), true)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})
