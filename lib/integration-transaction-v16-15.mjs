// V16.15 Transactional Wave Integration.
//
// WHY THIS MODULE EXISTS
//
// V16.5/V16.12 integration is SEQUENTIAL and only implicitly safe: the caller
// loops over completed sandboxes, applies each one, and reverses the ones it
// already applied if a LATER one throws. Three real gaps follow from that:
//
//   1. NOTHING IS CHECKED UP FRONT. The second patch may be unappliable, and the
//      root has already been mutated by the first before anyone finds out.
//   2. CHILD-CHILD CONFLICTS ARE FOUND BY ACCIDENT. Two writers that touched the
//      same file are detected (in `pi/extensions/ues.ts`) by comparing changed
//      file lists AFTER execution, not by proving the PATCHES do not collide.
//   3. ROLLBACK IS BEST-EFFORT. `rollbackTaskSandbox` reverses a patch, but if a
//      later patch changed an overlapping region, the reverse apply fails and the
//      catch swallows it (`await ... .catch(() => {})`), leaving a half-integrated
//      wave.
//
// This module makes a wave integration a real bounded TRANSACTION:
//
//   PHASE A  PREFLIGHT ALL   - every patch is verified against the CURRENT root
//                              without mutating anything. If ANY patch fails, the
//                              root is untouched and the wave is rejected whole.
//   PHASE B  APPLY           - patches are applied in a DETERMINISTIC order
//                              (dependency order, then task key). Completion order
//                              can never influence root mutation order.
//   PHASE C  POST-APPLY      - the root identity is recomputed, changed files are
//                              recorded, and affected caches are invalidated.
//
//   FAILURE  If any apply unexpectedly fails, EVERY patch applied by this
//            transaction is reversed and the pre-transaction root identity is
//            re-verified. A half-integrated wave is a hard error, never a state.
//
// AUTHORITY BOUNDARY
//
// This module mutates the root ONLY through the existing sandbox owner
// (`lib/worktree-sandbox.mjs`): `preflightTaskSandbox` for phase A and
// `integrateTaskSandbox` for phase B. It never runs `git apply` itself, never
// invents a manual file reversal, and never deletes a worktree on its own. The
// rollback path reuses `rollbackTaskSandbox`, which is the owner of "undo this
// sandbox's patch".

import {
  integrateTaskSandbox,
  preflightTaskSandbox,
  rootWorkspaceIdentity,
} from "./worktree-sandbox.mjs"
import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const INTEGRATION_TRANSACTION_SCHEMA_VERSION = 1
export const INTEGRATION_TRANSACTION_POLICY = "integration-transaction-v16-15"

export const INTEGRATION_PHASE = Object.freeze({
  PREFLIGHT: "preflight",
  APPLY: "apply",
  POST_APPLY: "post-apply",
  ROLLBACK: "rollback",
})

export const INTEGRATION_OUTCOME = Object.freeze({
  INTEGRATED: "integrated",
  PREFLIGHT_REJECTED: "preflight-rejected",
  APPLY_FAILED_ROLLED_BACK: "apply-failed-rolled-back",
  ROLLBACK_INCOMPLETE: "rollback-incomplete",
  NOTHING_TO_INTEGRATE: "nothing-to-integrate",
})

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))].sort()
}

/**
 * Deterministic integration order.
 *
 * LAW: root mutation order must be a function of DECLARED structure only.
 * Completion order, arrival order and Promise resolution order are never inputs.
 *
 * Order keys, in priority:
 *   1. dependency depth (a patch whose task depends on nothing goes first)
 *   2. wave number (ascending)
 *   3. task key (ascending, lexicographic)
 *
 * @param {Array} patches  [{ id, taskId, wave, dependsOn }]
 * @param {object} [options] { dependencyOrder }
 */
export function deterministicIntegrationOrder(patches = [], options = {}) {
  const rows = (patches || []).map((row, index) => ({
    id: String(row?.id ?? row?.taskId ?? index),
    taskId: String(row?.taskId ?? row?.id ?? index),
    wave: Number.isFinite(Number(row?.wave)) ? Number(row.wave) : 0,
    dependsOn: Array.isArray(row?.dependsOn) ? row.dependsOn.map(String) : [],
    index,
  }))

  const byId = new Map(rows.map((row) => [row.taskId, row]))
  const depthCache = new Map()
  const depthOf = (row, seen = new Set()) => {
    if (depthCache.has(row.taskId)) return depthCache.get(row.taskId)
    if (seen.has(row.taskId)) return 0
    seen.add(row.taskId)
    let depth = 0
    for (const dep of row.dependsOn) {
      const parent = byId.get(dep)
      if (!parent) continue
      depth = Math.max(depth, depthOf(parent, seen) + 1)
    }
    depthCache.set(row.taskId, depth)
    return depth
  }

  const declaredOrder = Array.isArray(options.dependencyOrder)
    ? options.dependencyOrder.map(String)
    : []
  const rank = new Map(declaredOrder.map((id, index) => [id, index]))

  const sorted = [...rows].sort((a, b) => {
    const depthA = depthOf(a)
    const depthB = depthOf(b)
    if (depthA !== depthB) return depthA - depthB
    if (a.wave !== b.wave) return a.wave - b.wave
    const rankA = rank.has(a.taskId) ? rank.get(a.taskId) : Number.MAX_SAFE_INTEGER
    const rankB = rank.has(b.taskId) ? rank.get(b.taskId) : Number.MAX_SAFE_INTEGER
    if (rankA !== rankB) return rankA - rankB
    if (a.taskId === b.taskId) return a.index - b.index
    return a.taskId < b.taskId ? -1 : 1
  })

  return {
    schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
    policy: INTEGRATION_TRANSACTION_POLICY,
    order: sorted.map((row) => row.taskId),
    depths: Object.fromEntries(sorted.map((row) => [row.taskId, depthOf(row)])),
    // Proof the order is not completion-derived: the input completion order is
    // recorded separately and is never used.
    completionOrderIgnored: true,
    deterministic: true,
  }
}

/**
 * Run one bounded wave integration transaction.
 *
 * @param {object} input
 * @param {string}   input.root
 * @param {Array}    input.patches   [{ id, taskId, sandboxDir, wave, dependsOn, writeFiles, runId }]
 * @param {AbortSignal} [input.signal]
 * @param {object}   [input.options]
 * @param {boolean}  [input.options.dryRun]           preflight only; never mutates
 * @param {string}   [input.options.expectedRunId]    sandbox run identity to enforce
 * @param {number}   [input.options.expectedRootHead] root HEAD the wave started from
 * @param {Array}    [input.options.dependencyOrder]
 * @param {(event: object) => void} [input.onEvent]
 */
export async function runIntegrationTransaction(input = {}) {
  const root = String(input.root || "")
  if (!root) throw new Error("integration-transaction: root is required")
  const patches = Array.isArray(input.patches) ? input.patches.filter((row) => row?.sandboxDir) : []
  const emit = typeof input.onEvent === "function" ? input.onEvent : () => {}
  const options = input.options || {}
  const startedAt = Date.now()

  if (patches.length === 0) {
    return {
      schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
      policy: INTEGRATION_TRANSACTION_POLICY,
      outcome: INTEGRATION_OUTCOME.NOTHING_TO_INTEGRATE,
      rootUnchanged: true,
      applied: [],
      rejected: [],
      order: [],
      preflightMs: measured(0),
      applyMs: measured(0),
      totalMs: measured(Date.now() - startedAt),
      rootBefore: null,
      rootAfter: null,
      canProduceVerdict: false,
      deterministic: true,
    }
  }

  const ordering = deterministicIntegrationOrder(patches, { dependencyOrder: options.dependencyOrder })
  const orderedPatches = ordering.order
    .map((taskId) => patches.find((row) => String(row.taskId ?? row.id) === taskId))
    .filter(Boolean)

  // -------------------------------------------------------------------------
  // PHASE 0: capture the pre-transaction root identity.
  // -------------------------------------------------------------------------
  const rootBefore = rootWorkspaceIdentity(root)
  if (options.expectedRootHead != null && rootBefore.head !== String(options.expectedRootHead)) {
    return {
      schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
      policy: INTEGRATION_TRANSACTION_POLICY,
      outcome: INTEGRATION_OUTCOME.PREFLIGHT_REJECTED,
      rootUnchanged: true,
      applied: [],
      rejected: orderedPatches.map((row) => ({
        taskId: String(row.taskId ?? row.id),
        reason: "root-advanced-since-wave-start",
        detail: `expected ${options.expectedRootHead}, found ${rootBefore.head}`,
      })),
      order: ordering.order,
      rootBefore,
      rootAfter: rootBefore,
      preflightMs: measured(0),
      applyMs: measured(0),
      totalMs: measured(Date.now() - startedAt),
      canProduceVerdict: false,
      deterministic: true,
    }
  }

  // -------------------------------------------------------------------------
  // PHASE A: PREFLIGHT ALL. No root mutation may occur before every patch passes.
  // -------------------------------------------------------------------------
  const preflightStartedAt = Date.now()
  const preflights = []
  const rejected = []
  for (const patch of orderedPatches) {
    if (input.signal?.aborted) {
      rejected.push({ taskId: String(patch.taskId ?? patch.id), reason: "cancelled" })
      continue
    }
    const result = await preflightTaskSandbox(root, patch.sandboxDir, {
      expectedRunId: options.expectedRunId,
      currentRootHead: rootBefore.head,
      allowedFiles: Array.isArray(patch.writeFiles) ? patch.writeFiles : undefined,
      ownerRoot: root,
    }).catch((error) => ({
      ok: false,
      dir: patch.sandboxDir,
      reason: "preflight-threw",
      detail: error instanceof Error ? error.message : String(error),
      checks: [],
    }))
    preflights.push({ patch, result })
    emit({ type: "integration.preflight", taskId: String(patch.taskId ?? patch.id), ok: result.ok === true, reason: result.reason })
    if (!result.ok) {
      rejected.push({
        taskId: String(patch.taskId ?? patch.id),
        reason: result.reason,
        detail: result.detail || null,
        changed: result.changed || [],
      })
    }
  }

  // Child-child patch collision: two accepted patches that rewrite the SAME file
  // cannot both apply, even if each one applies cleanly on its own.
  const okPreflights = preflights.filter((row) => row.result.ok === true)
  const patchOwners = new Map()
  const collisions = []
  for (const row of okPreflights) {
    for (const file of row.result.changed || []) {
      const owner = String(row.patch.taskId ?? row.patch.id)
      const previous = patchOwners.get(file)
      if (previous && previous !== owner) {
        collisions.push({ file, left: previous, right: owner })
      } else {
        patchOwners.set(file, owner)
      }
    }
  }
  const preflightMs = Date.now() - preflightStartedAt

  // A transaction is all-or-nothing. ANY rejection or collision aborts the whole
  // wave with the root still untouched.
  if (rejected.length || collisions.length) {
    emit({ type: "integration.rejected", rejected: rejected.length, collisions: collisions.length })
    return {
      schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
      policy: INTEGRATION_TRANSACTION_POLICY,
      outcome: INTEGRATION_OUTCOME.PREFLIGHT_REJECTED,
      rootUnchanged: true,
      applied: [],
      rejected,
      collisions,
      order: ordering.order,
      preflight: preflights.map((row) => ({
        taskId: String(row.patch.taskId ?? row.patch.id),
        ok: row.result.ok === true,
        reason: row.result.reason,
        changed: row.result.changed || [],
        checks: row.result.checks || [],
      })),
      rootBefore,
      rootAfter: rootWorkspaceIdentity(root),
      preflightMs: measured(preflightMs),
      applyMs: measured(0),
      totalMs: measured(Date.now() - startedAt),
      canProduceVerdict: false,
      deterministic: true,
    }
  }

  if (options.dryRun === true) {
    return {
      schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
      policy: INTEGRATION_TRANSACTION_POLICY,
      outcome: INTEGRATION_OUTCOME.INTEGRATED,
      dryRun: true,
      rootUnchanged: true,
      applied: [],
      rejected: [],
      order: ordering.order,
      preflight: preflights.map((row) => ({
        taskId: String(row.patch.taskId ?? row.patch.id),
        ok: true,
        reason: row.result.reason,
        changed: row.result.changed || [],
      })),
      rootBefore,
      rootAfter: rootBefore,
      preflightMs: measured(preflightMs),
      applyMs: measured(0),
      totalMs: measured(Date.now() - startedAt),
      canProduceVerdict: false,
      deterministic: true,
    }
  }

  // -------------------------------------------------------------------------
  // PHASE B: APPLY in deterministic order.
  // -------------------------------------------------------------------------
  const applyStartedAt = Date.now()
  const applied = []
  const appliedFiles = []
  let applyError = null

  for (const row of okPreflights) {
    const patch = row.patch
    const taskId = String(patch.taskId ?? patch.id)
    if (input.signal?.aborted) {
      applyError = Object.assign(new Error("integration cancelled during apply"), { code: "INTEGRATION_CANCELLED" })
      break
    }
    try {
      const receipt = await integrateTaskSandbox(root, patch.sandboxDir, { keep: true })
      applied.push({ taskId, sandboxDir: patch.sandboxDir, receipt })
      appliedFiles.push(...(receipt.changed || []))
      emit({ type: "integration.applied", taskId, changed: receipt.changed || [] })
    } catch (error) {
      applyError = error
      emit({ type: "integration.apply-failed", taskId, error: error instanceof Error ? error.message : String(error) })
      break
    }
  }

  const applyMs = Date.now() - applyStartedAt

  // -------------------------------------------------------------------------
  // FAILURE: reverse EVERY patch this transaction applied. A half-integrated
  // wave must not exist as a state.
  // -------------------------------------------------------------------------
  if (applyError) {
    const rollbackStartedAt = Date.now()
    const rollback = []
    for (const row of [...applied].reverse()) {
      try {
        const { rollbackTaskSandbox } = await import("./worktree-sandbox.mjs")
        const result = await rollbackTaskSandbox(root, row.sandboxDir, { keep: true })
        rollback.push({ taskId: row.taskId, rolledBack: result.rolledBack === true })
        emit({ type: "integration.rolled-back", taskId: row.taskId })
      } catch (error) {
        rollback.push({
          taskId: row.taskId,
          rolledBack: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const rootAfter = rootWorkspaceIdentity(root)
    const clean = rootAfter.identity === rootBefore.identity
    return {
      schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
      policy: INTEGRATION_TRANSACTION_POLICY,
      outcome: clean
        ? INTEGRATION_OUTCOME.APPLY_FAILED_ROLLED_BACK
        : INTEGRATION_OUTCOME.ROLLBACK_INCOMPLETE,
      rootUnchanged: clean,
      applied: applied.map((row) => ({ taskId: row.taskId, changed: row.receipt?.changed || [] })),
      rejected: [{
        taskId: String(okPreflights[applied.length]?.patch?.taskId ?? "unknown"),
        reason: "apply-failed",
        detail: applyError instanceof Error ? applyError.message : String(applyError),
      }],
      order: ordering.order,
      rollback,
      rollbackMs: measured(Date.now() - rollbackStartedAt),
      rootBefore,
      rootAfter,
      preflightMs: measured(preflightMs),
      applyMs: measured(applyMs),
      totalMs: measured(Date.now() - startedAt),
      canProduceVerdict: false,
      deterministic: true,
    }
  }

  // -------------------------------------------------------------------------
  // PHASE C: POST-APPLY. Recompute identity, record changed files.
  // -------------------------------------------------------------------------
  const rootAfter = rootWorkspaceIdentity(root)
  const changedFiles = uniqueSorted(appliedFiles)
  emit({ type: "integration.post-apply", changedFiles: changedFiles.length })

  return {
    schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
    policy: INTEGRATION_TRANSACTION_POLICY,
    outcome: INTEGRATION_OUTCOME.INTEGRATED,
    rootUnchanged: false,
    applied: applied.map((row) => ({
      taskId: row.taskId,
      changed: row.receipt?.changed || [],
      base: row.receipt?.base || null,
    })),
    rejected: [],
    order: ordering.order,
    changedFiles,
    // Post-apply contract for the caller: these must be re-verified at the root.
    // A child's sandbox PASS does NOT prove the combined result.
    rootVerificationRequired: changedFiles.length > 0,
    cacheInvalidationRequired: changedFiles.length > 0,
    rootBefore,
    rootAfter,
    rootIdentityChanged: rootAfter.identity !== rootBefore.identity,
    preflightMs: measured(preflightMs),
    applyMs: measured(applyMs),
    totalMs: measured(Date.now() - startedAt),
    // Integration NEVER asserts PASS. Only the local verifier can.
    canProduceVerdict: false,
    deterministic: true,
  }
}

/**
 * Classify a failed child so the caller can decide recovery deterministically
 * instead of retrying blindly. The classification is a function of observed
 * facts (stop reason, exit code, error text, failure fingerprint), never a guess.
 */
export const FAILURE_CLASS = Object.freeze({
  IMPLEMENTATION_FAILURE: "IMPLEMENTATION_FAILURE",
  TEST_FAILURE: "TEST_FAILURE",
  TIMEOUT: "TIMEOUT",
  PROCESS_HANG: "PROCESS_HANG",
  STALE: "STALE",
  CONFLICT: "CONFLICT",
  POLICY_BLOCK: "POLICY_BLOCK",
  DEPENDENCY_CHANGED: "DEPENDENCY_CHANGED",
  UNKNOWN: "UNKNOWN",
})

const TEST_FAILURE_RE = /\b(assert|AssertionError|expected .* (?:to|but)|failing tests?|test failed|tests failed)\b/i
const POLICY_RE = /\b(policy|blocked|forbidden|denied|permission|not permitted|destructive)\b/i
const CONFLICT_RE = /\b(conflict|does not apply|patch failed|merge conflict)\b/i

export function classifyChildFailure(input = {}) {
  const stopReason = String(input.stopReason || "").toLowerCase()
  const status = String(input.status || "").toLowerCase()
  const error = String(input.error || input.failureText || "")
  const exitCode = Number.isFinite(Number(input.exitCode)) ? Number(input.exitCode) : null
  const stale = input.stale === true
  const timedOut = stopReason.includes("timeout") || status === "timed-out"
  const inactivity = stopReason.includes("inactivity")

  if (stale) return { class: FAILURE_CLASS.STALE, reason: "workspace generation advanced before the result resolved", retryable: false }
  if (inactivity) return { class: FAILURE_CLASS.PROCESS_HANG, reason: "child produced no activity inside the watchdog window", retryable: true }
  if (timedOut) return { class: FAILURE_CLASS.TIMEOUT, reason: "child exceeded its declared timeout", retryable: true }
  if (CONFLICT_RE.test(error)) return { class: FAILURE_CLASS.CONFLICT, reason: "patch or file conflict", retryable: false }
  if (POLICY_RE.test(error)) return { class: FAILURE_CLASS.POLICY_BLOCK, reason: "safety or permission policy refused the work", retryable: false }
  if (TEST_FAILURE_RE.test(error)) return { class: FAILURE_CLASS.TEST_FAILURE, reason: "targeted verification failed", retryable: true }
  if (exitCode != null && exitCode !== 0) return { class: FAILURE_CLASS.IMPLEMENTATION_FAILURE, reason: `child exited ${exitCode}`, retryable: true }
  if (error) return { class: FAILURE_CLASS.IMPLEMENTATION_FAILURE, reason: "child reported a failure without a test signature", retryable: true }
  return { class: FAILURE_CLASS.UNKNOWN, reason: "no deterministic failure signature", retryable: false }
}

/**
 * Decide whether a failed child may be retried.
 *
 * LAWS
 *   * At most ONE automatic retry per task (V16.15 directive).
 *   * The SAME failure fingerprint is never retried: a repeated identical
 *     failure escalates instead of looping.
 *   * An independent sibling is never cancelled by an unrelated failure.
 */
export function decideRetry(input = {}) {
  const classification = input.classification || classifyChildFailure(input)
  const attempts = Math.max(0, Math.trunc(Number(input.attempts) || 0))
  const fingerprint = String(input.fingerprint || "")
  const seen = Array.isArray(input.seenFingerprints) ? input.seenFingerprints.map(String) : []
  const maxRetries = Math.max(0, Math.min(2, Math.trunc(Number(input.maxRetries ?? 1))))

  if (seen.includes(fingerprint) && fingerprint) {
    return {
      retry: false,
      escalate: true,
      reason: "identical failure fingerprint already attempted; escalate diagnosis instead of respawning",
      class: classification.class,
      deterministic: true,
    }
  }
  if (!classification.retryable) {
    return {
      retry: false,
      escalate: true,
      reason: classification.reason,
      class: classification.class,
      deterministic: true,
    }
  }
  if (attempts >= maxRetries) {
    return {
      retry: false,
      escalate: true,
      reason: `retry budget exhausted (${attempts}/${maxRetries})`,
      class: classification.class,
      deterministic: true,
    }
  }
  return {
    retry: true,
    escalate: false,
    reason: `retryable ${classification.class}: ${classification.reason}`,
    class: classification.class,
    nextAttempt: attempts + 1,
    deterministic: true,
  }
}

/**
 * Compute the deterministic cancellation set for a failed child.
 *
 * The set contains the failed child's DEPENDENTS only. Independent siblings and
 * still-useful read-only work are preserved, which is the V16.15 first-failure
 * policy. `cancelAll` is returned only for a genuine global invalidation.
 */
export function planFailureCancellation(input = {}) {
  const failedTaskId = String(input.failedTaskId || "")
  const tasks = Array.isArray(input.tasks) ? input.tasks : []
  const invalidatesWave = input.invalidatesSharedAssumptions === true

  if (invalidatesWave) {
    return {
      cancel: tasks.map((row) => String(row.id ?? row.taskId)),
      preserve: [],
      reason: "the failure invalidated an assumption shared by the whole wave",
      cancelAll: true,
      deterministic: true,
    }
  }

  const dependents = new Set()
  const queue = [failedTaskId]
  while (queue.length) {
    const current = queue.shift()
    for (const task of tasks) {
      const id = String(task.id ?? task.taskId)
      const deps = Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []
      if (deps.includes(current) && !dependents.has(id)) {
        dependents.add(id)
        queue.push(id)
      }
    }
  }

  const cancel = [...dependents].filter((id) => id !== failedTaskId).sort()
  const preserve = tasks
    .map((row) => String(row.id ?? row.taskId))
    .filter((id) => id !== failedTaskId && !dependents.has(id))
    .sort()

  return {
    cancel,
    preserve,
    reason: cancel.length
      ? `${cancel.length} dependent task(s) can no longer proceed`
      : "no dependent task exists; every independent sibling keeps running",
    cancelAll: false,
    deterministic: true,
  }
}

/**
 * Detect a no-progress loop across waves.
 *
 * A bounded one-shot completion loop must terminate. This tracks a fingerprint
 * per wave (requirement set + changed files + failure fingerprints) and refuses
 * to continue when the SAME state repeats, or when a hard budget is exhausted.
 */
export function createProgressWatchdog(input = {}) {
  const maxWaves = Math.max(1, Math.min(64, Math.trunc(Number(input.maxWaves) || 12)))
  const seen = new Map()
  let waves = 0

  return {
    schemaVersion: INTEGRATION_TRANSACTION_SCHEMA_VERSION,
    policy: INTEGRATION_TRANSACTION_POLICY,
    maxWaves,

    /** Record one completed wave. Returns the loop decision. */
    observe(wave = {}) {
      waves += 1
      const fingerprint = String(wave.fingerprint || "")
      const previous = fingerprint ? seen.get(fingerprint) : undefined
      if (fingerprint) seen.set(fingerprint, (previous || 0) + 1)

      if (waves > maxWaves) {
        return {
          continue: false,
          reason: "wave budget exhausted",
          terminal: "BLOCKED",
          waves,
          fingerprint,
          deterministic: true,
        }
      }
      if (previous != null) {
        return {
          continue: false,
          reason: "identical wave state observed twice; the loop is not making progress",
          terminal: "BLOCKED",
          waves,
          fingerprint,
          deterministic: true,
        }
      }
      return { continue: true, reason: "progress", terminal: null, waves, fingerprint, deterministic: true }
    },

    /** Current state, for the run report. */
    snapshot() {
      return {
        waves,
        maxWaves,
        distinctStates: seen.size,
        repeatedStates: [...seen.values()].filter((count) => count > 1).length,
        provenance: measured(waves),
      }
    },
  }
}

/**
 * Compute the ONE-SHOT completion state from the run's real facts.
 *
 * Terminal outcomes are exactly: DONE, BLOCKED, NEEDS_USER_DECISION, CANCELLED.
 * Internal lifecycle events ("planning finished", "child finished", "tests
 * finished", "ready to integrate") are NOT terminal and never stop the loop.
 */
export const COMPLETION_STATE = Object.freeze({
  DONE: "DONE",
  BLOCKED: "BLOCKED",
  NEEDS_USER_DECISION: "NEEDS_USER_DECISION",
  CANCELLED: "CANCELLED",
  CONTINUE: "CONTINUE",
})

/** The ONLY reasons a one-shot run may stop and ask the user something. */
export const USER_DECISION_REASONS = Object.freeze([
  "destructive-operation-approval",
  "ambiguous-business-behavior",
  "missing-credentials-or-auth",
  "external-publish-approval",
  "irreversible-operation-approval",
])

export function evaluateCompletion(input = {}) {
  if (input.cancelled === true) {
    return { state: COMPLETION_STATE.CANCELLED, reason: "external cancellation", deterministic: true }
  }
  if (input.userDecisionReason) {
    const reason = String(input.userDecisionReason)
    const valid = USER_DECISION_REASONS.includes(reason)
    return {
      state: valid ? COMPLETION_STATE.NEEDS_USER_DECISION : COMPLETION_STATE.BLOCKED,
      reason: valid ? reason : `unrecognized user-decision reason: ${reason}`,
      // An unrecognized reason is a BLOCK, never a prompt: the loop must not
      // invent a question to escape a hard problem.
      deterministic: true,
    }
  }

  const requirementsTotal = Number(input.requirementsTotal)
  const requirementsCovered = Number(input.requirementsCovered)
  const verificationPassed = input.verificationPassed === true
  const blockers = Array.isArray(input.blockers) ? input.blockers.filter(Boolean) : []
  const workspaceStable = input.workspaceStable !== false
  const completionAuditPassed = input.completionAuditPassed !== false
  const pendingTasks = Number(input.pendingTasks) || 0

  if (blockers.length) {
    return {
      state: COMPLETION_STATE.BLOCKED,
      reason: blockers.slice(0, 3).join("; "),
      blockers,
      deterministic: true,
    }
  }
  if (pendingTasks > 0) {
    return { state: COMPLETION_STATE.CONTINUE, reason: `${pendingTasks} task(s) still ready to schedule`, deterministic: true }
  }
  const requirementsDone = Number.isFinite(requirementsTotal) && requirementsTotal > 0
    ? requirementsCovered >= requirementsTotal
    : true
  if (requirementsDone && verificationPassed && workspaceStable && completionAuditPassed) {
    return {
      state: COMPLETION_STATE.DONE,
      reason: "requirements covered, required verification PASS, workspace stable, completion audit satisfied",
      deterministic: true,
    }
  }
  const missing = []
  if (!requirementsDone) missing.push(`requirements ${requirementsCovered}/${requirementsTotal}`)
  if (!verificationPassed) missing.push("required verification has not produced PASS")
  if (!workspaceStable) missing.push("workspace is not stable")
  if (!completionAuditPassed) missing.push("completion audit is not satisfied")
  return { state: COMPLETION_STATE.CONTINUE, reason: missing.join("; "), deterministic: true }
}

export const integrationTransactionExports = Object.freeze({
  runIntegrationTransaction,
  deterministicIntegrationOrder,
  classifyChildFailure,
  decideRetry,
  planFailureCancellation,
  createProgressWatchdog,
  evaluateCompletion,
  INTEGRATION_PHASE,
  INTEGRATION_OUTCOME,
  FAILURE_CLASS,
  COMPLETION_STATE,
  USER_DECISION_REASONS,
})
