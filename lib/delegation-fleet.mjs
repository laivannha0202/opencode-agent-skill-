// V16.5 bounded parallel delegation FLEET executor.
//
// WHAT THIS IS NOT
//   - It is NOT a swarm framework. It never spawns a process.
//   - It is NOT a scheduler. Wave planning is owned by lib/delegation-safety.mjs
//     (buildDelegationWaves) and dependency/wave ordering is owned by the
//     existing task graph (lib/task-graph.mjs computeSafeWaves).
//   - It is NOT a second process supervisor. The Pi child spawn + execution
//     ownership + lib/process-supervisor.mjs path stays the only process
//     framework. The caller supplies `execute`, which is that existing runtime.
//
// WHAT IT IS
//   The executor for an already-proven-safe delegation request: a bounded worker
//   pool that runs at most maxParallel children at a time, registers every child
//   in the existing V16.5 delegation session (lib/subagent-fabric.mjs), keeps the
//   per-child timeout + inactivity watchdog + cancellation + no-orphan teardown,
//   returns results in DETERMINISTIC key order regardless of completion order,
//   and aggregates failures without ever fabricating a verdict.
//
// PARALLELISM IS PERMITTED ONLY WHEN ALL HOLD
//   children are independent | scopes do not conflict | side-effect classes are
//   compatible | no overlapping writer scope | no shared mutable service | no
//   duplicate external side effect | a concurrency budget is available.
// Everything else stays serial. Fail-closed, never best-effort.

import {
  CHILD_STATUS,
  DELEGATION_STOP_REASONS,
  FABRIC_LIMITS,
  cancelAllChildren,
  cancelChild,
  finalizeChild,
  registerChild,
  sweepChildren,
} from "./subagent-fabric.mjs"
import { PARALLEL_BLOCK_REASON, buildDelegationWaves, classifyScope } from "./delegation-safety.mjs"

export const DELEGATION_FLEET_SCHEMA_VERSION = 1

// Defaults are the V16.5 fabric budgets, not a new set of numbers.
export const FLEET_LIMITS = Object.freeze({
  defaultConcurrency: FABRIC_LIMITS.defaultActiveChildren, // 2
  hardMaxConcurrency: FABRIC_LIMITS.maxActiveChildren, // 3
  defaultDepth: FABRIC_LIMITS.defaultDepth, // 1
  hardMaxDepth: FABRIC_LIMITS.hardMaxDepth, // 2
  defaultWatchdogIntervalMs: 250,
})

// Block reasons that force serialization instead of concurrent execution.
export const UNSAFE_BLOCK_REASONS = new Set([
  PARALLEL_BLOCK_REASON.OVERLAPPING_FILES,
  PARALLEL_BLOCK_REASON.WRITER_OVERLAP,
  PARALLEL_BLOCK_REASON.MUTABLE_SERVICE,
  PARALLEL_BLOCK_REASON.EXTERNAL_SIDE_EFFECT,
  PARALLEL_BLOCK_REASON.DESTRUCTIVE_SHELL,
].map((reason) => String(reason)))

export const FLEET_OUTCOME = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  TIMED_OUT: "timed-out",
  REJECTED: "rejected",
})

// Keeps a timer from holding the process open. Typed loosely on purpose: under
// a DOM lib `setInterval` returns a number, under @types/node a Timeout.
function unrefTimer(timer) {
  if (timer && typeof timer.unref === "function") timer.unref()
}

function positiveInt(value, fallback, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.max(1, Math.min(max, Math.trunc(parsed)))
}

/** Resolve a requested concurrency into the configured bound, hard-capped. */
export function resolveFleetConcurrency(requested) {
  return positiveInt(
    requested,
    FLEET_LIMITS.defaultConcurrency,
    FLEET_LIMITS.hardMaxConcurrency,
  )
}

function normalizeScope(scope, index) {
  const classified = scope && scope.parallelClass ? scope : classifyScope(scope || {})
  const id = String(scope?.id || scope?.childId || classified.childId || classified.role || `scope-${index}`)
  return {
    ...classified,
    id,
    key: String(scope?.key || id),
    agent: scope?.agent,
    task: scope?.task,
    timeoutMs: scope?.timeoutMs,
    orderIndex: index,
    slot: index,
    original: scope,
  }
}

// Deterministic ordering: key ascending, original order as the tie-break. The
// caller never has to pre-sort, and completion order can never leak into output.
function compareScopes(a, b) {
  if (a.key === b.key) return a.orderIndex - b.orderIndex
  return a.key < b.key ? -1 : 1
}

// ---------------------------------------------------------------------------
// telemetry
// ---------------------------------------------------------------------------

/** Fresh telemetry accumulator. All counters are MEASURED wall-clock facts. */
export function createDelegationFleetTelemetry() {
  return {
    waveCount: 0,
    safeWaveCount: 0,
    childCount: 0,
    parallelDelegations: 0,
    serializedDelegations: 0,
    rejectedDelegations: 0,
    maxObservedChildConcurrency: 0,
    childQueueMs: 0,
    childExecutionMs: 0,
    parallelWallMs: 0,
    sequentialEquivalentMs: 0,
    overlapSavingsMs: 0,
    cancelledChildren: 0,
  }
}

/** Record one completed wave into the accumulator (mutates and returns it). */
export function recordDelegationWaveTelemetry(telemetry, wave) {
  const target = telemetry || createDelegationFleetTelemetry()
  const row = wave || {}
  target.waveCount += 1
  target.childCount += row.childCount || 0
  target.parallelDelegations += row.parallelDelegations || 0
  target.serializedDelegations += row.serializedDelegations || 0
  target.rejectedDelegations += row.rejectedDelegations || 0
  target.maxObservedChildConcurrency = Math.max(
    target.maxObservedChildConcurrency,
    row.maxObservedChildConcurrency || 0,
  )
  target.childQueueMs += row.childQueueMs || 0
  target.childExecutionMs += row.childExecutionMs || 0
  target.parallelWallMs += row.parallelWallMs || 0
  target.sequentialEquivalentMs += row.sequentialEquivalentMs || 0
  target.overlapSavingsMs = target.sequentialEquivalentMs - target.parallelWallMs
  target.cancelledChildren += row.cancelledChildren || 0
  return target
}

/**
 * Immutable telemetry snapshot.
 *
 * `overlapSavingsMs` is a MEASURED wall-clock overlap of child execution windows
 * inside this process. It is deliberately NOT named "speedup" and carries no
 * provider-token, model-quality, or end-to-end task-duration claim.
 */
export function delegationFleetTelemetry(telemetry) {
  const row = telemetry || createDelegationFleetTelemetry()
  const sequentialEquivalentMs = row.sequentialEquivalentMs
  const parallelWallMs = row.parallelWallMs
  return {
    schemaVersion: DELEGATION_FLEET_SCHEMA_VERSION,
    waveCount: row.waveCount,
    safeWaveCount: row.safeWaveCount,
    childCount: row.childCount,
    parallelDelegations: row.parallelDelegations,
    serializedDelegations: row.serializedDelegations,
    rejectedDelegations: row.rejectedDelegations,
    maxObservedChildConcurrency: row.maxObservedChildConcurrency,
    childQueueMs: row.childQueueMs,
    childExecutionMs: row.childExecutionMs,
    parallelWallMs,
    sequentialEquivalentMs,
    overlapSavingsMs: Math.max(0, sequentialEquivalentMs - parallelWallMs),
    overlapRatio: parallelWallMs > 0 ? Number((sequentialEquivalentMs / parallelWallMs).toFixed(4)) : null,
    cancelledChildren: row.cancelledChildren,
    limits: {
      defaultConcurrency: FLEET_LIMITS.defaultConcurrency,
      hardMaxConcurrency: FLEET_LIMITS.hardMaxConcurrency,
    },
    provenance: "MEASURED",
    measurementScope: "child execution windows inside this process only",
    speedupClaim: null,
    note:
      "overlapSavingsMs is measured wall-clock overlap only. It is not a speedup claim, not a provider-token claim, and not a model-quality claim.",
  }
}

// ---------------------------------------------------------------------------
// wave executor
// ---------------------------------------------------------------------------

function childSignalContext(parentSignal) {
  const controller = new AbortController()
  const abort = (reason) => {
    try {
      controller.abort(reason)
    } catch {
      /* already aborted */
    }
  }
  const onParentAbort = () => abort(DELEGATION_STOP_REASONS.CANCELLED)
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort()
    else parentSignal.addEventListener("abort", onParentAbort, { once: true })
  }
  return {
    signal: controller.signal,
    abort,
    dispose() {
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort)
    },
  }
}

function receiptInput(value, error, stopReason) {
  if (value && typeof value === "object" && !Array.isArray(value) && "exitCode" in value) {
    return {
      exitCode: value.exitCode,
      error: value.error === undefined ? error : value.error,
      outputRef: value.outputRef,
      handoffRef: value.handoffRef,
      stopReason: value.stopReason || stopReason,
    }
  }
  return { exitCode: error ? 1 : 0, error, stopReason }
}

function outcomeForRejection(scope, registration) {
  return {
    index: scope.orderIndex,
    id: scope.id,
    key: scope.key,
    childId: null,
    role: scope.role || null,
    agent: null,
    depth: null,
    parallelClass: scope.parallelClass,
    ok: false,
    status: FLEET_OUTCOME.REJECTED,
    stopReason: registration.reason,
    durationMs: 0,
    queueMs: 0,
    executionMs: 0,
    result: null,
    error: null,
    receipt: null,
    // A refused registration is a safety decision, never a pass.
    canProduceVerdict: false,
  }
}

/**
 * Execute one delegation request as bounded, proven-safe waves.
 *
 * input.scopes  : Array of { id, key, role, agent, readOnly, files, task, timeoutMs }
 * input.execute : async (scope, ctx) => any  -- the EXISTING child runtime
 * input.session : lib/subagent-fabric delegation session (required in production)
 * input.signal  : parent AbortSignal; aborting it terminates every active child
 */
export async function runDelegationWave(input) {
  const options = input || {}
  const execute = options.execute
  if (typeof execute !== "function") {
    throw new TypeError("runDelegationWave requires an execute(scope, ctx) function")
  }

  const session = options.session || null
  const telemetry = options.telemetry || createDelegationFleetTelemetry()
  const maxParallel = resolveFleetConcurrency(options.maxParallel)
  const parentSignal = options.signal
  const watchdogIntervalMs = positiveInt(
    options.watchdogIntervalMs,
    FLEET_LIMITS.defaultWatchdogIntervalMs,
    60_000,
  )

  const normalized = (options.scopes || [])
    .map((scope, index) => normalizeScope(scope, index))
    .sort(options.orderByKey === false ? (a, b) => a.orderIndex - b.orderIndex : compareScopes)
  normalized.forEach((scope, slot) => {
    scope.slot = slot
  })

  // Queue time is measured from the moment the delegation request was admitted,
  // so a child that waited for a concurrency slot is honestly reported as waiting.
  const requestStartedAt = Date.now()

  const plan = buildDelegationWaves(normalized, { maxParallel })
  const outcomes = new Array(normalized.length).fill(null)
  const controllers = new Map()
  const reaped = new Set()
  let activeChildren = 0
  let observedConcurrency = 0
  let cancelledChildren = 0

  // Inactivity/timeout watchdog. It reaps children exactly like the single-child
  // path and then ABORTS that child's own signal, so the real process supervisor
  // terminates the process tree instead of leaking an orphan.
  const sweep = () => {
    if (!session) return
    const swept = sweepChildren(session, Date.now())
    for (const childId of swept.reaped || []) {
      if (reaped.has(childId)) continue
      reaped.add(childId)
      cancelledChildren += 1
      const controller = controllers.get(childId)
      if (controller) controller.abort(DELEGATION_STOP_REASONS.TIMEOUT)
    }
  }
  let sweepTimer = null
  if (session && watchdogIntervalMs > 0) {
    sweepTimer = setInterval(sweep, watchdogIntervalMs)
    unrefTimer(sweepTimer)
  }

  const runChild = async (scope, waveIndex, waveSize) => {
    const registration = session
      ? registerChild(session, {
        role: scope.role || "explore",
        agent: scope.agent,
        readOnly: scope.readOnly !== false,
        task: scope.task || scope.id,
        timeoutMs: scope.timeoutMs || options.childTimeoutMs,
      })
      : { ok: true, child: { childId: scope.id, agent: scope.agent, depth: null } }

    if (!registration.ok) {
      outcomes[scope.slot] = outcomeForRejection(scope, registration)
      return
    }

    const childId = registration.child.childId
    const childContext = childSignalContext(parentSignal)
    controllers.set(childId, childContext)
    activeChildren += 1
    observedConcurrency = Math.max(observedConcurrency, activeChildren)

    const startedAt = Date.now()
    const queueMs = Math.max(0, startedAt - requestStartedAt)
    try {
      options.onChildStart?.({ scope, childId, waveIndex, waveSize, startedAt })
    } catch {
      /* observer only */
    }

    let value
    let error = null
    try {
      value = await execute(scope, {
        childId,
        waveIndex,
        waveSize,
        session,
        signal: childContext.signal,
        maxParallel,
      })
    } catch (thrown) {
      error = thrown
    }

    // A child that ran to completion while an unrelated sibling failed is never
    // cancelled by the fleet. Only the watchdog or the parent can abort a child.
    const abortReason = childContext.signal.aborted ? String(childContext.signal.reason || DELEGATION_STOP_REASONS.CANCELLED) : null
    // A runner that reports a non-zero exit code (or an explicit ok:false) is a
    // FAILURE. It must never be counted as a completed delegation.
    const returnedExitCode =
      value && typeof value === "object" && !Array.isArray(value) && typeof value.exitCode === "number"
        ? value.exitCode
        : null;
    const returnedOk =
      value && typeof value === "object" && !Array.isArray(value) && typeof value.ok === "boolean" ? value.ok : null;
    const runnerFailed = (returnedExitCode !== null && returnedExitCode !== 0) || returnedOk === false;
    const failed = Boolean(error) || abortReason !== null || runnerFailed
    const status = failed
      ? reaped.has(childId) || abortReason === DELEGATION_STOP_REASONS.TIMEOUT
        ? FLEET_OUTCOME.TIMED_OUT
        : abortReason
          ? FLEET_OUTCOME.CANCELLED
          : FLEET_OUTCOME.FAILED
      : FLEET_OUTCOME.COMPLETED

    const finishedAt = Date.now()
    const durationMs = finishedAt - startedAt
    activeChildren -= 1
    controllers.delete(childId)
    childContext.dispose()

    let receipt = null
    if (session && registration.child && registration.child.childId) {
      try {
        if (reaped.has(childId) || abortReason !== null) {
          // A watchdog-reaped or cancelled child keeps its real stop reason.
          // finalizeChild() would overwrite it with a plain failure.
          cancelChild(session, childId, abortReason || DELEGATION_STOP_REASONS.TIMEOUT)
          const stored = (session.children || []).find((row) => row.childId === childId)
          receipt = stored?.receipt || null
        } else {
          receipt = finalizeChild(session, childId, receiptInput(value, error, null)).receipt || null
        }
      } catch {
        receipt = null
      }
    }

    outcomes[scope.slot] = {
      index: scope.orderIndex,
      id: scope.id,
      key: scope.key,
      childId,
      role: scope.role || null,
      agent: registration.child.agent || scope.agent || null,
      depth: registration.child.depth ?? null,
      parallelClass: scope.parallelClass,
      ok: !failed,
      status,
      stopReason:
        abortReason ||
        receipt?.stopReason ||
        (failed ? DELEGATION_STOP_REASONS.CHILD_FAILED : DELEGATION_STOP_REASONS.CHILD_COMPLETED),
      durationMs,
      queueMs,
      executionMs: durationMs,
      result: failed ? null : value,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
      receipt,
      // Aggregation only. A child never produces PASS/FAIL for the parent.
      canProduceVerdict: false,
    }

    try {
      options.onChildEnd?.({ scope, childId, waveIndex, status, durationMs, result: value, error })
    } catch {
      /* observer only */
    }
  }

  const waveRecords = []

  for (const wave of plan.waves) {
    const waveScopes = (wave.indexes || []).map((index) => normalized[index]).filter(Boolean)
    if (!waveScopes.length) continue
    const waveStartedAt = Date.now()
    const waveSize = waveScopes.length
    const workerCount = Math.max(1, Math.min(maxParallel, waveSize))

    let next = 0
    const worker = async () => {
      while (true) {
        const position = next++
        if (position >= waveSize) return
        await runChild(waveScopes[position], wave.wave, waveSize)
      }
    }
    const workers = Array.from({ length: workerCount }, worker)
    // allSettled: one child throwing (or being reaped) must never cancel an
    // unrelated read-only sibling. The parent decides recovery from the aggregate.
    const settled = await Promise.allSettled(workers)
    let internalFailure = 0
    for (const entry of settled) {
      if (entry.status === "rejected") internalFailure += 1
    }

    const waveOutcomes = waveScopes.map((scope) => outcomes[scope.slot]).filter(Boolean)
    const waveExecutionMs = waveOutcomes.reduce((sum, row) => sum + (row.executionMs || 0), 0)
    const waveQueueMs = waveOutcomes.reduce((sum, row) => sum + (row.queueMs || 0), 0)
    const wallMs = Date.now() - waveStartedAt
    const parallel = waveSize > 1 && wave.safe === true
    const rejected = waveOutcomes.filter((row) => row.status === FLEET_OUTCOME.REJECTED).length

    recordDelegationWaveTelemetry(telemetry, {
      childCount: waveOutcomes.length,
      parallelDelegations: parallel ? waveSize - rejected : 0,
      serializedDelegations: (parallel ? 0 : waveSize) + rejected,
      rejectedDelegations: rejected,
      maxObservedChildConcurrency: observedConcurrency,
      childQueueMs: waveQueueMs,
      childExecutionMs: waveExecutionMs,
      parallelWallMs: wallMs,
      sequentialEquivalentMs: waveExecutionMs,
      cancelledChildren: 0,
    })
    if (parallel) telemetry.safeWaveCount += 1

    waveRecords.push({
      wave: wave.wave,
      safe: wave.safe,
      parallel,
      scopes: wave.scopes,
      parallelClasses: wave.parallelClasses,
      concurrency: workerCount,
      childIds: waveOutcomes.map((row) => row.childId),
      statuses: waveOutcomes.map((row) => row.status),
      wallMs,
      executionMs: waveExecutionMs,
      queueMs: waveQueueMs,
      sequentialEquivalentMs: waveExecutionMs,
      overlapSavingsMs: Math.max(0, waveExecutionMs - wallMs),
      failed: waveOutcomes.some((row) => row.ok === false) || internalFailure > 0,
    })
  }

  if (sweepTimer) clearInterval(sweepTimer)

  const parentAborted = parentSignal?.aborted === true
  if (parentAborted) {
    for (const controller of controllers.values()) controller.abort(DELEGATION_STOP_REASONS.CANCELLED)
  }
  // No-orphan teardown. A clean wave leaves every child terminal, so the shared
  // controller session stays usable for the next wave. An aborted or reaped wave
  // closes the session so nothing can be appended after cancellation.
  const nonTerminal = (session?.children || []).filter(
    (child) => !CHILD_STATUS.TERMINAL.includes(child.status),
  )
  const teardown = session && (nonTerminal.length > 0 || parentAborted)
    ? cancelAllChildren(session, DELEGATION_STOP_REASONS.CANCELLED)
    : { cancelled: 0, childIds: [], noOrphans: nonTerminal.length === 0 }
  cancelledChildren += teardown.cancelled || 0

  const ordered = normalized.map((scope) => outcomes[scope.slot]).filter(Boolean)
  const failedCount = ordered.filter((row) => row.ok === false).length

  return {
    ordered,
    outcomes: ordered,
    waves: waveRecords,
    plan: {
      decision: plan.decision,
      waveCount: plan.waveCount,
      parallelWaves: plan.parallelWaves,
      maxParallel: plan.maxParallel,
      blocks: plan.blocks,
      overlappingScopeBlocks: plan.overlappingScopeBlocks,
      duplicateWork: plan.duplicateWork,
    },
    safeWaveCount: telemetry.safeWaveCount,
    cancelled: parentAborted || cancelledChildren > 0,
    cancelledChildren,
    noOrphans: teardown.noOrphans !== false,
    // A fleet NEVER asserts PASS. Only the local verifier can produce a verdict.
    passed: false,
    canProduceVerdict: false,
    failed: failedCount,
    completed: ordered.filter((row) => row.ok === true).length,
    wallMs: Date.now() - requestStartedAt,
    telemetry: delegationFleetTelemetry(telemetry),
    blockReasons: [...new Set((plan.blocks || []).map((block) => block.reason))].sort(),
    hasUnsafeBlock: (plan.blocks || []).some((block) => UNSAFE_BLOCK_REASONS.has(String(block.reason))),
  }
}
