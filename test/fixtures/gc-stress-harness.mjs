// Shared harness for the content-artifact GC stress tests.
//
// Split out so the heavy cases (>4,000 entries, repeated convergence) can live
// in more than one test file. The suite's per-file budget is 45 s and is NOT
// raised; a single file of these cases measured 29 s on an idle machine and ran
// over that under the suite's concurrency. Two files keeps the same coverage with
// real headroom, which is a scheduling fix rather than a coverage cut.

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  ARTIFACT_SCHEMA_VERSION,
  CONTENT_STORE_DEFAULTS,
  artifactIdFor,
  clearContentArtifactMemory,
  contentArtifactAccounting,
  gcContentArtifacts,
  loadOrParseArtifact,
  pinContentArtifact,
  unpinContentArtifact,
  writeContentArtifact,
} from "../../lib/content-artifacts.mjs"

const NL = String.fromCharCode(10)

export const GC_BASE = Object.freeze({
  ...CONTENT_STORE_DEFAULTS,
  // Automatic GC off: every test drives GC explicitly so the accounting under
  // test is the only thing acting.
  gcEveryWrites: 1_000_000,
  maxMemoryEntries: 4,
  maxShardsPerRun: 24,
})

export async function gcTempDir(label) {
  return mkdtemp(path.join(os.tmpdir(), "ues-gc-" + label + "-"))
}

// Counts artifact files only. Each shard also carries a `shard.json` accounting
// sidecar, and counting those would make the store look bigger than it is.
export async function countArtifacts(store) {
  let total = 0
  for (const version of await readdir(store, { withFileTypes: true }).catch(() => [])) {
    if (!version.isDirectory()) continue
    for (const shard of await readdir(path.join(store, version.name), { withFileTypes: true }).catch(() => [])) {
      if (!shard.isDirectory()) continue
      const entries = await readdir(path.join(store, version.name, shard.name)).catch(() => [])
      total += entries.filter((name) => name.endsWith(".json") && name !== "shard.json").length
    }
  }
  return total
}

export async function putArtifact(store, key, limits, extra = {}) {
  const id = artifactIdFor({ contentHash: key, profile: "js" })
  await writeContentArtifact(store, id, {
    contentHash: key,
    profile: "js",
    bytes: Number(extra.bytes || 8),
    symbols: [{ name: "sym_" + key }],
    identifiers: {},
  }, limits)
  return id
}

export async function seed(store, prefix, total, limits) {
  for (let index = 0; index < total; index += 1) await putArtifact(store, prefix + index, limits)
}

// Seeds a store by writing the same on-disk shape the write API produces, without
// paying for the API's per-write atomic path twice over.
//
// This exists for throughput, not to bypass the thing under test: the collector
// reads a store from disk. `assertSeederMatchesApi` proves the two produce the
// same file set and the same accounting, so a fast seed cannot quietly diverge
// from a real store. Two details matter and are easy to get wrong:
//
//   - sidecars MERGE with what is already there, because `writeContentArtifact`
//     is a read-modify-write. Overwriting would under-count a shard, and an
//     under-counted store is exactly the failure this change exists to prevent.
//   - the in-memory accounting cache is dropped afterwards, because the seeder
//     wrote the store underneath it and a stale cache would make the collector
//     disagree with disk for reasons unrelated to what is under test.
const SEED_CONCURRENCY = 48

export async function seedStoreFast(store, prefix, total) {
  const shards = new Map()
  // Written in bounded-concurrency batches. Creating thousands of files one at a
  // time is the single most expensive thing these tests do, and it is I/O
  // latency rather than CPU: overlapping the writes is what makes the suite fit
  // its budget without raising a timeout.
  // Create the shard directories once up front. Calling mkdir per file is a
  // syscall storm, and the shard set is known from the ids before any write.
  const wanted = new Set()
  for (let index = 0; index < total; index += 1) {
    wanted.add(artifactIdFor({ contentHash: prefix + index, profile: "js" }).slice(0, 2))
  }
  await Promise.all([...wanted].map((shard) =>
    mkdir(path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, shard), { recursive: true })))

  for (let start = 0; start < total; start += SEED_CONCURRENCY) {
    const batch = []
    for (let index = start; index < Math.min(start + SEED_CONCURRENCY, total); index += 1) {
      const key = prefix + index
      const id = artifactIdFor({ contentHash: key, profile: "js" })
      const shard = id.slice(0, 2)
      const shardDir = path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, shard)
      const body = JSON.stringify({
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        artifactId: id,
        parserVersion: ARTIFACT_SCHEMA_VERSION,
        contentHash: key,
        profile: "js",
        bytes: 8,
        symbols: [{ name: "sym_" + key, kind: "function", line: 1, preview: "" }],
        identifiers: {},
        skipped: null,
        writtenAt: new Date().toISOString(),
      }) + NL
      batch.push((async () => {
        const file = path.join(shardDir, id + ".json")
        await writeFile(file, body, "utf8")
        const info = await stat(file)
        const row = shards.get(shard) || { entries: 0, bytes: 0, newestMtimeMs: 0 }
        row.entries += 1
        row.bytes += info.size
        row.newestMtimeMs = Math.max(row.newestMtimeMs, info.mtimeMs)
        shards.set(shard, row)
      })())
    }
    await Promise.all(batch)
  }
  await Promise.all([...shards.entries()].sort().map(async ([shard, row]) => {
    const sidecar = path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, shard, "shard.json")
    let existing = { entries: 0, bytes: 0, newestMtimeMs: 0 }
    try { existing = JSON.parse(await readFile(sidecar, "utf8")) } catch { /* first write */ }
    await writeFile(sidecar, JSON.stringify({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      shard,
      entries: Number(existing.entries || 0) + row.entries,
      bytes: Number(existing.bytes || 0) + row.bytes,
      newestMtimeMs: Math.max(Number(existing.newestMtimeMs || 0), row.newestMtimeMs),
    }) + NL, "utf8")
  }))
  clearContentArtifactMemory()
  return shards.size
}

export async function listArtifactFiles(store) {
  const out = []
  for (const version of await readdir(store, { withFileTypes: true }).catch(() => [])) {
    if (!version.isDirectory()) continue
    for (const shard of await readdir(path.join(store, version.name), { withFileTypes: true }).catch(() => [])) {
      if (!shard.isDirectory()) continue
      for (const name of await readdir(path.join(store, version.name, shard.name)).catch(() => [])) {
        if (name.endsWith(".json") && name !== "shard.json") out.push(version.name + "/" + shard.name + "/" + name)
      }
    }
  }
  return out.sort()
}

// Re-derives a shard's accounting from the files actually on disk. Used by the
// age test, to make a backdated store internally consistent: a real aged store
// has aged sidecars too, because the sidecar is written by the same call that
// writes the artifact.
export async function recountShardForTest(store, shard) {
  const dir = path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, shard)
  const names = await readdir(dir).catch(() => [])
  let entries = 0
  let bytes = 0
  let newest = 0
  for (const name of names) {
    if (!name.endsWith(".json") || name === "shard.json") continue
    const info = await stat(path.join(dir, name)).catch(() => null)
    if (!info) continue
    entries += 1
    bytes += info.size
    newest = Math.max(newest, info.mtimeMs)
  }
  await writeFile(path.join(dir, "shard.json"), JSON.stringify({
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    shard,
    entries,
    bytes,
    newestMtimeMs: newest,
  }) + NL, "utf8")
}

// Drains until the collector reports it is within every cap. A run reporting
// `accountingComplete: false` has not proven the bound even if its numbers look
// small, so it does not terminate the drain.
export async function drainToBound(store, limits, maxRuns = 40) {
  let last = null
  const results = []
  for (let run = 0; run < maxRuns; run += 1) {
    last = await gcContentArtifacts(store, limits)
    results.push(last)
    if (!last.overCap && last.accountingComplete !== false) return { runs: run + 1, last, results }
  }
  return { runs: maxRuns, last, results }
}

export {
  clearContentArtifactMemory,
  contentArtifactAccounting,
  CONTENT_STORE_DEFAULTS,
  gcContentArtifacts,
  loadOrParseArtifact,
  pinContentArtifact,
  unpinContentArtifact,
  writeContentArtifact,
  ARTIFACT_SCHEMA_VERSION,
  artifactIdFor,
  rm,
}
