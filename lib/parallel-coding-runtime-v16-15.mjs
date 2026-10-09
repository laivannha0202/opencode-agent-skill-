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
  buildCanonicalChildCapsule,
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
  recoverIncompleteIntegrations,
  runIntegrationTransaction,
} from "./integration-transaction-v16-15.mjs"
import { NOT_MEASURED, measured } from "./measurement-provenance.mjs"
import { defaultCriticalPathHistory } from "./critical-path-history-v16-16.mjs"

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

/**
 * V16.16 canonical child capsule: the ONE production assembly a child
 * receives (stable shared prefix + delta + run binding). It replaces the old
 * `delta text + task JSON + parent goal` triple that either starved the child
 * of shared facts or duplicated them. Delegates to the wave-shared-context
 * owner; this composition adds no policy of its own.
 */
export function buildChildCapsule(input = {}) {
  return buildCanonicalChildCapsule(input)
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

/**
 * Recover transactions left behind by process death. Delegates to the
 * integration transaction's recovery owner. Read-only except for reversing
 * patches PROVEN to belong to an uncommitted transaction of this root; never
 * touches user changes, never runs `git reset --hard`.
 */
export async function recoverIntegration(input = {}) {
  return recoverIncompleteIntegrations(input.root, input.options || input)
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

// ---------------------------------------------------------------------------
// V16.16 additions. Each delegates to (or only reads from) an existing owner;
// this composition still owns no policy of its own.
// ---------------------------------------------------------------------------

/**
 * V16.16 RPC prewarm pipeline (§11).
 *
 * Overlaps worker startup with sandbox creation / context build / test
 * discovery WITHOUT a second pool: every worker is started through the ONE
 * existing `PiRpcWorkerPool`. At most `maxWorkers` (the wave's writer bound)
 * workers are started; a failed prewarm worker is stopped immediately so no
 * abandoned process survives; browser/DeepSeek prewarm is never started here.
 *
 * @param {object} pool       a PiRpcWorkerPool instance
 * @param {Array} requests    [{ key, spec }] one per planned writer
 * @param {object} [options]  { maxWorkers, signal }
 * @returns {{ started, reused, failed, keys }}
 */
export async function prewarmWaveWorkers(pool, requests = [], options = {}) {
  const list = Array.isArray(requests) ? requests.filter((row) => row?.key && row?.spec) : []
  const maxWorkers = Math.max(1, Math.min(3, Math.trunc(Number(options.maxWorkers) || list.length || 1)))
  const bounded = list.slice(0, maxWorkers)
  let started = 0
  let reused = 0
  let failed = 0
  const keys = []
  const outcomes = await Promise.all(bounded.map(async (row) => {
    if (options.signal?.aborted) return { key: row.key, ok: false, reused: false, reason: "aborted" }
    try {
      const result = typeof pool?.prewarm === "function"
        ? await pool.prewarm(row.key, row.spec)
        : { reused: false, prewarmed: false, reason: "pool-has-no-prewarm" }
      return { key: row.key, ok: true, reused: result?.reused === true }
    } catch (error) {
      try {
        if (typeof pool?.discard === "function") await pool.discard(row.key)
      } catch {}
      return { key: row.key, ok: false, reused: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }))
  for (const outcome of outcomes) {
    keys.push(outcome.key)
    if (outcome.ok && outcome.reused) reused += 1
    else if (outcome.ok) started += 1
    else failed += 1
  }
  return {
    schemaVersion: PARALLEL_CODING_RUNTIME_SCHEMA_VERSION,
    policy: PARALLEL_CODING_RUNTIME_POLICY,
    requested: list.length,
    bounded: bounded.length,
    started: measured(started),
    reused: measured(reused),
    failed: measured(failed),
    keys,
    // A prewarm count is activity, never a wall-time saving claim.
    timeSavingClaim: null,
    canProduceVerdict: false,
    deterministic: true,
  }
}

/**
 * V16.16 verification proof composition (§14).
 *
 * A child sandbox PASS never proves the combined root. Re-running an IDENTICAL
 * proof is still waste. This pure planner partitions the root verification
 * workload into REUSE (a child receipt that is still valid for the combined
 * tree) and RUN (must execute fresh). Validity facts come from the
 * verification-receipt-cache owner (supplied by the caller); cross-impact
 * comes from the conflict/task graph (supplied by the caller). When in doubt
 * the gate goes to RUN.
 *
 * A receipt may be reused only when ALL hold: exact command identity, matching
 * workspace fingerprint/policy, successful PASS, fresh enough, and no
 * integrated sibling touches its dependency surface. Final-release and
 * release/security-sensitive gates ALWAYS run fresh.
 *
 * @param {object} input
 * @param {Array} input.candidates  [{ command, args, fingerprint, exitCode,
 *   completed, aborted, timedOut, partial, ageMs, affectedBySiblings,
 *   gateName, lockfileChanged, configChanged }]
 * @param {boolean} [input.finalRelease]
 * @param {string[]} [input.requireFreshCommands]
 */
export function planProofReuse(input = {}) {
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  const finalRelease = input.finalRelease === true
  const requireFresh = new Set((input.requireFreshCommands || []).map(String))
  const reuse = []
  const run = []
  for (const candidate of candidates) {
    const args = Array.isArray(candidate.args) ? candidate.args.map(String) : []
    const command = [String(candidate.command || ""), ...args].join(" ").trim()
    const refuse = (reason) => run.push({ command, args, gateName: candidate.gateName || null, reason })
    if (!command) {
      refuse("empty-command-identity")
      continue
    }
    if (finalRelease) {
      refuse("final-release-requires-fresh-proof")
      continue
    }
    if (requireFresh.has(command)) {
      refuse("release-or-security-gate-requires-fresh-proof")
      continue
    }
    if (candidate.lockfileChanged === true || candidate.configChanged === true) {
      refuse("lockfile-or-config-change-invalidates-command-semantics")
      continue
    }
    if (candidate.affectedBySiblings === true) {
      refuse("sibling-cross-impact")
      continue
    }
    if (Number(candidate.exitCode) !== 0 || candidate.completed !== true
      || candidate.aborted === true || candidate.timedOut === true || candidate.partial === true) {
      refuse("no-proven-pass")
      continue
    }
    if (!candidate.fingerprint) {
      refuse("fingerprint-unprovable")
      continue
    }
    const ttlMs = Math.max(1, Number(input.ttlMs) || 30 * 60_000)
    if (!Number.isFinite(Number(candidate.ageMs)) || Number(candidate.ageMs) > ttlMs) {
      refuse("proof-not-fresh")
      continue
    }
    reuse.push({ command, args, gateName: candidate.gateName || null, fingerprint: candidate.fingerprint })
  }
  return {
    schemaVersion: PARALLEL_CODING_RUNTIME_SCHEMA_VERSION,
    policy: PARALLEL_CODING_RUNTIME_POLICY,
    reuse,
    run,
    finalRelease,
    // Planning reuse never asserts PASS. Only the local verifier can.
    canProduceVerdict: false,
    deterministic: true,
  }
}

/**
 * V16.16 verification proof execution (§14, production wiring).
 *
 * The planner (`planProofReuse`) only partitions. This is the effectful half
 * that makes the partition CHANGE verification work instead of only
 * telemetry:
 *
 *   - `reuse` entries are CONSUMED via the injected receipt finder (exact
 *     command identity + still-valid receipt). The injected fresh runner is
 *     NOT called for them, so an eligible duplicate execution is actually
 *     prevented and the receipt is attached as evidence.
 *   - `run` entries MUST execute fresh via the injected runner (final
 *     release, security-sensitive gates, lockfile/config changes, sibling
 *     cross-impact, stale fingerprints and failed/partial/timed-out receipts
 *     all land here by construction of the planner).
 *
 * The local verifier still owns PASS: this function never returns a verdict,
 * only `{ consumed, executed }` evidence for the verifier to judge
 * (`verifierOwnsVerdict: true`, `canProduceVerdict: false`). When a reuse
 * receipt is unavailable (evicted/stale) the command fails over to fresh
 * execution rather than inferring PASS.
 *
 * @param {object} proofPlan  a `planProofReuse` result ({ reuse, run })
 * @param {object} deps
 * @param {function} [deps.findReceipt]  async (command, entry) => receipt|null
 * @param {function} [deps.runFresh]     async (command, entry) => result
 */
export async function executeProofPlan(proofPlan = {}, deps = {}) {
  const reuse = Array.isArray(proofPlan?.reuse) ? proofPlan.reuse : []
  const run = Array.isArray(proofPlan?.run) ? proofPlan.run : []
  const findReceipt = typeof deps.findReceipt === "function" ? deps.findReceipt : async () => null
  const runFresh = typeof deps.runFresh === "function" ? deps.runFresh : async () => ({ executed: false, reason: "no-runner" })
  const consumed = []
  const executed = []
  for (const entry of reuse) {
    const command = String(entry?.command || "").trim()
    if (!command) continue
    let receipt = null
    try {
      receipt = await findReceipt(command, entry)
    } catch {
      receipt = null
    }
    if (receipt) {
      consumed.push({
        command,
        gateName: entry?.gateName || null,
        fingerprint: entry?.fingerprint || null,
        receiptId: receipt?.id || receipt?.receipt?.id || null,
      })
      continue
    }
    // Receipt unavailable: fail over to fresh execution, never infer PASS.
    try {
      const result = await runFresh(command, entry)
      executed.push({ command, fresh: true, failoverFromReuse: true, result: result ?? null })
    } catch (error) {
      executed.push({ command, fresh: true, failoverFromReuse: true, error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const entry of run) {
    const command = String(entry?.command || "").trim()
    if (!command) continue
    try {
      const result = await runFresh(command, entry)
      executed.push({ command, fresh: true, reason: entry?.reason || null, result: result ?? null })
    } catch (error) {
      executed.push({ command, fresh: true, reason: entry?.reason || null, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    schemaVersion: PARALLEL_CODING_RUNTIME_SCHEMA_VERSION,
    policy: PARALLEL_CODING_RUNTIME_POLICY,
    consumed,
    executed,
    // The verifier remains the sole PASS authority; this record is evidence.
    verifierOwnsVerdict: true,
    canProduceVerdict: false,
    // The partition is deterministic; the fresh executions are real work.
    deterministic: false,
  }
}

/**
 * V16.16 end-to-end critical-path telemetry (§17).
 *
 * Builds the per-run/per-wave telemetry record from MEASURED pieces. Every
 * field the caller did not measure stays NOT_MEASURED (never a fake zero),
 * and provider tokens stay NOT_MEASURED unless the provider reported them.
 * The record is data for future economy tuning, never context payload.
 */
const TELEMETRY_MS_FIELDS = Object.freeze([
  "totalWallMs", "planningMs", "sandboxMs", "rpcStartupMs", "contextBuildMs",
  "executionMs", "targetedVerificationMs", "integrationMs", "rootVerificationMs", "cleanupMs",
])
const TELEMETRY_COUNT_FIELDS = Object.freeze([
  "parentTurns", "childTurns", "deepseekCallsAttempted", "deepseekCallsCompleted",
  "deepseekCallsCancelled", "networkAttempts", "networkCompleted", "networkCancelled",
  "rpcColdStarts", "rpcWarmReuses", "filesRead", "filesReread", "bytesRead", "hashBytes",
  "testsLaunched", "testsReused", "verificationReceiptsReused", "toolCalls",
  "modelVisibleToolChars", "rawToolChars", "contextCharsParent", "contextCharsChildren",
  "sharedContextChars",
])

export function buildCriticalPathTelemetry(input = {}) {
  const record = {
    schemaVersion: PARALLEL_CODING_RUNTIME_SCHEMA_VERSION,
    policy: PARALLEL_CODING_RUNTIME_POLICY,
    provenance: {},
  }
  for (const field of TELEMETRY_MS_FIELDS) {
    const value = Number(input[field])
    record[field] = Number.isFinite(value) && value >= 0 ? measured(Math.round(value)) : NOT_MEASURED
    record.provenance[field] = record[field].provenance
  }
  for (const field of TELEMETRY_COUNT_FIELDS) {
    const value = Number(input[field])
    record[field] = Number.isFinite(value) && value >= 0 ? measured(Math.trunc(value)) : NOT_MEASURED
    record.provenance[field] = record[field].provenance
  }
  const providerFields = ["providerInputTokens", "providerCachedInputTokens", "providerOutputTokens"]
  for (const field of providerFields) {
    const value = Number(input[field])
    record[field] = Number.isFinite(value) && value >= 0 ? measured(Math.trunc(value)) : NOT_MEASURED
    record.provenance[field] = record[field].provenance
  }
  record.tokenSavingClaim = null
  record.canProduceVerdict = false
  record.deterministic = true
  return record
}

/**
 * V16.16 stop-when-proven (§18).
 *
 * The loop stops ONLY when correctness is proven: edits complete, targeted
 * verification PASS (by the verifier, never by this planner), requirement
 * ledger satisfied, no high-risk evidence, stable generation, no pending
 * dependency, no release gate outstanding. Anything else is CONTINUE with the
 * stated missing proof. This planner never creates PASS itself.
 */
export function shouldStopProven(input = {}) {
  const missing = []
  if (input.editsComplete !== true) missing.push("required edits are not complete")
  if (input.verificationPass !== true) missing.push("required verification has not produced PASS")
  if (input.requirementsSatisfied !== true) missing.push("requirement ledger is not satisfied")
  if (input.highRiskEvidence === true) missing.push("unresolved high-risk evidence remains")
  if (input.staleGeneration === true) missing.push("workspace generation is stale")
  if (Number(input.pendingDependencies) > 0) missing.push(`${input.pendingDependencies} pending dependenc(ies) remain`)
  if (input.releaseGateRequested === true) missing.push("a release gate is outstanding")
  if (missing.length === 0) {
    return { stop: true, reason: "required edits complete, targeted verification PASS, ledger satisfied, no open risk", canProduceVerdict: false, deterministic: true }
  }
  return { stop: false, reason: missing.join("; "), missing, canProduceVerdict: false, deterministic: true }
}

/**
 * Record one wave's MEASURED component timings into the bounded process-local
 * history. Only measured numbers are recorded; absent fields stay absent.
 * The next wave's economy gate then tunes within its clamp band instead of
 * using fallbacks blindly. Missing history is NOT_MEASURED, never invented.
 */
export function recordWaveHistory(input = {}) {
  const history = defaultCriticalPathHistory()
  const observation = {}
  for (const field of [
    "sandboxCreateMs", "rpcWorkerStartMs", "contextBuildMs", "childExecutionMs",
    "targetedVerifyMs", "integrationMs", "queueMs", "waveWallMs",
  ]) {
    const value = Number(input[field])
    if (Number.isFinite(value) && value >= 0) observation[field] = value
  }
  return history.record(observation)
}

/** Current bounded history estimates for the economy gate (or NOT_MEASURED). */
export function waveHistoryEstimates() {
  return defaultCriticalPathHistory().estimates()
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
  // V16.16 telemetry correctness (§16): a ROLLBACK is an actual reversal of an
  // applied patch, not merely "the root is unchanged". A preflight rejection
  // or a nothing-to-integrate wave leaves the root untouched by design and is
  // already counted under its own outcome above; counting it here inflated the
  // rollback rate with waves that never mutated anything.
  countEventIfAny("integration-root-rollbacks", transactions.filter((row) =>
    row?.outcome === INTEGRATION_OUTCOME.APPLY_FAILED_ROLLED_BACK
    || row?.outcome === INTEGRATION_OUTCOME.ROLLBACK_INCOMPLETE).length)
  countEventIfAny("integration-preflight-rejected-noop", transactions.filter((row) =>
    row?.outcome === INTEGRATION_OUTCOME.PREFLIGHT_REJECTED).length)
  countEventIfAny("integration-nothing-to-integrate", transactions.filter((row) =>
    row?.outcome === INTEGRATION_OUTCOME.NOTHING_TO_INTEGRATE).length)

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
  buildChildCapsule,
  buildSiblingHandoff,
  waveAccounting,
  runIntegration,
  recoverIntegration,
  integrationOrder,
  completionDecision,
  retryDecision,
  failureCancellation,
  progressWatchdog,
  pairIndependent,
  prewarmWaveWorkers,
  planProofReuse,
  executeProofPlan,
  buildCriticalPathTelemetry,
  shouldStopProven,
  recordWaveHistory,
  waveHistoryEstimates,
  waveTelemetryToEfficiencyEvents,
  PARALLEL_CODING_RUNTIME_POLICY,
  PARALLEL_CODING_OWNERS,
  PARALLEL_CODING_EFFICIENCY_KIND,
  EXECUTION_POSTURE,
  INTEGRATION_OUTCOME,
  TASK_SHAPE_V16_15,
  SCOPE_CERTAINTY,
})
