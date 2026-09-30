// Content-addressed semantic-index benchmark (V15.3 Phase 2).
//
//   node scripts/bench-content-index.mjs [--json] [--root <fixture-root>]
//
// The question this benchmark answers is narrow and falsifiable: does a parsed
// artifact get reused when the *content* is unchanged, and does it get
// correctly refused when only the metadata changed?
//
// Cases, in order, against one generated fixture workspace plus a second
// checkout that holds byte-identical files:
//
//   cold            first build, no prior cache
//   warm-unchanged  immediate rebuild, nothing touched
//   touch-mtime     mtime bumped, content identical
//   same-size       content changed, byte length identical   <- false-hit guard
//   rename          same content, different path
//   second-checkout identical content under a different root (worktree/sandbox)
//
// `bytesRead` is the load-bearing metric. The pre-patch runtime reads a file
// only when it decides to reparse, so its true bytes-read is exactly the sum of
// the reparsed files' sizes and can be derived from outside the process. The
// post-patch runtime reports it directly. Whichever applies is labelled in
// `metricSource` so the two receipts cannot be silently compared.

import path from "node:path"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import { buildSemanticIndex, clearSemanticIndexRuntimeCache } from "../lib/semantic-index.mjs"
import { writeRetrievalFixture, RETRIEVAL_FIXTURE_FILES } from "../evals/retrieval/fixture.mjs"
import {
  argValue,
  dirBytes,
  optionalModule,
  printReceipt,
  round,
  sumBytes,
  timed,
  withTempDir,
} from "./bench-common.mjs"

const SOURCE_FILES = RETRIEVAL_FIXTURE_FILES.filter(
  (relative) => /\.(mjs|js|ts|py)$/.test(relative),
)

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true })
  return result.status
}

// The fixture is a real git repository on purpose. UES requires a git workspace
// root, so a git checkout is the production shape, and it is the shape where the
// content-addressed identity can answer "unchanged" without reading the file.
// A plain directory is measured too, as `non-git-warm`, because that case pays a
// full content hash per file and the cost belongs in the receipt rather than in
// a footnote.
async function commitFixture(root) {
  if (git(root, ["init", "-q", "-b", "main"]) !== 0) return false
  git(root, ["config", "user.email", "ues@example.invalid"])
  git(root, ["config", "user.name", "UES Bench"])
  git(root, ["add", "-A", "--", "."])
  if (git(root, ["commit", "-qm", "fixture"]) !== 0) return false
  return true
}

function indexStats(reparsed) {
  return { files: reparsed, reused: 0, reparsed, removed: 0, skippedLarge: 0 }
}

async function measureCase(root, label, options) {
  const { ms, value } = await timed(() => buildSemanticIndex(root, options))
  const stats = value.stats
  const reportedBytes = Number(stats.bytesRead)
  const derivedBytes = options.__derivable
    ? await sumBytes(options.__derivable, root)
    : null
  const bytesRead = Number.isFinite(reportedBytes)
    ? reportedBytes
    : Number(derivedBytes || 0)
  return {
    case: label,
    ms,
    files: stats.files,
    reused: stats.reused,
    reparsed: stats.reparsed,
    removed: stats.removed,
    skippedLarge: stats.skippedLarge,
    bytesRead,
    metricSource: Number.isFinite(reportedBytes) ? "runtime-stat" : "derived-from-reparsed-files",
    contentHashSource: stats.contentHashSource || null,
    contentArtifactHits: Number(stats.contentArtifactHits || 0),
    contentArtifactMisses: Number(stats.contentArtifactMisses || 0),
    contentArtifacts: Number(stats.contentArtifacts || 0),
    contentArtifactEvictions: Number(stats.contentArtifactEvictions || 0),
    cacheBytes: await dirBytes(path.join(root, ".ues-cache")).catch(() => 0),
  }
}

async function run(root) {
  await writeRetrievalFixture(root)
  const isGit = await commitFixture(root)
  const shared = argValue("--content-store", null)
  const useGitBlob = process.argv.includes("--git-blob")

  // A dedicated store keeps the fixture reproducible and keeps the benchmark's
  // artifacts out of the real user cache. It is created under the same temp
  // parent as the fixture and removed in `finally`, so a run can never inherit
  // artifacts from a previous run and report a "cold" build as warm.
  const storeHome = path.join(path.dirname(root), "v153-store")
  const second = path.join(path.dirname(root), path.basename(root) + "-checkout")
  try {
    await mkdir(second, { recursive: true })
    await writeRetrievalFixture(second)
    await commitFixture(second)
    // The real runtime resolves one shared store for every worktree of a
    // repository; that is exactly what the second checkout must hit.
    const base = {
      maxFiles: 500,
      ioConcurrency: 8,
      contentStoreDir: shared || storeHome,
      gitBlobIndex: useGitBlob,
    }
    const cases = []

    cases.push(await measureCase(root, "cold", { ...base, rebuild: true, __derivable: SOURCE_FILES }))

    cases.push(await measureCase(root, "warm-unchanged", { ...base, __derivable: [] }))

    // mtime churn with identical bytes: the pre-patch signature treats this as
    // changed, a content-addressed artifact must not.
    const mtimeSource = path.join(root, ...SOURCE_FILES[0].split("/"))
    const future = new Date(Date.now() + 5_000)
    await utimes(mtimeSource, future, future)
    cases.push(await measureCase(root, "touch-mtime", { ...base, __derivable: [SOURCE_FILES[0]] }))

    // Same byte length, different content: the decisive false-hit guard.
    const equalSource = SOURCE_FILES.find((relative) => relative.endsWith("money.mjs"))
    await writeFile(
      path.join(root, ...equalSource.split("/")),
      'export function roundCurrency(value) {\n  return Math.floor(value * 100) / 100\n}\n',
      "utf8",
    )
    cases.push(await measureCase(root, "same-size-different-content", { ...base, __derivable: [equalSource] }))

    // Rename with identical content: artifact reuse, new path binding.
    const renamed = "packages/core/src/utils/money-renamed.mjs"
    await writeFile(
      path.join(root, ...renamed.split("/")),
      'export function roundCurrency(value) {\n  return Math.floor(value * 100) / 100\n}\n',
      "utf8",
    )
    cases.push(await measureCase(root, "rename-same-content", { ...base, __derivable: [renamed] }))

    // A second checkout holding byte-identical content is the cross-worktree
    // case. It has its own empty cache, so anything reused came from the
    // shared content-addressed store, not from workspace metadata.
    const other = path.join(second, ...equalSource.split("/"))
    await writeFile(other, 'export function roundCurrency(value) {\n  return Math.floor(value * 100) / 100\n}\n', "utf8")
    cases.push(await measureCase(second, "second-checkout-same-content", { ...base, __derivable: [equalSource] }))

    // Control: the second checkout's own cache is now warm, so this must be a
    // no-op. It proves a zero is real reuse and not a missing measurement.
    cases.push(await measureCase(second, "second-checkout-warm", { ...base, __derivable: [] }))

    // Honest cost case: a workspace with no git identity cannot use the blob
    // fast path, so every warm build pays one full content hash per file.
    const plain = path.join(path.dirname(root), path.basename(root) + "-nogit")
    await mkdir(plain, { recursive: true })
    await writeRetrievalFixture(plain)
    const plainBase = { maxFiles: 500, ioConcurrency: 8, contentStoreDir: storeHome, gitBlobIndex: useGitBlob }
    await measureCase(plain, "non-git-cold", { ...plainBase, rebuild: true, __derivable: SOURCE_FILES })
    cases.push(await measureCase(plain, "non-git-warm", { ...plainBase, __derivable: [] }))
    await rm(plain, { recursive: true, force: true }).catch(() => {})

    const total = cases.reduce(
      (sum, row) => ({
        reparsed: sum.reparsed + row.reparsed,
        bytesRead: sum.bytesRead + row.bytesRead,
        ms: round(sum.ms + row.ms),
      }),
      { reparsed: 0, bytesRead: 0, ms: 0 },
    )

    return {
      schemaVersion: 1,
      kind: "ues-content-index-benchmark",
      node: process.version,
      gitFixture: isGit,
      gitBlobFastPath: useGitBlob,
      fixtureFiles: RETRIEVAL_FIXTURE_FILES.length,
      sourceFiles: SOURCE_FILES.length,
      cases,
      totals: total,
    }
  } finally {
    await rm(storeHome, { recursive: true, force: true }).catch(() => {})
    await rm(second, { recursive: true, force: true }).catch(() => {})
  }
}

clearSemanticIndexRuntimeCache()
const receipt = await withTempDir("index", run)
printReceipt(receipt)
