// V16.15 Parallel Execution Economy Policy.
//
// WHY THIS MODULE EXISTS
//
// V16.15 makes UES execute a whole task in one shot with bounded parallel
// writers. Parallelism is not free: every child costs a process start, a fresh
// context rebuild, a worktree, a targeted verification run and a token budget.
// Spawning two children to make two five-line edits is SLOWER than doing them
// directly, and it burns more context. Without ONE deterministic owner of that
// trade-off, "parallelize" becomes a benchmark trick instead of an engineering
// decision.
//
// This module is that owner. It answers exactly one question:
//
//   "For THIS task, at THIS point in its lifecycle, is parallelism actually
//    economical - and if so, which KIND of parallelism?"
//
// It never spawns anything, never writes anything and never verifies anything.
// The existing owners keep their authority:
//
//   * lib/incremental-verification-v16-12.mjs  task SHAPE classification
//   * lib/execution-conflict-graph-v16-15.mjs  pairwise independence
//   * lib/delegation-fleet.mjs                 bounded child execution
//   * lib/worktree-sandbox.mjs                 isolation + integration
//   * lib/task-graph.mjs                       wave ORDER
//
// TASK SHAPES (V16.15 adds SMALL / DECOMPOSABLE / COMPLEX around the V16.12 set)
//
//   TINY          one file / docs / version marker. Parent direct. Zero children.
//   SMALL         a couple of files, no independent outputs. Parent direct.
//   NORMAL        a few files; read-only overlap may help, one writer.
//   DECOMPOSABLE  two or more PROVABLY independent write scopes with their own
//                 acceptance criteria and their own targeted verification.
//   COMPLEX       many files / cross-module; bounded parallel + escalation.
//   RELEASE       final release. Correctness first; unsafe mutation never
//                 parallelized.
//
// ECONOMY OUTCOMES
//
//   PARENT_DIRECT      do it in the parent; no child, no sandbox
//   PARALLEL_READ_ONLY reads/discovery overlap only; still one writer
//   PARALLEL_WRITERS   two or more isolated worktree writers, bounded
//   SERIAL_STRUCTURED  the work must be sequenced (dependency or conflict)
//
// ECONOMY LAWS
//
//   1. A TINY or SMALL task NEVER spawns a child. This is a hard structural
//      invariant, not a heuristic: the shape is derived from declared file count
//      and risk, and the decision is refused when the shape is tiny/small.
//   2. ESTIMATED BENEFIT MUST EXCEED ESTIMATED OVERHEAD. The gate computes both
//      from the SAME declared inputs using explicit constants, so a marginal
//      case deterministically serializes instead of gambling.
//   3. MEASURED HISTORY IS OPTIONAL AND BOUNDED. When the caller supplies real
//      history, it may only ADJUST the concurrency within the configured bound;
//      it can never turn a TINY task into a parallel one, and it can never raise
//      the hard cap.
//   4. NO TOKEN CLAIM. This module never asserts a token saving. It reports
//      chars it can actually measure and leaves provider tokens NOT_MEASURED.
//   5. UNKNOWN SCOPE FAILS CONSERVATIVE. An unproven independence is a conflict.

import { measured, derived, estimated, NOT_MEASURED } from "./measurement-provenance.mjs"
import { classifyTaskShape as classifyV16_12Shape, TASK_SHAPE as V16_12_TASK_SHAPE } from "./incremental-verification-v16-12.mjs"
import {
  SCOPE_CERTAINTY,
  buildConflictGraph,
  isWriterScope,
} from "./execution-conflict-graph-v16-15.mjs"

export const PARALLEL_EXECUTION_POLICY_ID = "parallel-execution-policy-v16-15"
export const PARALLEL_EXECUTION_SCHEMA_VERSION = 1

/** V16.15 task shapes. Superset of the V16.12 shapes. */
export const TASK_SHAPE_V16_15 = Object.freeze({
  TINY: "TINY",
  SMALL: "SMALL",
  NORMAL: "NORMAL",
  DECOMPOSABLE: "DECOMPOSABLE",
  COMPLEX: "COMPLEX",
  RELEASE: "RELEASE",
})

/** What kind of parallelism the task gets. */
export const EXECUTION_POSTURE = Object.freeze({
  PARENT_DIRECT: "PARENT_DIRECT",
  PARALLEL_READ_ONLY: "PARALLEL_READ_ONLY",
  PARALLEL_WRITERS: "PARALLEL_WRITERS",
  SERIAL_STRUCTURED: "SERIAL_STRUCTURED",
})

/** Shapes that may NEVER spawn a child, whatever else is true. */
export const PARENT_DIRECT_SHAPES = Object.freeze([TASK_SHAPE_V16_15.TINY, TASK_SHAPE_V16_15.SMALL])

// ---------------------------------------------------------------------------
// explicit economy constants (no magic numbers at the decision site)
// ---------------------------------------------------------------------------

/**
 * Estimated one-time overhead of starting ONE isolated writer child, in
 * milliseconds. DERIVED from measured component costs observed on this project
 * (Windows, Node 24): `git worktree add` + snapshot inheritance dominates,
 * followed by child process start and the child's fresh context build.
 *
 * This is an ESTIMATE used only for a structural comparison against the
 * estimated benefit. It is never reported as a measured saving.
 */
export const CHILD_OVERHEAD_ESTIMATE_MS = Object.freeze({
  processStart: 900,
  contextBuild: 600,
  sandboxCreate: 1_400,
  targetedVerify: 1_200,
  integration: 500,
})

export function childOverheadEstimateMs() {
  return Object.values(CHILD_OVERHEAD_ESTIMATE_MS).reduce((sum, value) => sum + value, 0)
}

/**
 * Wall-time a single child saves by running concurrently instead of after the
 * parent finishes. Only the portion of a child's work that OVERLAPS with other
 * work is a saving, so the estimate is deliberately conservative: a child must
 * be expected to do at least this much sequential work for parallelism to pay.
 */
export const MIN_MEANINGFUL_CHILD_WORK_MS = 4_000

/**
 * Hard writer concurrency bound. Windows default is 2 by the V16.15 directive:
 * the platform's filesystem/process contention makes 3+ writers unstable on
 * NTFS + Defender, and the existing V16.5 fleet cap is 3.
 */
export const WRITER_CONCURRENCY = Object.freeze({
  default: 2,
  hardMax: 3,
  readOnlyDefault: 4,
  readOnlyHardMax: 6,
})

/** Resolve the writer concurrency bound for this platform + explicit request. */
export function resolveWriterConcurrency(requested, options = {}) {
  const platform = options.platform || process.platform
  const platformDefault = platform === "win32" ? 2 : 3
  const fallback = Math.min(platformDefault, WRITER_CONCURRENCY.default)
  const parsed = Number(requested)
  const base = Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : fallback
  return Math.max(1, Math.min(WRITER_CONCURRENCY.hardMax, base))
}

/** Resolve the read-only lane bound. */
export function resolveReadOnlyConcurrency(requested) {
  const parsed = Number(requested)
  const base = Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : WRITER_CONCURRENCY.readOnlyDefault
  return Math.max(1, Math.min(WRITER_CONCURRENCY.readOnlyHardMax, base))
}

// ---------------------------------------------------------------------------
// shape classification
// ---------------------------------------------------------------------------

function unique(values) {
  return [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))]
}

/**
 * The exact edge knowledge the caller declared, in ONE place.
 *
 * A declared dependency that this module forgets to pass to the conflict graph
 * is an INVISIBLE dependency, and an invisible dependency is how a parallel
 * writer overwrites its sibling. Every graph this module builds therefore goes
 * through here, so the verdict and the reported graph can never disagree.
 */
function graphOptionsFor(input = {}, fallbackMaxParallel) {
  const options = input.options || {}
  const moduleEdges = options.moduleEdges ?? input.moduleEdges
  const generatedEdges = options.generatedEdges ?? input.generatedEdges
  return {
    maxParallel: fallbackMaxParallel,
    moduleEdges: Array.isArray(moduleEdges) ? moduleEdges : [],
    generatedEdges: Array.isArray(generatedEdges) ? generatedEdges : [],
  }
}

/**
 * Classify the V16.15 task shape.
 *
 * It EXTENDS the V16.12 classifier rather than replacing it: the V16.12 shape
 * (TINY/NORMAL/DEEP/RELEASE) is computed by its owner and then refined into the
 * V16.15 vocabulary using the independence information V16.12 does not have.
 *
 * @param {object} input
 * @param {string[]} [input.changedFiles]   every file the task will touch
 * @param {object[]} [input.scopes]         declared write scopes (see conflict graph)
 * @param {string}  [input.risk]
 * @param {boolean} [input.docsOnly]
 * @param {boolean} [input.crossModule]
 * @param {boolean} [input.finalRelease]
 * @param {boolean} [input.verifierFailed]
 */
export function classifyTaskShapeV16_15(input = {}) {
  const finalRelease = input.finalRelease === true
  const risk = String(input.risk || "").toLowerCase()
  const changed = unique(input.changedFiles)
  const scopes = Array.isArray(input.scopes) ? input.scopes : []

  const baseShape = classifyV16_12Shape({
    changedFiles: changed,
    risk: input.risk,
    docsOnly: input.docsOnly,
    crossModule: input.crossModule,
    verifierFailed: input.verifierFailed,
    finalRelease,
  })

  if (finalRelease) {
    return {
      shape: TASK_SHAPE_V16_15.RELEASE,
      baseShape,
      reason: "final release; correctness first, unsafe release mutation is never parallelized",
      changedFileCount: changed.length,
      declaredScopeCount: scopes.length,
      deterministic: true,
    }
  }

  const writers = scopes.filter((scope) => isWriterScope(scope))
  const writerCount = writers.length
  const graph = scopes.length >= 2
    ? buildConflictGraph(scopes, graphOptionsFor(input, WRITER_CONCURRENCY.hardMax))
    : null
  const independentWriters = graph
    ? graph.scopes.filter((row) => row.writer && row.certainty === SCOPE_CERTAINTY.INDEPENDENT).length
    : 0

  // The effective CHANGE SURFACE. A declared write scope is authoritative over a
  // file-count hint, because it is the caller's explicit statement about what
  // will be mutated. When no scope is declared, the file list is used.
  const declaredWriteSurface = unique(writers.flatMap((scope) => scope?.writeFiles || scope?.files || []))
  const surface = declaredWriteSurface.length ? declaredWriteSurface : changed

  // SHAPE RULES. Ordered so that the MOST SPECIFIC structural fact wins:
  //
  //   TINY          exactly one output, one writer, and nothing else declared.
  //                 A single output cannot contain independent work, so this is
  //                 ALWAYS parent-direct.
  //   SMALL         at most two outputs, one writer, nothing else declared.
  //                 Parent-direct.
  //   DECOMPOSABLE  two or more PROVABLY independent writer scopes over two or
  //                 more distinct outputs.
  //   COMPLEX       deep / high-risk / cross-module surface.
  //   NORMAL        everything else: a larger single-writer surface, a declared
  //                 read-only companion lane, or multiple declared writers that
  //                 are NOT provably independent (so the work must be sequenced).
  //   RELEASE       final release.
  const singleWriterOnly = writerCount <= 1 && scopes.length <= 1
  const shape =
    baseShape === V16_12_TASK_SHAPE.RELEASE
      ? TASK_SHAPE_V16_15.RELEASE
      : independentWriters >= 2 && surface.length >= 2
        ? TASK_SHAPE_V16_15.DECOMPOSABLE
        : baseShape === V16_12_TASK_SHAPE.DEEP || risk === "high" || risk === "critical" || input.crossModule === true
          ? TASK_SHAPE_V16_15.COMPLEX
          : writerCount >= 2
            // Multiple declared writers that are NOT provably independent: the
            // work is real but it must be sequenced, so it is never SMALL.
            ? TASK_SHAPE_V16_15.NORMAL
            : singleWriterOnly && surface.length <= 1
              ? TASK_SHAPE_V16_15.TINY
              : singleWriterOnly && surface.length <= 2
                ? TASK_SHAPE_V16_15.SMALL
                : TASK_SHAPE_V16_15.NORMAL

  return {
    shape,
    baseShape,
    reason: shape === TASK_SHAPE_V16_15.DECOMPOSABLE
      ? `${independentWriters} provably independent write scopes among ${writerCount} declared writers`
      : shape === TASK_SHAPE_V16_15.TINY
        ? "one output, one writer; a single output cannot contain independent work, and a child would cost more than it saves"
        : shape === TASK_SHAPE_V16_15.SMALL
          ? `${surface.length} file(s) in one coherent edit`
          : shape === TASK_SHAPE_V16_15.COMPLEX
            ? "cross-module or high-risk surface"
            : shape === TASK_SHAPE_V16_15.NORMAL && writerCount >= 2
              ? `${writerCount} declared writer scopes that are not provably independent`
              : `${surface.length} file(s); read-only overlap may help, the write stays serial`,
    changedFileCount: changed.length,
    surfaceFileCount: surface.length,
    surface,
    declaredScopeCount: scopes.length,
    writerCount,
    independentWriters,
    conflictGraph: graph,
    deterministic: true,
  }
}

// ---------------------------------------------------------------------------
// economy gate
// ---------------------------------------------------------------------------

/**
 * Estimate the wall time a set of independent scopes could overlap away, and the
 * overhead of doing so. Both figures are ESTIMATES from declared inputs; the
 * comparison is what matters, and the comparison is deterministic.
 *
 * @param {object} input
 * @param {object[]} input.scopes
 * @param {number} [input.perChildWorkMs]   expected sequential work per child
 * @param {object} [input.history]          MEASURED history (optional)
 */
export function estimateParallelEconomy(input = {}) {
  const scopes = Array.isArray(input.scopes) ? input.scopes : []
  const perChildWorkMs = Math.max(0, Number(input.perChildWorkMs ?? MIN_MEANINGFUL_CHILD_WORK_MS))
  const childCount = scopes.length
  const overheadPerChildMs = childOverheadEstimateMs()

  // Sequential equivalent: every child runs one after another.
  const sequentialEquivalentMs = childCount * perChildWorkMs
  // Parallel equivalent: one overhead per child, plus the longest child.
  const parallelWallMs = childCount * overheadPerChildMs + perChildWorkMs
  const estimatedOverheadMs = childCount * overheadPerChildMs
  const estimatedOverlapSavingMs = Math.max(0, sequentialEquivalentMs - parallelWallMs)

  const history = input.history || null
  const measuredQueueMs = Number.isFinite(Number(history?.childQueueMs)) ? Number(history.childQueueMs) : null
  const measuredConflictRate = Number.isFinite(Number(history?.integrationConflictRate))
    ? Number(history.integrationConflictRate)
    : null

  return {
    schemaVersion: PARALLEL_EXECUTION_SCHEMA_VERSION,
    policy: PARALLEL_EXECUTION_POLICY_ID,
    childCount,
    perChildWorkMs: measured(perChildWorkMs),
    overheadPerChildMs: estimated(overheadPerChildMs),
    estimatedOverheadMs: estimated(estimatedOverheadMs),
    sequentialEquivalentMs: estimated(sequentialEquivalentMs),
    parallelWallMs: estimated(parallelWallMs),
    estimatedOverlapSavingMs: estimated(estimatedOverlapSavingMs),
    // History is only ever MEASURED or NOT_MEASURED. Never a guess.
    measuredQueueMs: measuredQueueMs == null ? NOT_MEASURED : measured(measuredQueueMs),
    measuredConflictRate: measuredConflictRate == null ? NOT_MEASURED : measured(measuredConflictRate),
    // A comparison of two estimates is DERIVED, not MEASURED.
    economical: derived(estimatedOverlapSavingMs > 0 && perChildWorkMs >= MIN_MEANINGFUL_CHILD_WORK_MS),
    provenance: {
      savings: "ESTIMATED",
      overhead: "ESTIMATED",
      history: measuredQueueMs == null && measuredConflictRate == null ? "NOT_MEASURED" : "MEASURED",
      tokens: "NOT_MEASURED",
    },
  }
}

/**
 * The single deterministic parallel-execution decision for a task.
 *
 * @param {object} input
 * @param {object[]} [input.scopes]              declared scopes
 * @param {string[]} [input.changedFiles]
 * @param {string}   [input.risk]
 * @param {boolean}  [input.finalRelease]
 * @param {boolean}  [input.readOnlyWorkUseful]  read-only discovery would help
 * @param {number}   [input.perChildWorkMs]
 * @param {number}   [input.requestedWriters]
 * @param {object}   [input.history]
 * @param {object}   [input.resourcePressure]    { childProcesses, subprocessLanes, ... }
 * @param {boolean}  [input.unresolvedResearch]  research result could change direction
 */
export function decideParallelExecution(input = {}) {
  const classification = classifyTaskShapeV16_15(input)
  const shape = classification.shape
  const scopes = Array.isArray(input.scopes) ? input.scopes : []
  const writerScopes = scopes.filter((scope) => isWriterScope(scope))
  const graph = classification.conflictGraph
    || (scopes.length >= 2 ? buildConflictGraph(scopes, graphOptionsFor(input, WRITER_CONCURRENCY.hardMax)) : null)
  const economy = estimateParallelEconomy({ ...input, scopes: writerScopes })
  const reasons = []
  const resourcePressure = input.resourcePressure || null
  const pressureLevel = String(resourcePressure?.level || "unknown")

  const writerBound = resolveWriterConcurrency(input.requestedWriters)
  const readOnlyBound = resolveReadOnlyConcurrency(input.requestedReadOnly)

  const decide = (posture, detail) => ({
    schemaVersion: PARALLEL_EXECUTION_SCHEMA_VERSION,
    policy: PARALLEL_EXECUTION_POLICY_ID,
    posture,
    shape,
    shapeReason: classification.reason,
    writerConcurrency: posture === EXECUTION_POSTURE.PARALLEL_WRITERS ? detail.writerConcurrency : 0,
    readOnlyConcurrency: posture === EXECUTION_POSTURE.PARALLEL_READ_ONLY
      || posture === EXECUTION_POSTURE.PARALLEL_WRITERS
      ? readOnlyBound
      : 0,
    spawnsChildren: posture === EXECUTION_POSTURE.PARALLEL_READ_ONLY
      || posture === EXECUTION_POSTURE.PARALLEL_WRITERS,
    spawnsWriters: posture === EXECUTION_POSTURE.PARALLEL_WRITERS,
    sandboxRequired: posture === EXECUTION_POSTURE.PARALLEL_WRITERS,
    reasons,
    economy,
    conflictGraph: graph,
    classification,
    limits: { ...WRITER_CONCURRENCY, resolvedWriterBound: writerBound, resolvedReadOnlyBound: readOnlyBound },
    // Parallel execution NEVER asserts a verdict. Only the local verifier can.
    canProduceVerdict: false,
    deterministic: true,
  })

  // LAW 1. TINY and SMALL never spawn a child. Checked BEFORE anything else, so
  // no later signal can promote a tiny task into a parallel one.
  if (PARENT_DIRECT_SHAPES.includes(shape)) {
    reasons.push({
      signal: "parent-direct-shape",
      detail: `${shape}: a child process + worktree + context rebuild costs more wall time than this task`,
    })
    return decide(EXECUTION_POSTURE.PARENT_DIRECT, {})
  }

  if (shape === TASK_SHAPE_V16_15.RELEASE) {
    reasons.push({
      signal: "release-shape",
      detail: "final release: unsafe release mutation is never parallelized",
    })
    return decide(EXECUTION_POSTURE.SERIAL_STRUCTURED, {})
  }

  // LAW 2. Unresolved research that could change the implementation direction
  // blocks source writers entirely (V16.13/V16.14 Decision Barrier preserved).
  if (input.unresolvedResearch === true && writerScopes.length > 0) {
    reasons.push({
      signal: "research-barrier-open",
      detail: "an external research result could still change the implementation direction",
    })
    return decide(EXECUTION_POSTURE.SERIAL_STRUCTURED, {})
  }

  // LAW 3. High resource pressure reduces concurrency instead of ignoring it.
  let effectiveWriterBound = writerBound
  if (pressureLevel === "high") {
    effectiveWriterBound = 1
    reasons.push({ signal: "resource-pressure-high", detail: "concurrency reduced to 1 under measured resource pressure" })
  } else if (pressureLevel === "elevated") {
    effectiveWriterBound = Math.max(1, Math.min(writerBound, 2))
    reasons.push({ signal: "resource-pressure-elevated", detail: `writer concurrency bounded to ${effectiveWriterBound}` })
  }

  // LAW 4. Writers require PROVEN independence. One UNKNOWN or CONFLICT edge
  // between writers means the parallel path is refused.
  if (writerScopes.length >= 2) {
    const conflictingWriters = graph
      ? graph.scopes.filter((row) => row.writer && row.certainty !== SCOPE_CERTAINTY.INDEPENDENT).map((row) => row.id)
      : writerScopes.map((scope) => String(scope.id || scope.taskId || ""))
    if (conflictingWriters.length > 0) {
      reasons.push({
        signal: "writer-conflict",
        detail: `not provably independent: ${conflictingWriters.slice(0, 6).join(", ")}`,
      })
      return decide(EXECUTION_POSTURE.SERIAL_STRUCTURED, {})
    }
    if (effectiveWriterBound < 2) {
      reasons.push({
        signal: "writer-bound-single",
        detail: `resolved writer concurrency is ${effectiveWriterBound}; parallel writers need at least 2 lanes`,
      })
      return decide(EXECUTION_POSTURE.SERIAL_STRUCTURED, {})
    }
    // LAW 5. Estimated benefit must exceed estimated overhead.
    if (economy.economical?.value !== true) {
      reasons.push({
        signal: "economy-gate-failed",
        detail: `estimated overlap saving ${economy.estimatedOverlapSavingMs?.value ?? 0}ms does not exceed estimated overhead for ${writerScopes.length} children`,
      })
      return decide(EXECUTION_POSTURE.SERIAL_STRUCTURED, {})
    }
    reasons.push({
      signal: "independent-writers",
      detail: `${writerScopes.length} writers are provably independent across exact-file, read/write, config-family, lockfile, generated-output and module-edge relations`,
    })
    return decide(EXECUTION_POSTURE.PARALLEL_WRITERS, {
      writerConcurrency: Math.min(effectiveWriterBound, writerScopes.length),
    })
  }

  // A single writer with useful read-only discovery: reads may overlap, the
  // write stays serial. This is the NORMAL shape's posture.
  if (input.readOnlyWorkUseful === true && scopes.length >= 2) {
    reasons.push({
      signal: "read-only-overlap",
      detail: "read-only discovery is provably independent; the single writer stays serial",
    })
    return decide(EXECUTION_POSTURE.PARALLEL_READ_ONLY, {})
  }

  reasons.push({
    signal: "single-writer-serial",
    detail: writerScopes.length === 1
      ? "one write scope; there is no independent writer to overlap with"
      : "no provably independent work to overlap",
  })
  return decide(EXECUTION_POSTURE.SERIAL_STRUCTURED, {})
}

/**
 * Adaptive writer concurrency from MEASURED history.
 *
 * It may only ever LOWER or RAISE the concurrency WITHIN the hard bound, and it
 * refuses to adapt at all when the history is not measured. The default stays
 * conservative: a caller with no history gets the platform default.
 */
export function adaptiveWriterConcurrency(history = null, options = {}) {
  const bound = resolveWriterConcurrency(options.requested, options)
  if (!history || typeof history !== "object") {
    return {
      concurrency: bound,
      adapted: false,
      reason: "no measured history; platform default retained",
      provenance: "NOT_MEASURED",
      deterministic: true,
    }
  }
  const queueMs = Number(history.childQueueMs)
  const conflicts = Number(history.integrationConflictRate)
  const samples = Number(history.samples)
  if (!Number.isFinite(samples) || samples < 5 || (!Number.isFinite(queueMs) && !Number.isFinite(conflicts))) {
    return {
      concurrency: bound,
      adapted: false,
      reason: "history is below the minimum sample size or not measured; default retained",
      provenance: "NOT_MEASURED",
      deterministic: true,
    }
  }

  const lowContention = Number.isFinite(queueMs) && queueMs < 250
  const lowConflicts = !Number.isFinite(conflicts) || conflicts <= 0.05
  if (lowContention && lowConflicts && bound < WRITER_CONCURRENCY.hardMax) {
    return {
      concurrency: Math.min(WRITER_CONCURRENCY.hardMax, bound + 1),
      adapted: true,
      reason: `measured low contention (${queueMs}ms queue) and low conflict rate (${conflicts}); raised by 1 within the hard bound`,
      provenance: "MEASURED",
      deterministic: true,
    }
  }
  if (Number.isFinite(queueMs) && queueMs > 2_000) {
    return {
      concurrency: 1,
      adapted: true,
      reason: `measured queue contention ${queueMs}ms exceeds the serial threshold; reduced to 1`,
      provenance: "MEASURED",
      deterministic: true,
    }
  }
  return {
    concurrency: bound,
    adapted: false,
    reason: "measured history does not justify a change",
    provenance: "MEASURED",
    deterministic: true,
  }
}

/**
 * Bounded resource-pressure signal from cheap, already-available numbers.
 *
 * It performs NO OS polling: the caller passes counters it already holds (active
 * child processes, active subprocess lanes, active tests). Absent input reads as
 * `unknown`, which does not change concurrency - only a real reading does.
 */
export function resourcePressure(input = {}) {
  const children = Number(input.activeChildren)
  const lanes = Number(input.activeSubprocessLanes)
  const tests = Number(input.activeTests)
  const memoryRatio = Number(input.memoryPressureRatio)
  const signals = []
  let score = 0

  if (Number.isFinite(children) && children >= WRITER_CONCURRENCY.hardMax) {
    score += 2
    signals.push(`active children ${children}`)
  } else if (Number.isFinite(children) && children > 0) {
    score += 1
    signals.push(`active children ${children}`)
  }
  if (Number.isFinite(lanes) && lanes >= 2) {
    score += 2
    signals.push(`active subprocess lanes ${lanes}`)
  } else if (Number.isFinite(lanes) && lanes > 0) {
    score += 1
    signals.push(`active subprocess lanes ${lanes}`)
  }
  if (Number.isFinite(tests) && tests > 0) {
    score += 1
    signals.push(`active tests ${tests}`)
  }
  if (Number.isFinite(memoryRatio) && memoryRatio >= 0.85) {
    score += 2
    signals.push(`memory pressure ratio ${memoryRatio}`)
  }

  const level = score >= 4 ? "high" : score >= 2 ? "elevated" : score === 0 ? "unknown" : "low"
  return {
    level,
    score,
    signals,
    // A pressure level derived from caller-supplied counters is DERIVED.
    provenance: signals.length ? "DERIVED" : "NOT_MEASURED",
    deterministic: true,
  }
}

/**
 * Compact token/context economy accounting for one parallel run.
 *
 * Every field is either a MEASURED char/byte count or explicitly NOT_MEASURED.
 * Provider tokens are NOT_MEASURED unless the caller passes real numbers; this
 * function never invents them and never claims a token saving.
 */
export function parallelTokenEconomy(input = {}) {
  const chars = (value) => {
    if (value == null) return NOT_MEASURED
    const n = Number(value)
    return Number.isFinite(n) && n >= 0 ? measured(Math.trunc(n)) : NOT_MEASURED
  }
  const sharedWaveContextChars = chars(input.sharedWaveContextChars)
  const childSpecificChars = chars(input.childSpecificChars)
  const duplicateContextCharsAvoided = chars(input.duplicateContextCharsAvoided)
  const parentInputChars = chars(input.parentInputChars)
  const parentOutputChars = chars(input.parentOutputChars)
  const sumChildInputChars = chars(input.sumChildInputChars)
  const sumChildOutputChars = chars(input.sumChildOutputChars)

  const providerInputTokens = Number.isFinite(Number(input.providerInputTokens))
    ? measured(Number(input.providerInputTokens))
    : NOT_MEASURED
  const providerOutputTokens = Number.isFinite(Number(input.providerOutputTokens))
    ? measured(Number(input.providerOutputTokens))
    : NOT_MEASURED
  const deepseekTokens = Number.isFinite(Number(input.deepseekTokens))
    ? measured(Number(input.deepseekTokens))
    : NOT_MEASURED

  return {
    schemaVersion: PARALLEL_EXECUTION_SCHEMA_VERSION,
    policy: PARALLEL_EXECUTION_POLICY_ID,
    parentInputChars,
    parentOutputChars,
    sharedWaveContextChars,
    childSpecificChars,
    duplicateContextCharsAvoided,
    sumChildInputChars,
    sumChildOutputChars,
    providerInputTokens,
    providerOutputTokens,
    deepseekTokens,
    // Honest provenance summary. A field is MEASURED only when a real number was
    // supplied; there is no silent zero anywhere in this object.
    provenance: {
      chars: [parentInputChars, parentOutputChars, sharedWaveContextChars, childSpecificChars,
        duplicateContextCharsAvoided, sumChildInputChars, sumChildOutputChars]
        .every((row) => row.provenance === "MEASURED") ? "MEASURED" : "PARTIAL",
      providerTokens: providerInputTokens.provenance === "MEASURED" || providerOutputTokens.provenance === "MEASURED"
        ? "MEASURED"
        : "NOT_MEASURED",
      deepseekTokens: deepseekTokens.provenance,
    },
    tokenSavingClaim: null,
    note:
      "Parallelism is justified by measured wall-clock overlap and measured char counts. "
      + "No provider-token saving is claimed unless the provider reported tokens.",
    deterministic: true,
  }
}

export const parallelExecutionPolicyExports = Object.freeze({
  decideParallelExecution,
  classifyTaskShapeV16_15,
  estimateParallelEconomy,
  adaptiveWriterConcurrency,
  resolveWriterConcurrency,
  resolveReadOnlyConcurrency,
  resourcePressure,
  parallelTokenEconomy,
  childOverheadEstimateMs,
  TASK_SHAPE_V16_15,
  EXECUTION_POSTURE,
  PARENT_DIRECT_SHAPES,
  WRITER_CONCURRENCY,
  CHILD_OVERHEAD_ESTIMATE_MS,
  MIN_MEANINGFUL_CHILD_WORK_MS,
})
