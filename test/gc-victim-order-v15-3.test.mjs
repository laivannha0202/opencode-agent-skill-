// V15.3 ranking repair, Phase 8 -- GC victim-order audit.
//
// The previous report described the collector as "whole shards oldest-first
// (newestMtimeMs desc, shard asc)" and those two statements read as a
// contradiction. This file settles it with a deterministic, timestamped fixture
// instead of prose, and pins the three properties the order has to have:
//
//   1. the OLDEST shard is the victim when one must be reclaimed;
//   2. ties are broken deterministically, in the same direction every run;
//   3. a pinned victim is skipped WITHOUT corrupting the accounting.
//
// It also re-proves that the runtime does not certify global bounds while
// `accountingComplete` is false.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import {
  ARTIFACT_SCHEMA_VERSION,
  GC_BASE as BASE,
  clearContentArtifactMemory,
  contentArtifactAccounting,
  countArtifacts,
  gcContentArtifacts,
  gcTempDir as temp,
  pinContentArtifact,
  seedStoreFast,
  unpinContentArtifact,
} from "./fixtures/gc-stress-harness.mjs"

// Seeds N artifacts, then forces a KNOWN modification time onto each shard it
// created, so the expected victim is decided by the test rather than by the
// clock. The shard list is read back from the store rather than recomputed, so
// the fixture cannot silently disagree with the layout it is testing.
async function seedAged(store, count, agesByIndex) {
  await seedStoreFast(store, "probe", count);
  const versionDir = path.join(store, "v" + ARTIFACT_SCHEMA_VERSION)
  const shards = (await readdir(versionDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (shards.length !== count) {
    throw new Error(`expected ${count} distinct shards, store has ${shards.length}: ${shards.join(",")}`)
  }
  for (let index = 0; index < shards.length; index += 1) {
    const shard = shards[index];
    const mtimeMs = agesByIndex[index];
    const dir = path.join(versionDir, shard);
    for (const name of await readdir(dir)) {
      if (name === "shard.json") continue;
      const when = new Date(mtimeMs);
      await utimes(path.join(dir, name), when, when);
    }
    // The sidecar is written by the same call that writes the file, so a real
    // aged store has an aged sidecar too; align it or the fixture is not one.
    const sidecar = path.join(dir, "shard.json");
    const parsed = JSON.parse(await readFile(sidecar, "utf8"));
    await writeFile(sidecar, JSON.stringify({ ...parsed, newestMtimeMs: mtimeMs }) + String.fromCharCode(10), "utf8");
  }
  clearContentArtifactMemory();
  return shards;
}

test("P8-1 the collector reclaims the OLDEST shard first, proven with known timestamps", async () => {
  const root = await temp("order")
  try {
    clearContentArtifactMemory();
    const store = path.join(root, "store")
    // Oldest = 100, then 200, then 300. The victim must be the 100 shard.
    const ages = [100, 200, 300];
    const shards = await seedAged(store, 3, ages);

    const accounting = await contentArtifactAccounting(store, { ...BASE });
    assert.equal(accounting.entries, 3);
    assert.equal(accounting.inexact, 0, "the fixture must be fully accounted");

    // maxShardsPerRun 1 so exactly one shard is reclaimed.
    const limits = { ...BASE, maxDiskEntries: 2, maxAgeDays: 3650, maxShardsPerRun: 1 };
    const result = await gcContentArtifacts(store, limits);
    assert.equal(result.shardsSwept, 1, "exactly one shard may be reclaimed per run");
    assert.equal(result.removed, 1, "exactly one artifact should be reclaimed");

    const after = await contentArtifactAccounting(store, limits);
    const byShard = new Map(after.states.map((row) => [row.shard, row]));
    assert.equal(byShard.has(shards[0]), false, `shard ${shards[0]} (newest=100, oldest) must be the victim`);
    assert.equal(byShard.has(shards[1]), true, "shard newest=200 must survive");
    assert.equal(byShard.has(shards[2]), true, "shard newest=300 must survive");
    assert.equal(after.entries, await countArtifacts(store), "accounting must agree with disk");
  } finally {
    clearContentArtifactMemory();
    await rm(root, { recursive: true, force: true });
  }
});

test("P8-2 the tie-break is deterministic and identical across repeated runs", async () => {
  // Equal mtimes: the victim must be chosen the same way every time, from two
  // stores built identically.
  const results = [];
  for (let run = 0; run < 2; run += 1) {
    const root = await temp("tie-" + run);
    try {
      clearContentArtifactMemory();
      const store = path.join(root, "store");
      const shards = await seedAged(store, 4, [500, 500, 500, 500]);
      const limits = { ...BASE, maxDiskEntries: 3, maxAgeDays: 3650, maxShardsPerRun: 1 };
      await gcContentArtifacts(store, limits);
      const after = await contentArtifactAccounting(store, limits);
      results.push({ survivors: after.states.map((row) => row.shard).sort(), shards });
    } finally {
      clearContentArtifactMemory();
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(results[0].shards, results[1].shards, "both stores must be built identically");
  assert.deepEqual(results[0].survivors, results[1].survivors, "two identical stores must lose the same shard");
  assert.equal(results[0].survivors.length, 3, "exactly one of four shards should be reclaimed");
});

test("P8-3 a pinned victim is skipped without corrupting the accounting", async () => {
  const root = await temp("pinorder");
  try {
    clearContentArtifactMemory();
    const store = path.join(root, "store");
    // shard[0] is the oldest, so it is the natural victim.
    const shards = await seedAged(store, 4, [100, 200, 300, 400]);
    const oldestArtifact = shards[0] + "x".repeat(0);
    void oldestArtifact;
    // Pin the artifact inside the oldest shard by its real artifact id.
    const versionDir = path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, shards[0]);
    const files = (await readdir(versionDir)).filter((name) => name !== "shard.json");
    assert.equal(files.length, 1);
    const pinnedId = files[0].replace(/\.json$/, "");
    pinContentArtifact(pinnedId);

    const limits = { ...BASE, maxDiskEntries: 2, maxAgeDays: 3650, maxShardsPerRun: 4 };
    const result = await gcContentArtifacts(store, limits);
    assert.ok(result.removed > 0, "pinning one shard must not stop collection entirely");
    // A pin can legitimately make the cap unreachable. The honest outcome is
    // to SAY that, not to delete the pinned artifact and not to report
    // compliance the collector did not achieve.
    assert.equal(result.overCap, true, "a blocked bound must be reported as still over");
    const after = await contentArtifactAccounting(store, limits);
    assert.equal(after.entries, await countArtifacts(store), "accounting must still match disk after skipping a pin");
    const stillThere = (await readdir(path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, shards[0])))
      .filter((name) => name !== "shard.json");
    assert.equal(stillThere.length, 1, "the pinned artifact must not be deleted");

    // Releasing the pin makes the bound reachable on the next run, which proves
    // the earlier overCap was a real obstacle and not a stuck flag.
    unpinContentArtifact(pinnedId);
    const released = await gcContentArtifacts(store, limits);
    assert.equal(released.overCap, false, "the bound must become reachable once the pin is released");
    assert.ok(released.entries <= limits.maxDiskEntries);
  } finally {
    clearContentArtifactMemory();
    await rm(root, { recursive: true, force: true });
  }
});


test("P8-4 global bounds are never certified while accounting is incomplete", async () => {
  const root = await temp("incomplete")
  try {
    clearContentArtifactMemory();
    const store = path.join(root, "store")
    await seedStoreFast(store, "drift", 40);
    // Destroy the accounting: the artifacts remain, the knowledge of them does not.
    for (const version of await readdir(store, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      for (const shard of await readdir(path.join(store, version.name), { withFileTypes: true })) {
        if (!shard.isDirectory()) continue;
        await rm(path.join(store, version.name, shard.name, "shard.json"), { force: true });
      }
    }
    clearContentArtifactMemory();
    const unaccounted = await contentArtifactAccounting(store, { ...BASE });
    assert.ok(unaccounted.inexact > 0, "the store must be recognised as unaccounted");
    assert.equal(unaccounted.entries, 0, "an unaccounted store must not report phantom entries");

    // A run against an unproven store must say so, not report a clean bill.
    const limits = { ...BASE, maxDiskEntries: 10 ** 6, maxAgeDays: 3650, maxShardsPerRun: 4 };
    const first = await gcContentArtifacts(store, limits);
    assert.equal(first.accountingComplete, false, "bounds must not be certified on incomplete accounting");
    assert.equal(first.overCap, true, "an unproven store must not report as within its caps");

    // Repeated runs reconcile, and only then may the bound be certified.
    let last = first;
    for (let run = 0; run < 60 && last.overCap; run += 1) last = await gcContentArtifacts(store, limits);
    assert.equal(last.accountingComplete, true, "the accounting must become complete after reconciliation");
    assert.equal(last.overCap, false);
    assert.ok(last.entries <= limits.maxDiskEntries);
  } finally {
    clearContentArtifactMemory();
    await rm(root, { recursive: true, force: true });
  }
});
