// V15.3 Phase 2 - content-addressed parsed-source artifacts.
//
// The pre-patch reuse decision was `size + mtimeMs`. These tests pin the
// properties that decision got wrong, plus the safety properties the new
// identity layer has to earn:
//
//    1  unchanged file reuses
//    2  same size, different content -> NO false hit      <- decisive guard
//    3  changed mtime, same content -> artifact reuse
//    4  copy/rename with same content -> artifact reuse
//    5  a second git worktree on the same blob -> reuse    <- cross-worktree
//    6  dirty tracked file hashes its actual content
//    7  staged vs working-tree content are distinguished
//    8  untracked file is hashed, never taken from an index entry
//    9  artifact schema change invalidates deterministically
//   10  corrupt artifact degrades to a rebuild, never a crash or stale symbols
//   11  memory cache is bounded
//   12  disk cache is bounded and GC'd
//   13  concurrent demand for one artifact parses once
//   14  Windows path normalisation
//   15  output ordering is deterministic

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildSemanticIndex, clearSemanticIndexRuntimeCache, querySemanticIndex, semanticIndexStatus } from "../lib/semantic-index.mjs"
import {
  ARTIFACT_SCHEMA_VERSION,
  CONTENT_STORE_DEFAULTS,
  artifactIdFor,
  clearContentArtifactMemory,
  contentArtifactStoreStats,
  contentHashOf,
  gcContentArtifacts,
  loadOrParseArtifact,
  parserProfileFor,
  readGitBlobIndex,
  resetContentArtifactMetrics,
  resolveContentStoreDir,
  writeContentArtifact,
} from "../lib/content-artifacts.mjs"
import { writeRetrievalFixture } from "../evals/retrieval/fixture.mjs"

async function temp(label) {
  return mkdtemp(path.join(os.tmpdir(), "ues-content-artifacts-" + label + "-"))
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") }
}

function gitRepo(root) {
  assert.equal(git(root, ["init", "-q", "-b", "main"]).status, 0)
  git(root, ["config", "user.email", "ues@example.invalid"])
  git(root, ["config", "user.name", "UES Test"])
  return root
}

async function repoWithFile(label, relative, source) {
  const root = gitRepo(await temp(label))
  const full = path.join(root, ...relative.split("/"))
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, source, "utf8")
  git(root, ["add", "--", relative])
  git(root, ["commit", "-qm", "fixture"])
  return root
}

const SOURCE = "export function calculateOrderTotal(items) {\n  return items.length\n}\n"

test("V15.3 content artifacts: an unchanged file is reused and reports its identity", async () => {
  const root = await temp("reuse")
  try {
    clearSemanticIndexRuntimeCache()
    resetContentArtifactMetrics()
    const store = path.join(root, "store")
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "a.mjs"), SOURCE, "utf8")

    const cold = await buildSemanticIndex(root, { rebuild: true, maxFiles: 50, contentStoreDir: store })
    assert.equal(cold.stats.reparsed, 1)
    const entry = cold.index.files["src/a.mjs"]
    assert.equal(entry.contentHash, contentHashOf(SOURCE))
    assert.equal(entry.artifactId, artifactIdFor({ contentHash: entry.contentHash, profile: "js" }))
    assert.equal(entry.bytes, Buffer.byteLength(SOURCE))

    const warm = await buildSemanticIndex(root, { maxFiles: 50, contentStoreDir: store })
    assert.equal(warm.stats.reused, 1)
    assert.equal(warm.stats.reparsed, 0)
    assert.equal(warm.index.files["src/a.mjs"].symbols[0].name, "calculateOrderTotal")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: same size and different content is never a false cache hit", async () => {
  const root = await temp("samesize")
  try {
    clearSemanticIndexRuntimeCache()
    const store = path.join(root, "store")
    await mkdir(path.join(root, "src"), { recursive: true })
    const before = "export function staleSymbolName() {\n  return 1\n}\n"
    const after = "export function freshSymbolName() {\n  return 2\n}\n"
    assert.equal(Buffer.byteLength(before), Buffer.byteLength(after), "fixture must keep the byte length identical")
    await writeFile(path.join(root, "src", "a.mjs"), before, "utf8")
    const cold = await buildSemanticIndex(root, { rebuild: true, maxFiles: 50, contentStoreDir: store })
    assert.equal(cold.index.files["src/a.mjs"].symbols[0].name, "staleSymbolName")

    // Restore the exact previous mtime: the old size+mtime signature would call
    // this unchanged. Content identity must not.
    const target = path.join(root, "src", "a.mjs")
    const previous = await stat(target)
    await writeFile(target, after, "utf8")
    await utimes(target, previous.atime, previous.mtime)

    const warm = await buildSemanticIndex(root, { maxFiles: 50, contentStoreDir: store })
    assert.equal(warm.stats.reused, 0, "identical size plus identical mtime must still reparse")
    assert.equal(warm.stats.reparsed, 1)
    const entry = warm.index.files["src/a.mjs"]
    assert.equal(entry.symbols[0].name, "freshSymbolName")
    assert.equal(entry.symbols.some((item) => item.name === "staleSymbolName"), false, "stale symbols must never survive")

    const query = await querySemanticIndex(root, "staleSymbolName", { builtIndex: warm })
    assert.equal(query.results.some((item) => item.path === "src/a.mjs"), false)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: a touched mtime with identical content reuses the artifact", async () => {
  const root = await temp("mtime")
  try {
    clearSemanticIndexRuntimeCache()
    const store = path.join(root, "store")
    await mkdir(path.join(root, "src"), { recursive: true })
    const file = path.join(root, "src", "a.mjs")
    await writeFile(file, SOURCE, "utf8")
    await buildSemanticIndex(root, { rebuild: true, maxFiles: 50, contentStoreDir: store })

    const future = new Date(Date.now() + 120_000)
    await utimes(file, future, future)
    const warm = await buildSemanticIndex(root, { maxFiles: 50, contentStoreDir: store })
    assert.equal(warm.stats.reparsed, 0, "an mtime bump with identical bytes must not reparse")
    assert.equal(warm.stats.reused, 1)
    assert.equal(warm.index.files["src/a.mjs"].symbols[0].name, "calculateOrderTotal")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: a rename keeps the artifact and rebinds the path", async () => {
  const root = await temp("rename")
  try {
    clearSemanticIndexRuntimeCache()
    const store = path.join(root, "store")
    await mkdir(path.join(root, "src", "utils"), { recursive: true })
    await writeFile(path.join(root, "src", "utils", "money.mjs"), SOURCE, "utf8")
    const before = await buildSemanticIndex(root, { rebuild: true, maxFiles: 50, contentStoreDir: store })

    await rename(path.join(root, "src", "utils", "money.mjs"), path.join(root, "src", "utils", "currency.mjs"))
    const after = await buildSemanticIndex(root, { maxFiles: 50, contentStoreDir: store })
    assert.equal(after.stats.reparsed, 0, "a rename must reuse the parsed artifact")
    assert.equal(after.stats.removed, 1)
    assert.equal(after.index.files["src/utils/money.mjs"], undefined)
    assert.equal(after.index.files["src/utils/currency.mjs"].artifactId, before.index.files["src/utils/money.mjs"].artifactId)
    assert.equal(after.index.files["src/utils/currency.mjs"].symbols[0].name, "calculateOrderTotal")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: a second git worktree reuses the same blob", async () => {
  const main = await repoWithFile("worktree-main", "src/a.mjs", SOURCE)
  let linked = null
  try {
    clearSemanticIndexRuntimeCache()
    const store = resolveContentStoreDir(main)
    const first = await buildSemanticIndex(main, { rebuild: true, maxFiles: 50, gitBlobIndex: true })
    assert.equal(first.stats.reparsed, 1)
    assert.equal(first.index.files["src/a.mjs"].hashSource, "git-blob", "a clean tracked file must use the git blob fast path")
    // A cold build must read once to parse; what the fast path removes is the
    // hash read, so a warm rebuild of the same clean file must read nothing.
    const warm = await buildSemanticIndex(main, { maxFiles: 50, gitBlobIndex: true })
    assert.equal(warm.stats.reparsed, 0)
    assert.equal(warm.stats.bytesRead, 0, "a warm rebuild of clean content must not read any file")

    const parent = await temp("worktree-parent")
    linked = path.join(parent, "sandbox")
    assert.equal(git(main, ["worktree", "add", "-q", "-b", "sandbox", linked]).status, 0)

    // A second checkout, its own empty workspace cache, identical blob. Anything
    // reused here came from the shared content-addressed store.
    const second = await buildSemanticIndex(linked, { rebuild: true, maxFiles: 50, gitBlobIndex: true })
    assert.equal(second.stats.reparsed, 0, "an identical blob in another worktree must not be reparsed")
    assert.equal(second.stats.reused, 1)
    assert.equal(second.index.files["src/a.mjs"].artifactId, first.index.files["src/a.mjs"].artifactId)
    assert.equal(second.index.files["src/a.mjs"].symbols[0].name, "calculateOrderTotal")
    assert.equal(resolveContentStoreDir(linked), store, "worktrees must share one content store")

    // Default policy: no git process is spawned and every file is hashed. That
    // is the most trustworthy mode and it measured faster on a 324-file
    // repository, so it is what the runtime uses unless a caller opts in.
    const hashed = await buildSemanticIndex(main, { maxFiles: 50 })
    assert.equal(hashed.stats.contentHashSource["git-blob"], 0)
    assert.equal(hashed.stats.contentHashSource.sha256, 1)
    assert.equal(hashed.index.files["src/a.mjs"].hashSource, "sha256")
    assert.equal(hashed.index.files["src/a.mjs"].symbols[0].name, "calculateOrderTotal")
  } finally {
    clearContentArtifactMemory()
    if (linked) await rm(path.dirname(linked), { recursive: true, force: true }).catch(() => {})
    await rm(main, { recursive: true, force: true }).catch(() => {})
  }
})

test("V15.3 content artifacts: a dirty tracked file hashes its actual content", async () => {
  const root = await repoWithFile("dirty", "src/a.mjs", SOURCE)
  try {
    clearSemanticIndexRuntimeCache()
    const before = await buildSemanticIndex(root, { rebuild: true, maxFiles: 50, gitBlobIndex: true })
    assert.equal(before.index.files["src/a.mjs"].hashSource, "git-blob")

    const changed = SOURCE.replace("calculateOrderTotal", "calculateOrderTotalV2")
    assert.notEqual(changed, SOURCE)
    await writeFile(path.join(root, "src", "a.mjs"), changed, "utf8")

    const after = await buildSemanticIndex(root, { maxFiles: 50, gitBlobIndex: true })
    const entry = after.index.files["src/a.mjs"]
    assert.equal(entry.hashSource, "sha256", "a dirty file must not be answered from the index blob")
    assert.equal(entry.contentHash, contentHashOf(changed))
    assert.equal(entry.symbols[0].name, "calculateOrderTotalV2")
    assert.notEqual(entry.artifactId, before.index.files["src/a.mjs"].artifactId)

    // Strict mode forces a content hash even for a clean file.
    const strict = await buildSemanticIndex(root, { maxFiles: 50, gitBlobIndex: true, strictHash: true })
    assert.equal(strict.index.files["src/a.mjs"].hashSource, "sha256")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: staged and working-tree content are distinguished", async () => {
  const root = await repoWithFile("staged", "src/a.mjs", SOURCE)
  try {
    clearSemanticIndexRuntimeCache()
    await buildSemanticIndex(root, { rebuild: true, maxFiles: 50, gitBlobIndex: true })

    const staged = SOURCE.replace("calculateOrderTotal", "stagedOnlySymbol")
    await writeFile(path.join(root, "src", "a.mjs"), staged, "utf8")
    git(root, ["add", "--", "src/a.mjs"])

    // Staged but not further modified in the worktree: the worktree still holds
    // the staged bytes, so the index blob is the correct content identity.
    const afterStage = await buildSemanticIndex(root, { maxFiles: 50, gitBlobIndex: true })
    assert.equal(afterStage.index.files["src/a.mjs"].hashSource, "git-blob")
    assert.equal(afterStage.index.files["src/a.mjs"].symbols[0].name, "stagedOnlySymbol")

    // Now modify the worktree without staging: that content must win.
    const working = SOURCE.replace("calculateOrderTotal", "workingTreeSymbol")
    await writeFile(path.join(root, "src", "a.mjs"), working, "utf8")
    const afterWorktree = await buildSemanticIndex(root, { maxFiles: 50, gitBlobIndex: true })
    assert.equal(afterWorktree.index.files["src/a.mjs"].hashSource, "sha256")
    assert.equal(afterWorktree.index.files["src/a.mjs"].symbols[0].name, "workingTreeSymbol")
    assert.equal(afterWorktree.index.files["src/a.mjs"].contentHash, contentHashOf(working))
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: an untracked file is hashed from disk, never from an index entry", async () => {
  const root = await repoWithFile("untracked", "src/tracked.mjs", SOURCE)
  try {
    clearSemanticIndexRuntimeCache()
    const loose = "export function untrackedSymbol() { return 1 }\n"
    await writeFile(path.join(root, "src", "loose.mjs"), loose, "utf8")
    const built = await buildSemanticIndex(root, { rebuild: true, maxFiles: 50 })
    const entry = built.index.files["src/loose.mjs"]
    assert.equal(entry.hashSource, "sha256")
    assert.equal(entry.contentHash, contentHashOf(loose))
    assert.equal(entry.symbols[0].name, "untrackedSymbol")

    // Outside a repository the git fast path is unavailable and everything is
    // hashed; the store stays workspace-local so a throwaway sandbox cannot
    // seed a global cache.
    const plain = await temp("nongit")
    await mkdir(path.join(plain, "src"), { recursive: true })
    await writeFile(path.join(plain, "src", "a.mjs"), SOURCE, "utf8")
    const plainBuild = await buildSemanticIndex(plain, { rebuild: true, maxFiles: 50 })
    assert.equal(plainBuild.index.files["src/a.mjs"].hashSource, "sha256")
    assert.equal(resolveContentStoreDir(plain), path.join(plain, ".ues-cache", "content-artifacts"))
    await rm(plain, { recursive: true, force: true })
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: an artifact schema change invalidates deterministically", async () => {
  const root = await temp("schema")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const artifactId = artifactIdFor({ contentHash: "abc", profile: "js" })
    await writeContentArtifact(store, artifactId, {
      contentHash: "abc", profile: "js", bytes: 3, symbols: [{ name: "old" }], identifiers: {},
    })
    const hit = await loadOrParseArtifact({ dir: store, artifactId, parse: async () => { throw new Error("must not parse") } })
    assert.equal(hit.artifact.symbols[0].name, "old")

    // A different schema version is a different key, so the old bytes are
    // unreachable rather than reinterpreted.
    const bumped = artifactIdFor({ contentHash: "abc", profile: "js", schemaVersion: ARTIFACT_SCHEMA_VERSION + 1 })
    assert.notEqual(bumped, artifactId)
    const miss = await loadOrParseArtifact({
      dir: store,
      artifactId: bumped,
      parse: async () => ({ contentHash: "abc", profile: "js", bytes: 3, symbols: [{ name: "new" }], identifiers: {} }),
    })
    assert.equal(miss.outcome, "reparsed")
    assert.equal(miss.artifact.symbols[0].name, "new")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: a corrupt artifact degrades to a rebuild", async () => {
  const root = await temp("corrupt")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const artifactId = artifactIdFor({ contentHash: "deadbeef", profile: "js" })
    const file = path.join(store, "v" + ARTIFACT_SCHEMA_VERSION, artifactId.slice(0, 2), artifactId + ".json")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "{ this is not json", "utf8")
    resetContentArtifactMetrics()

    const outcome = await loadOrParseArtifact({
      dir: store,
      artifactId,
      parse: async () => ({ contentHash: "deadbeef", profile: "js", bytes: 2, symbols: [{ name: "recovered" }], identifiers: {} }),
    })
    assert.equal(outcome.outcome, "reparsed")
    assert.equal(outcome.artifact.symbols[0].name, "recovered")
    assert.ok(contentArtifactStoreStats().corruptArtifacts >= 1)

    // A structurally valid file with the wrong identity is also refused.
    await clearContentArtifactMemory()
    const impostor = JSON.parse(await readFile(file, "utf8"))
    await writeFile(file, JSON.stringify({ ...impostor, artifactId: "something-else" }), "utf8")
    const again = await loadOrParseArtifact({
      dir: store,
      artifactId,
      parse: async () => ({ contentHash: "deadbeef", profile: "js", bytes: 2, symbols: [{ name: "recovered" }], identifiers: {} }),
    })
    assert.equal(again.outcome, "reparsed")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: the memory cache is bounded", async () => {
  const root = await temp("memory")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limit = 8
    for (let index = 0; index < 40; index += 1) {
      const artifactId = artifactIdFor({ contentHash: "h" + index, profile: "js" })
      await writeContentArtifact(store, artifactId, {
        contentHash: "h" + index, profile: "js", bytes: 1, symbols: [{ name: "s" + index }], identifiers: {},
      }, { ...CONTENT_STORE_DEFAULTS, maxMemoryEntries: limit, gcEveryWrites: 1_000_000 })
    }
    assert.ok(
      contentArtifactStoreStats({ ...CONTENT_STORE_DEFAULTS, maxMemoryEntries: limit }).memoryEntries <= limit,
      "the memory cache must never exceed its cap",
    )
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: the disk store is bounded and GC removes only what exceeds policy", async () => {
  const root = await temp("gc")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const limits = { ...CONTENT_STORE_DEFAULTS, maxDiskEntries: 5, maxDiskBytes: 1e9, maxAgeDays: 30, gcEveryWrites: 1_000_000, maxMemoryEntries: 100 }
    for (let index = 0; index < 12; index += 1) {
      const artifactId = artifactIdFor({ contentHash: "g" + index, profile: "js" })
      await writeContentArtifact(store, artifactId, {
        contentHash: "g" + index, profile: "js", bytes: 1, symbols: [{ name: "s" + index }], identifiers: {},
      }, limits)
    }
    const before = await countArtifacts(store)
    assert.equal(before, 12)
    const result = await gcContentArtifacts(store, limits)
    const after = await countArtifacts(store)
    assert.equal(after, 5, "GC must enforce the entry cap")
    assert.equal(result.removed, before - after)

    // An age cap with a generous entry limit also removes, deterministically.
    const ageLimits = { ...limits, maxDiskEntries: 1000, maxAgeDays: 0 }
    const aged = await gcContentArtifacts(store, ageLimits)
    assert.ok(aged.removed > 0)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

// Counts ARTIFACT files only. Each shard also carries a `shard.json` accounting
// sidecar, and counting those would report the store as larger than it is.
async function countArtifacts(store) {
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

test("V15.3 content artifacts: concurrent demand for one artifact parses exactly once", async () => {
  const root = await temp("coalesce")
  try {
    clearContentArtifactMemory()
    const store = path.join(root, "store")
    const artifactId = artifactIdFor({ contentHash: "shared", profile: "js" })
    let parses = 0
    const parse = async () => {
      parses += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { contentHash: "shared", profile: "js", bytes: 6, symbols: [{ name: "onlyOnce" }], identifiers: {} }
    }
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      loadOrParseArtifact({ dir: store, artifactId, parse })))
    assert.equal(parses, 1, "eight concurrent requests must parse once")
    for (const row of results) assert.equal(row.artifact.symbols[0].name, "onlyOnce")
    assert.equal(results.filter((row) => row.outcome === "reparsed").length, 1)
    assert.equal(results.filter((row) => row.outcome === "coalesced").length, 7)

    // A second wave after the artifact exists is a plain hit, not a reparse.
    const again = await loadOrParseArtifact({ dir: store, artifactId, parse })
    assert.equal(again.outcome, "reused")
    assert.equal(parses, 1)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: Windows path separators normalise to the same identity", async () => {
  const root = await temp("windows")
  try {
    clearSemanticIndexRuntimeCache()
    const store = path.join(root, "store")
    await mkdir(path.join(root, "src", "nested"), { recursive: true })
    await writeFile(path.join(root, "src", "nested", "a.mjs"), SOURCE, "utf8")
    const built = await buildSemanticIndex(root, { rebuild: true, maxFiles: 50, contentStoreDir: store })
    const key = "src/nested/a.mjs"
    assert.equal(built.index.files[key].contentHash, contentHashOf(SOURCE))
    // The index is keyed by forward slashes regardless of platform.
    for (const file of Object.keys(built.index.files)) {
      assert.equal(file.includes("\\"), false, file)
    }
    const query = await querySemanticIndex(root, "calculateOrderTotal", { builtIndex: built })
    assert.equal(query.results[0].path, key)
    const status = await semanticIndexStatus(root)
    assert.equal(status.exists, true)
    assert.equal(status.schemaVersion, 3)
    assert.equal(status.artifactSchemaVersion, ARTIFACT_SCHEMA_VERSION)
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 content artifacts: index output is byte-identical across concurrency settings and repeats", async () => {
  const root = await temp("determinism")
  try {
    clearSemanticIndexRuntimeCache()
    await writeRetrievalFixture(root)
    const store = path.join(root, "store")
    const serial = await buildSemanticIndex(root, { rebuild: true, maxFiles: 200, ioConcurrency: 1, contentStoreDir: store })
    const parallel = await buildSemanticIndex(root, { maxFiles: 200, ioConcurrency: 16, contentStoreDir: store })
    const repeat = await buildSemanticIndex(root, { maxFiles: 200, ioConcurrency: 8, contentStoreDir: store })

    const strip = (built) => Object.fromEntries(
      Object.entries(built.index.files).map(([file, entry]) => [file, {
        contentHash: entry.contentHash,
        artifactId: entry.artifactId,
        profile: entry.profile,
        symbols: entry.symbols,
      }]),
    )
    assert.deepEqual(Object.keys(parallel.index.files), Object.keys(serial.index.files))
    assert.deepEqual(strip(parallel), strip(serial))
    assert.deepEqual(strip(repeat), strip(serial))
    assert.equal(parallel.stats.reparsed, 0, "a second build of unchanged content must parse nothing")
    assert.equal(repeat.stats.reparsed, 0)
    // Parser profile is part of identity, not a guess from the extension order.
    assert.equal(parserProfileFor(".mjs"), "js")
    assert.equal(parserProfileFor(".py"), "py")
    assert.equal(parserProfileFor(".kt"), "jvm")
    assert.equal(parserProfileFor(".unknown"), "default")
  } finally {
    clearContentArtifactMemory()
    await rm(root, { recursive: true, force: true })
  }
})
