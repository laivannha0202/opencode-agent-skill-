// V16.15 Single-Shot Parallel Coding Runtime: the ONE production entry point.
//
// WHY THIS COMPOSITION EXISTS
//
// V16.15 ships four new owners. A caller (the Pi controller) must not import
// four modules, remember four argument shapes and re-derive the same decisions
// at every call site: that is how two owners drift into three implementations of
// one rule. This module is the single, small composition surface:
//
//   lib/parallel-execution-policy-v16-15.mjs   WHAT kind of parallelism, if any
//   lib/execution-conflict-graph-v16-15.mjs    WHICH scopes are provably independent
//   lib/wave-shared-context-v16-15.mjs         WHAT the wave shares, and what a
//                                              child may send back
//   lib/integration-transaction-v16-15.mjs     HOW a proven-safe wave lands in the
//                                              root, transactionally
//
// WHAT IT IS NOT
//
//   - It is NOT a fifth authority. It owns no policy, no conflict rule, no
//     context budget and no transaction. Every function below delegates.
//   - It is NOT a scheduler. `lib/task-dag-scheduler-v16-12.mjs` owns overlap,
//     `lib/delegation-fleet.mjs` owns bounded child execution, `lib/task-graph.mjs`
//     owns wave order, `lib/worktree-sandbox.mjs` owns isolation.
//   - It NEVER produces a PASS. Only the local verifier can. `planWave()` returns
//     a plan, and every plan carries `canProduceVerdict: false`.
//   - It never spawns a process and never writes to the root. `runIntegration()`
//     delegates to the integration transaction, which owns apply/rollback.
//
// LAWS
//
//   1. ONE DECISION PER WAVE. `planWave()` is the single place that answers
//      "parent-direct, parallel read-only, parallel writers, or serial?".
//   2. THE ECONOMY GATE IS NOT OPTIONAL. A plan that the economy gate refuses
//      comes back SERIAL_STRUCTURED even when the scopes are provably
//      independent. Independence is necessary, never sufficient.
//   3. NO MEASUREMENT IS INVENTED. Every number this module returns is either
//      measured by an owner or explicitly NOT_MEASURED.

import {
  EXECUTION_POSTURE,
  PARALLEL_EXECUTION_POLICY_ID,
  TASK_SHAPE_V16_15,
  decideParallelExecution,
  resolveWriterConcurrency,
} from "./parallel-execution-policy-v16-15.mjs"
import {
  CONFLICT_GRAPH_POLICY,
  SCOPE_CERTAINTY,
  buildConflictGraph,
  scopesAreIndependent,
} from "./execution-conflict-graph-v16-15.mjs"
import {
  WAVE_SHARED_CONTEXT_POLICY,
  createChildDelta,
  createCompactHandoff,
  createWaveSharedSnapshot,
  waveContextAccounting,
} from "./wave-shared-context-v16-15.mjs"
import {
  INTEGRATION_OUTCOME,
  INTEGRATION_TRANSACTION_POLICY,
  createProgressWatchdog,
  decideRetry,
  deterministicIntegrationOrder,
  evaluateCompletion,
  planFailureCancellation,
  runIntegrationTransaction,
} from "./integration-transaction-v16-15.mjs"
import { NOT_MEASURED, measured } from "./measurement-provenance.mjs"

export const PARALLEL_CODING_RUNTIME_POLICY = "parallel-coding-runtime-v16-15"
export const PARALLEL_CODING_RUNTIME_SCHEMA_VERSION = 1

export { EXECUTION_POSTURE, SCOPE_CERTAINTY, TASK_SHAPE_V16_15 }
// The integration outcome vocabulary is re-exported so a caller never compares a
// transaction result against a string literal it typed itself.
export { INTEGRATION_OUTCOME }

/** The owner ids this composition delegates to. Reported, never re-implemented. */
export const PARALLEL_CODING_OWNERS = Object.freeze({
  policy: PARALLEL_EXECUTION_POLICY_ID,
  conflictGraph: CONFLICT_GRAPH_POLICY,
  waveContext: WAVE_SHARED_CONTEXT_POLICY,
  integration: INTEGRATION_TRANSACTION_POLICY,
})

/**
 * Plan ONE wave.
 *
 * This is the decision the controller calls before it spawns anything. It owns
 * NO decision of its own: the shape, the independence graph, the economy gate,
 * the resource-pressure clamp and the research barrier are ALL computed by
 * `lib/parallel-execution-policy-v16-15.mjs` in `decideParallelExecution()`,
 * which is the single deterministic parallel-execution authority. This function
 * exists so the controller has ONE call, not so there can be two answers.
 *
 * It is pure: it declares nothing, spawns nothing and writes nothing.
 *
 * @param {object} input
 * @param {object[]} [input.scopes]      declared scopes (id/readOnly/writeFiles/files/task)
 * @param {string[]} [input.changedFiles]
 * @param {string}  [input.risk]
 * @param {boolean} [input.docsOnly]
 * @param {boolean} [input.crossModule]
 * @param {boolean} [input.finalRelease]
 * @param {boolean} [input.verifierFailed]
 * @param {boolean} [input.readOnlyWorkUseful]
 * @param {number}  [input.perChildWorkMs]
 * @param {object}  [input.history]
 * @param {object}  [input.resourcePressure]
 * @param {boolean} [input.unresolvedResearch]
 * @param {object}  [input.options]      { requestedWriters, requestedReadOnly,
 *                                         moduleEdges, generatedEdges, maxParallel }
 */
export function planWave(input = {}) {
  const options = input.options || {}
  const scopes = Array.isArray(input.scopes) ? input.scopes : []
  const maxParallel = resolveWriterConcurrency(options.requestedWriters ?? options.maxWriters)

  // `decideParallelExecution` builds its conflict graph from the caller's OWN
  // edge declarations (moduleEdges / generatedEdges), so the verdict and the
  // reported graph come from the same declarations. This function does not
  // re-derive the graph: a second derivation is a second answer.
  const decision = decideParallelExecution({
    ...input,
    scopes,
    requestedWriters: maxParallel,
    requestedReadOnly: options.requestedReadOnly ?? options.maxReaders,
  })

  return {
    ...decision,
    schemaVersion: PARALLEL_CODING_RUNTIME_SCHEMA_VERSION,
    policy: PARALLEL_CODING_RUNTIME_POLICY,
    // The policy module's own id is preserved so a receipt can prove which
    // authority produced the verdict.
    decisionPolicy: decision.policy,
    owners: PARALLEL_CODING_OWNERS,
    shape: decision.shape,
    posture: decision.posture,
    parentDirect: decision.posture === EXECUTION_POSTURE.PARENT_DIRECT,
    concurrency: decision.spawnsWriters
      ? decision.writerConcurrency
      : decision.spawnsChildren
        ? decision.readOnlyConcurrency
        : 1,
    maxWriters: maxParallel,
    graph: decision.conflictGraph || null,
    // A wave plan is a decision, not a verdict. This field is always false.
    canProduceVerdict: false,
    deterministic: true,
  }
}

/**
 * Assemble the immutable shared snapshot for one wave, plus the accounting that
 * proves what it saved. Delegates entirely to the wave-shared-context owner.
 */
export function buildWaveSnapshot(input = {}) {
  const snapshot = createWaveSharedSnapshot(input)
  return {
    schemaVersion: PARALLEL_CODING_RUNTIME_SCHEMA_VERSION,
    policy: PARALLEL_CODING_RUNTIME_POLICY,
    snapshot,
    canProduceVerdict: false,
  }
}

/** What this ONE child must be told, given the wave snapshot. */
export function buildChildDelta(input = {}) {
  return createChildDelta(input)
}

/** What a sibling receives back from a finished child. Bounded, never a log. */
export function buildSiblingHandoff(input = {}) {
  return createCompactHandoff(input)
}

/**
 * Measured accounting for a wave: how many snapshot characters each child did
 * NOT have to rediscover. Returns NOT_MEASURED when there is nothing to measure,
 * never a fabricated zero.
 */
export function waveAccounting(input = {}) {
  const accounting = waveContextAccounting(input)
  const shared = accounting?.sharedContextChars?.value
  return {
    ...accounting,
    // Provider tokens are NOT_MEASURED here: no provider reports a token count
    // for a snapshot that never reached a provider. Never a fabricated zero.
    providerTokens: NOT_MEASURED,
    provenance: typeof shared === "number" && shared > 0 ? measured(shared) : NOT_MEASURED,
    note: "Character accounting of the shared snapshot. This is not a provider-token claim and not a speedup claim.",
  }
}

/**
 * Land a proven-safe wave in the root, transactionally. Delegates to the
 * integration transaction, which owns preflight-all / deterministic apply /
 * rollback. This function adds no policy of its own.
 */
export async function runIntegration(input = {}) {
  return runIntegrationTransaction(input)
}

/** The deterministic apply order for a set of verified patches. */
export function integrationOrder(patches = [], options = {}) {
  return deterministicIntegrationOrder(patches, options)
}

/**
 * One-shot completion decision for the whole run. Delegates to the integration
 * transaction's completion owner, so there is exactly ONE definition of DONE /
 * BLOCKED / NEEDS_USER_DECISION / CANCELLED / CONTINUE in the system.
 */
export function completionDecision(input = {}) {
  return evaluateCompletion(input)
}

/** Bounded retry decision for a failed child or wave. */
export function retryDecision(input = {}) {
  return decideRetry(input)
}

/** Cancel only what depends on a failure. Never the whole fleet. */
export function failureCancellation(input = {}) {
  return planFailureCancellation(input)
}

/** Progress watchdog for a long wave: no silent stall, no invented timeout. */
export function progressWatchdog(input = {}) {
  return createProgressWatchdog(input)
}

/** Is this exact pair provably independent? A pure question, no side effects. */
export function pairIndependent(left, right, options = {}) {
  return scopesAreIndependent(left, right, options)
}

/**
 * Turn a run's wave telemetry into `efficiency.observation` rows.
 *
 * This module PRODUCES observations; Metrics V2 remains the single aggregator.
 * Every emitted figure is a COUNT of a real event (MEASURED). There is
 * deliberately NO speedup or overlap-saving field: a wave count is activity, not
 * a measurement of wall time saved, and a fabricated zero would be a lie about
 * a quantity nobody measured.
 *
 * @param {object} telemetry  the controller's `parallelCoding` telemetry block
 */
export function waveTelemetryToEfficiencyEvents(telemetry = {}) {
  const waves = Array.isArray(telemetry.waves) ? telemetry.waves : []
  const shared = Array.isArray(telemetry.sharedContext) ? telemetry.sharedContext : []
  const transactions = Array.isArray(telemetry.integrationTransactions) ? telemetry.integrationTransactions : []
  const events = []
  const countEvent = (operation, count) => {
    const value = Number(count)
    if (!Number.isFinite(value)) return
    events.push({
      kind: PARALLEL_CODING_EFFICIENCY_KIND,
      operation,
      metrics: { count: Math.max(0, value) },
      provenance: { count: "MEASURED" },
    })
  }
  // A BREAKDOWN event is only emitted when that breakdown actually occurred.
  // Emitting a zero for every category a wave did not take would inflate the
  // observation count with events that measured nothing.
  const countEventIfAny = (operation, count) => {
    const value = Number(count)
    if (!Number.isFinite(value) || value <= 0) return
    countEvent(operation, value)
  }

  countEvent("waves-planned", waves.length)
  for (const posture of ["PARENT_DIRECT", "PARALLEL_READ_ONLY", "PARALLEL_WRITERS", "SERIAL_STRUCTURED"]) {
    countEventIfAny(`posture:${posture}`, waves.filter((row) => row?.posture === posture).length)
  }
  countEventIfAny("waves-refused-by-economy-gate", waves.filter((row) =>
    (row?.reason || []).includes("economy-gate-failed")).length)
  countEventIfAny("waves-refused-by-writer-conflict", waves.filter((row) =>
    (row?.reason || []).includes("writer-conflict")).length)
  countEventIfAny("waves-refused-by-research-barrier", waves.filter((row) =>
    (row?.reason || []).includes("research-barrier-open")).length)
  countEventIfAny("waves-refused-by-resource-pressure", waves.filter((row) =>
    (row?.reason || []).some((signal) => String(signal).startsWith("resource-pressure"))).length)
  countEventIfAny("waves-refused-by-release-shape", waves.filter((row) =>
    (row?.reason || []).includes("release-shape")).length)

  // Shared context: a MEASURED character count, never a token claim.
  const sharedChars = shared.reduce((sum, row) => sum + (Number(row?.snapshotChars) || 0), 0)
  countEventIfAny("shared-snapshot-chars", sharedChars)
  countEventIfAny("shared-snapshots", shared.length)
  const avoidedChars = shared.reduce((sum, row) =>
    sum + (Number(row?.accounting?.duplicateContextCharsAvoided?.value) || 0), 0)
  countEventIfAny("duplicate-context-chars-avoided", avoidedChars)

  // Integration transactions: outcomes are counts of real transactions.
  countEvent("integration-transactions", transactions.length)
  for (const outcome of Object.values(INTEGRATION_OUTCOME)) {
    countEventIfAny(`integration:${outcome}`, transactions.filter((row) => row?.outcome === outcome).length)
  }
  countEventIfAny("integration-root-rollbacks", transactions.filter((row) => row?.rootUnchanged === true).length)

  // Loop governance: how often the run REFUSED to retry, and why. A refusal is
  // the interesting event: it is the loop stopping for a stated reason instead of
  // spending its remaining budget. A retry that was allowed is not recorded as a
  // saving, and no wall-time claim is made about either.
  //
  // The stop reason is derived from the OWNER's own output: the fingerprint and
  // budget refusals are recognized by the owner's stable reason text, and every
  // other refusal with a classified failure is the owner refusing a
  // non-retryable class. Nothing is inferred beyond what the owner returned.
  const retries = Array.isArray(telemetry.retries) ? telemetry.retries : []
  const refused = retries.filter((row) => row?.retry === false)
  const refusalReason = (row) => String(row?.reason || "")
  countEventIfAny("loop-retries-allowed", retries.filter((row) => row?.retry === true).length)
  countEventIfAny("loop-retries-refused", refused.length)
  countEventIfAny("loop-stops:repeated-failure", refused.filter((row) =>
    refusalReason(row).includes("fingerprint")).length)
  countEventIfAny("loop-stops:attempt-budget", refused.filter((row) =>
    refusalReason(row).includes("attempt budget exhausted") || refusalReason(row).includes("retry budget exhausted")).length)
  countEventIfAny("loop-stops:no-progress", refused.filter((row) =>
    refusalReason(row).includes("not making progress")).length)
  countEventIfAny("loop-stops:not-retryable", refused.filter((row) =>
    row?.failureClass
    && !refusalReason(row).includes("fingerprint")
    && !refusalReason(row).includes("budget exhausted")
    && !refusalReason(row).includes("not making progress")).length)

  return events
}

/** The efficiency-ledger `kind` this producer emits. */
export const PARALLEL_CODING_EFFICIENCY_KIND = "parallel-coding"

export const parallelCodingRuntimeExports = Object.freeze({
  planWave,
  buildWaveSnapshot,
  buildChildDelta,
  buildSiblingHandoff,
  waveAccounting,
  runIntegration,
  integrationOrder,
  completionDecision,
  retryDecision,
  failureCancellation,
  progressWatchdog,
  pairIndependent,
  waveTelemetryToEfficiencyEvents,
  PARALLEL_CODING_RUNTIME_POLICY,
  PARALLEL_CODING_OWNERS,
  PARALLEL_CODING_EFFICIENCY_KIND,
  EXECUTION_POSTURE,
  INTEGRATION_OUTCOME,
  TASK_SHAPE_V16_15,
  SCOPE_CERTAINTY,
})
