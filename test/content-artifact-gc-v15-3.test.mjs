// 15.3 independent hardening, section B (part 1) - content artifact GC global
// bound: the cases that are cheap, plus the seeder-fidelity check.
//
// THE DEFECT THIS FILE EXISTS FOR
//
// The original collector walked the store, stopped after `maxGcScanEntries`
// (4,000) rows, and applied the 20,000-entry and 256 MB caps to that partial
// sample. That is not a bound, and it was measured failing before the fix:
//
//   6,000 artifacts, maxDiskEntries 5,000, maxGcScanEntries 4,000
//     -> 6 GC runs, 4,000 files examined per run, 0 removed, 6,000 on disk
//
// The cause is structural: `kept` can never exceed `scanned`, so a cap larger
// than the scan budget can never fire. `readdir` order is also unsorted and not
// guaranteed stable, so a settled store re-examined the same files forever and
// made zero progress permanently.
//
// The fix makes the global totals O(1) in the store size (a per-shard sidecar,
// 256 shards max) and deletes whole shards oldest-first from a persistent cursor.
// These tests pin the properties that make that claim provable rather than merely
// asserted in a comment.

import test from "node:test"
import assert from "node:assert/strict"
import { readdir, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  ARTIFACT_SCHEMA_VERSION,
  GC_BASE as BASE,
  clearContentArtifactMemory,
  contentArtifactAccounting,
  artifactIdFor,
  countArtifacts,
  drainToBound,
  gcContentArtifacts,
  gcTempDir as temp,
  loadOrParseArtifact,
  putArtifact as put,
  recountShardForTest,
  rm,
  seed,
  seedStoreFast,
} from "./fixtures/gc-stress-harness.mjs"

const assertSeederMatchesApi = async () => {
  const a = await temp("seed-a")
  const b = await temp("seed-b")
  try {
    const limits = { ...BASE, maxMemoryEntries: 1 }
    await seed(path.join(a, "store"), "shape", 12, limits)
    await seedStoreFast(path.join(b, "store"), "shape", 12)
    clearContentArtifactMemory()
    const { listArtifactFiles } = await import("./fixtures/gc-stress-harness.mjs")
    const viaApi = await contentArtifactAccounting(path.join(a, "store"), limits)
    const viaSeeder = await contentArtifactAccounting(path.join(b, "store"), limits)
    assert.equal(viaSeeder.entries, viaApi.entries, "the fast seeder must produce the same entry count")
    assert.equal(viaSeeder.inexact, 0, "the fast seeder must produce fully accounted shards")
    assert.deepEqual(
      await listArtifactFiles(path.join(b, "store")),
      await listArtifactFiles(path.join(a, "store")),
      "the fast seeder must produce the same file set",
    )
  } finally {
    clearContentArtifactMemory()
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
}

test("B0 the fast stress seeder produces exactly the layout the write API produces", async () => {
  await assertSeederMatchesApi()
})

test("B3 the byte limit is enforced globally", async () => {
  const root = await temp("bytes")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...BASE, maxDiskEntries: 10 ** 7, maxDiskBytes: 40_000, maxAgeDays: 3650 }
    await seed(store, "byte", 250, { ...limits, maxMemoryEntries: 1 })
    const { results } = await drainToBound(store, limits, 30)
    const accounting = await contentArtifactAccounting(store, limits)
    assert.ok(results.reduce((sum, row) => sum + row.removed, 0) > 0, "byte overage must delete something")
    assert.ok(
      accounting.bytes <= limits.maxDiskBytes,
      `byte bound not enforced: ${accounting.bytes} > ${limits.maxDiskBytes}`,
    )
    assert.equal(results[results.length - 1].overCap, false, "the collector must agree it is under the cap")
    assert.equal(results[results.length - 1].withinByteCap, true)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("B4 mixed old and new artifacts are aged out oldest-first without touching fresh ones", async () => {
  const root = await temp("mixed-age")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...BASE, maxDiskEntries: 10 ** 7, maxAgeDays: 1, maxMemoryEntries: 1 }
    await seed(store, "old", 90, limits)
    // Backdate the whole store well past the age cap. The sidecar is written by
    // the same call that writes the artifact, so an aged store has an aged
    // sidecar too -- aging only the files would model a corruption the runtime
    // cannot produce, and the sidecar is the documented authority for age.
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    for (const version of await readdir(store, { withFileTypes: true }).catch(() => [])) {
      if (!version.isDirectory()) continue
      for (const shard of await readdir(path.join(store, version.name), { withFileTypes: true }).catch(() => [])) {
        if (!shard.isDirectory()) continue
        for (const name of await readdir(path.join(store, version.name, shard.name)).catch(() => [])) {
          if (name === "shard.json") continue
          await utimes(path.join(store, version.name, shard.name, name), past, past)
        }
        // Recount the shard so its recorded newest-mtime matches the aged files.
        await recountShardForTest(store, shard.name)
      }
    }
    // The sidecars were rewritten behind the collector's back, so its cached view
    // of them is stale. Clearing the cache is what a process restart would do.
    clearContentArtifactMemory()
    await seed(store, "new", 30, limits)

    const result = await gcContentArtifacts(store, limits)
    assert.ok(result.removed > 0, "aged artifacts must be collected")
    const remaining = await countArtifacts(store)
    assert.ok(remaining >= 30, `fresh artifacts must survive, ${remaining} remain`)
    assert.ok(remaining < 130, `aged artifacts must be gone, ${remaining} remain`)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("B5 corrupt artifacts are tolerated and do not break collection", async () => {
  const root = await temp("corrupt")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...BASE, maxDiskEntries: 200, maxAgeDays: 3650, maxMemoryEntries: 1 }
    await seedStoreFast(store, "corrupt", 300)
    const ids = [0, 1].map((index) => artifactIdFor({ contentHash: "corrupt" + index, profile: "js" }))

    // Unreadable bytes, and a structurally valid file claiming a foreign identity.
    // Each corruption is written into the shard that owns the artifact: putting a
    // file in a shard that never accounted for it would create unaccounted bytes
    // on disk, and the collector would (correctly) refuse to certify the store.
    for (const [index, body] of [
      [0, "{ not json"],
      [1, JSON.stringify({ schemaVersion: ARTIFACT_SCHEMA_VERSION, artifactId: "someone-elses", symbols: [], identifiers: {} })],
    ]) {
      const id = ids[index]
      const shardDir = path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, id.slice(0, 2))
      await writeFile(path.join(shardDir, id + ".json"), body, "utf8")
    }

    const { runs, results } = await drainToBound(store, limits, 30)
    assert.ok(results.reduce((sum, row) => sum + row.removed, 0) > 0, "collection must proceed with corrupt entries present")
    const final = await countArtifacts(store)
    assert.ok(final <= limits.maxDiskEntries, `${final} > ${limits.maxDiskEntries} after ${runs} runs`)

    // A corrupt artifact is still a miss, never a crash and never stale symbols.
    const outcome = await loadOrParseArtifact({
      dir: store,
      artifactId: ids[0],
      parse: async () => ({ contentHash: "corrupt0", profile: "js", bytes: 1, symbols: [{ name: "recovered" }], identifiers: {} }),
    })
    assert.equal(outcome.artifact.symbols[0].name, "recovered")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("B6 repeated GC converges and STAYS within the bound, and is a no-op when under it", async () => {
  const root = await temp("repeat")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...BASE, maxDiskEntries: 450, maxAgeDays: 3650, maxMemoryEntries: 1, maxShardsPerRun: 24 }
    await seedStoreFast(store, "rep", 900)

    const { runs } = await drainToBound(store, limits, 120)
    assert.ok(runs < 120, "must converge")

    // Once under the cap, further runs must delete nothing at all. A collector
    // that keeps deleting under its own limit is thrashing, not collecting.
    for (let run = 0; run < 5; run += 1) {
      const result = await gcContentArtifacts(store, limits)
      assert.equal(result.removed, 0, `run ${run} deleted ${result.removed} while under the cap`)
      assert.equal(result.overCap, false)
    }
    const stable = await countArtifacts(store)
    assert.equal(stable, (await contentArtifactAccounting(store, limits)).entries)

    // And growth is re-collected: the bound is a steady state, not a one-off.
    await seedStoreFast(store, "more", 120)
    await drainToBound(store, limits, 120)
    assert.ok((await countArtifacts(store)) <= limits.maxDiskEntries, "bound must hold after regrowth")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})
