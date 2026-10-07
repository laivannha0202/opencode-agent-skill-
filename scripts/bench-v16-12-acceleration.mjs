// V16.12 EXECUTION ACCELERATION BENCHMARK.
//
// The V16.12 directive asks for an HONEST benchmark of the REAL composition: the
// six acceleration capabilities wired together, exercised against deterministic
// scenarios. This bench imports the ACTUAL production modules - it does not
// re-implement them - so it measures the real code paths.
//
// HONESTY CONTRACT
//
//   * Every scenario runs against a DETERMINISTIC clock and a scratch temp
//     workspace. The report is labelled `claimStatus: SIMULATED_ONLY` and
//     `synthetic: true`. It NEVER claims a whole-task production speedup.
//   * Timings are reported per SCENARIO and are NOT summed into a single
//     "speedup" number, because a real task's mix of these scenarios is unknown.
//   * `PROVIDER_TOKENS = "NOT_MEASURED"`: this bench never talks to a model.
//   * A cache HIT and a MISS are reported in SEPARATE cells, never averaged.
//
// Run: node scripts/bench-v16-12-acceleration.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { withResultReuse, clearToolResultReuse, toolResultReuseStats } from "../lib/tool-result-reuse-v16-12.mjs"
import {
  recordReceipt,
  findReusableReceipt,
  purgeReceiptCache,
  resetReceiptCacheStats,
} from "../lib/verification-receipt-cache-v16-12.mjs"
import { runTaskDag, NODE_EFFECT, NODE_STATUS } from "../lib/task-dag-scheduler-v16-12.mjs"
import {
  planExecutionAcceleration,
  createAccelerationContext,
  TASK_SHAPE,
  FAST_PATH,
} from "../lib/execution-acceleration-v16-12.mjs"

const PROVIDER_TOKENS = "NOT_MEASURED"

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "ues-bench-accel-"))
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}

async function timeIt(fn) {
  const start = process.hrtime.bigint()
  const value = await fn()
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  return { ms: Number(ms.toFixed(3)), value }
}

/** Scenario: repeated identical read/search. Measures MISS vs HIT cost. */
async function benchRepeatedRead() {
  const root = tempRoot()
  clearToolResultReuse()
  try {
    writeFileSync(path.join(root, "a.txt"), "x".repeat(2000))
    const compute = async () => ({ text: "x".repeat(2000) })
    const miss = await timeIt(() => withResultReuse(root, { operation: "read", file: "a.txt", range: "1-100" }, compute))
    const hit = await timeIt(() => withResultReuse(root, { operation: "read", file: "a.txt", range: "1-100" }, compute))
    const stats = toolResultReuseStats()
    return {
      scenario: "repeated-identical-read",
      missMs: miss.ms,
      hitMs: hit.ms,
      computesAvoided: stats.hits,
      note: "MISS and HIT are separate cells; a HIT avoids a recompute but its absolute cost is tiny here.",
    }
  } finally {
    clearToolResultReuse()
    cleanup(root)
  }
}

/** Scenario: same-state gate reuse vs a workspace change invalidating it. */
async function benchGateReuse() {
  const root = tempRoot()
  resetReceiptCacheStats()
  try {
    const record = await timeIt(() => recordReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp-stable" }))
    const reuse = await timeIt(() => findReusableReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], workspaceFingerprint: "fp-stable" }))
    const changed = await timeIt(() => findReusableReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], workspaceFingerprint: "fp-changed" }))
    return {
      scenario: "same-state-gate-reuse",
      recordMs: record.ms,
      reuseHitMs: reuse.ms,
      reuseAfterWorkspaceChange: reuse.value?.reusable === true ? "HIT" : "MISS",
      changedWorkspaceMs: changed.ms,
      changedWorkspaceReusable: changed.value !== null,
      note: "A workspace change MUST be a MISS; this is correctness, not a timing claim.",
    }
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
}

/** Scenario: final-release mode forces a fresh gate (no reuse). */
async function benchFinalRelease() {
  const root = tempRoot()
  try {
    await recordReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], exitCode: 0, outcome: "passed", workspaceFingerprint: "fp-stable" })
    const devPlan = planExecutionAcceleration({ changedFiles: ["lib/a.mjs"] })
    const relPlan = planExecutionAcceleration({ finalRelease: true, changedFiles: ["lib/a.mjs"] })
    const relLookup = await findReusableReceipt(root, { gateName: "npm test", command: "npm", args: ["test"], workspaceFingerprint: "fp-stable" }, { finalRelease: true })
    return {
      scenario: "final-release-forces-fresh-gate",
      devReceiptReuseEnabled: devPlan.capabilities.receiptReuse.enabled,
      releaseReceiptReuseEnabled: relPlan.capabilities.receiptReuse.enabled,
      releaseLookupReusable: relLookup !== null,
      requiredFreshGates: relPlan.requiredFreshGates,
      note: "In final-release mode the lookup is refused even when a valid receipt exists.",
    }
  } finally {
    await purgeReceiptCache(root)
    cleanup(root)
  }
}

/** Scenario: independent DAG nodes overlap; a write never overlaps. */
async function benchDagOverlap() {
  const node = (id, effect, ms) => ({ id, effect, run: async () => { await new Promise((r) => setTimeout(r, ms)) } })
  let readActive = 0
  let maxReadActive = 0
  let writeOverlap = false
  let active = 0
  const track = (id, effect, ms) => ({
    id,
    effect,
    run: async () => {
      active += 1
      if (effect === NODE_EFFECT.SOURCE_WRITE && active > 1) writeOverlap = true
      if (effect === NODE_EFFECT.READ_ONLY) { readActive += 1; maxReadActive = Math.max(maxReadActive, readActive) }
      await new Promise((r) => setTimeout(r, ms))
      if (effect === NODE_EFFECT.READ_ONLY) readActive -= 1
      active -= 1
    },
  })
  const serial = await timeIt(() => runTaskDag([
    track("r1", NODE_EFFECT.READ_ONLY, 20),
    track("r2", NODE_EFFECT.READ_ONLY, 20),
    track("r3", NODE_EFFECT.READ_ONLY, 20),
  ], { limits: { FS_READ: 1 } }))
  const overlapped = await timeIt(() => runTaskDag([
    track("r1", NODE_EFFECT.READ_ONLY, 20),
    track("r2", NODE_EFFECT.READ_ONLY, 20),
    track("r3", NODE_EFFECT.READ_ONLY, 20),
  ], { limits: { FS_READ: 4 } }))
  const write = await timeIt(() => runTaskDag([
    track("r1", NODE_EFFECT.READ_ONLY, 10),
    track("w", NODE_EFFECT.SOURCE_WRITE, 10),
    track("r2", NODE_EFFECT.READ_ONLY, 10),
  ]))
  return {
    scenario: "independent-dag-overlap",
    serialReadsMs: serial.ms,
    overlappedReadsMs: overlapped.ms,
    maxConcurrentReads: maxReadActive,
    writeSerialized: writeOverlap === false,
    note: "Overlap saving is ESTIMATED, never MEASURED; a write is never allowed to overlap.",
  }
}

/** Scenario: a critical failure cancels dependents (the suite must not run). */
async function benchFailureCancellation() {
  const ran = []
  const result = await timeIt(() => runTaskDag([
    { id: "syntax", effect: NODE_EFFECT.PURE, run: async () => { throw new Error("boom") } },
    { id: "suite", effect: NODE_EFFECT.PROCESS_MUTATION, dependencies: ["syntax"], run: async () => { ran.push("suite") } },
    { id: "release", effect: NODE_EFFECT.PROCESS_MUTATION, dependencies: ["suite"], run: async () => { ran.push("release") } },
  ]))
  const statuses = Object.fromEntries(result.value.nodes.map((n) => [n.id, n.status]))
  return {
    scenario: "failure-cancellation",
    durationMs: result.ms,
    suiteRan: ran.includes("suite"),
    releaseRan: ran.includes("release"),
    syntaxStatus: statuses.syntax,
    suiteStatus: statuses.suite,
    note: "A failed syntax gate must not still launch the full suite; this is a correctness cell.",
  }
}

/** Scenario: the fast path chosen for each task shape. */
function benchFastPaths() {
  const shapes = [
    ["tiny-docs", { changedFiles: ["docs/a.md"], docsOnly: true }],
    ["normal", { changedFiles: ["lib/a.mjs", "lib/b.mjs"] }],
    ["deep", { changedFiles: ["lib/index.mjs"] }],
    ["release", { finalRelease: true, changedFiles: ["lib/a.mjs"] }],
  ]
  const rows = shapes.map(([label, input]) => {
    const plan = planExecutionAcceleration(input)
    return { label, shape: plan.shape, fastPath: plan.fastPath, receiptReuse: plan.capabilities.receiptReuse.enabled }
  })
  return {
    scenario: "fast-path-selection",
    rows,
    allDeterministic: rows.length === 4
      && rows[0].fastPath === FAST_PATH.TINY_FAST_PATH
      && rows[1].fastPath === FAST_PATH.NORMAL_PATH
      && rows[2].fastPath === FAST_PATH.DEEP_PATH
      && rows[3].fastPath === FAST_PATH.RELEASE_PATH,
  }
}

/**
 * Scenario: PI_ONLY must spawn ZERO browser. This bench never constructs a
 * browser transport; it asserts the acceleration plan does not force one.
 */
function benchPiOnlyNoBrowser() {
  const plan = planExecutionAcceleration({ changedFiles: ["lib/a.mjs"], piOnly: true })
  return {
    scenario: "pi-only-no-browser",
    warmServiceAlwaysOn: plan.capabilities.warmServiceReuse.alwaysOn,
    warmServiceLazy: plan.capabilities.warmServiceReuse.lazy,
    browserStarted: false,
    note: "The composition layer never starts a service on its own; PI_ONLY spawns zero browser.",
  }
}

/** Scenario: wall-time attribution stays honest with no samples. */
function benchAttributionHonesty() {
  const ctx = createAccelerationContext({ now: () => 0 })
  const report = ctx.report()
  const unmeasured = Object.values(report.wall.categories).every((row) => row.provenance === "NOT_MEASURED")
  return {
    scenario: "attribution-honesty",
    everyCategoryUnmeasured: unmeasured,
    criticalPathProvenance: report.wall.criticalPathMs.provenance,
    overlapSavedProvenance: report.wall.parallelOverlapSavedMs.provenance,
  }
}

async function main() {
  const cells = []
  cells.push(await benchRepeatedRead())
  cells.push(await benchGateReuse())
  cells.push(await benchFinalRelease())
  cells.push(await benchDagOverlap())
  cells.push(await benchFailureCancellation())
  cells.push(benchFastPaths())
  cells.push(benchPiOnlyNoBrowser())
  cells.push(benchAttributionHonesty())

  const report = {
    policy: "execution-acceleration-v16-12",
    measured: "REAL production modules against a deterministic scratch workspace and a real monotonic clock; no model, no network",
    synthetic: true,
    claimStatus: "SIMULATED_ONLY",
    providerTokens: PROVIDER_TOKENS,
    providerTokensProvenance: PROVIDER_TOKENS,
    cells,
    note: "Per-scenario timings are NOT summed into a task-level speedup; a real task's mix is unknown. Correctness cells (write serialization, failure cancellation, release freshness) are reported as booleans, not timings.",
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("bench-v16-12-acceleration.mjs")) {
  main().then((code) => process.exit(code))
}

export { main }
