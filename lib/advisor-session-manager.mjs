// V16.11 advisor session manager: the SINGLE owner of advisor lifecycle.
//
// HISTORY
//
// In V16.9 this module owned only the advisor CONVERSATION lifecycle (turn gate,
// rotation, generation identity) and was deliberately NOT wired into production,
// because the controller already owned the conversation inline and the browser
// worker lifecycle separately. Wiring it then would have created a SECOND owner
// for the same behaviour (the release directive's "no dual ownership" law).
//
// V16.11 makes it the canonical owner of ALL THREE advisor lifecycles:
//
//   * BrowserWorker          -- acquireWorker() / releaseWorkerLease()
//   * DeepSeekConversation   -- openConversation() / reuseConversation() / closeConversation()
//   * AdvisorRun             -- beginAdvisorRun() / endAdvisorRun()
//
// plus the cross-cutting concerns those lifecycles need:
//
//   * epochs                 -- workerEpoch / profileEpoch / conversationEpoch / runGeneration
//   * health                 -- healthCheck() / recycleIfNeeded()
//   * shutdown()             -- idempotent teardown of everything it owns
//
// It still does NOT re-implement the budget: `lib/deepseek-session-budget.mjs`
// owns creation, turn recording, rotation and telemetry, and
// `lib/deepseek-session-pool.mjs` owns concurrency leases. This module COMPOSES
// those primitives behind one stateful owner, and delegates all identity/staleness
// decisions to `lib/advisor-lifecycle-v16-11.mjs`.
//
// The browser operations (acquire/release/health) are INJECTED. The manager owns
// the LEASE and the epoch bookkeeping; the caller owns the actual process. This is
// what makes the lifecycle deterministically testable without a real browser.
//
// It owns NO evidence policy, NO escalation rule and NO authority.
//
// INVARIANT: single-writer. Exactly one session manager instance drives a given
// conversation at a time; two managers never write the same session, and the
// stale-event gate is the single choke point every event must pass.

import {
  closeConversationSession,
  createConversationSession,
  recordSessionTurn,
  rotateConversationSession,
  sessionTelemetry,
  shouldRotateSession,
} from "./deepseek-session-budget.mjs"
import {
  ADVISOR_LIFECYCLE_POLICY,
  advanceProfileEpoch,
  advanceWorkerEpoch,
  beginAdvisorRun as beginRunIdentity,
  classifyStaleness,
  conversationReuseKey,
  createLifecycleIdentity,
  evaluateConversationReuse,
  openConversation as openConversationIdentity,
} from "./advisor-lifecycle-v16-11.mjs"

// The module's STABLE policy id. This is the V16.9 contract name and is kept
// byte-identical: V16.11 does not replace the session manager, it EXTENDS the
// SAME module to own all three lifecycles. The evolved behaviour is versioned by
// ADVISOR_SESSION_MANAGER_SCHEMA_VERSION (1 -> 2) and
// ADVISOR_SESSION_MANAGER_IMPLEMENTATION, so the historical contract still holds.
export const ADVISOR_SESSION_MANAGER_POLICY = "advisor-session-manager-v16-9"
export const ADVISOR_SESSION_MANAGER_SCHEMA_VERSION = 2
export const ADVISOR_SESSION_MANAGER_IMPLEMENTATION = "advisor-session-manager-v16-11"

// Re-exported so a caller can assert the lifecycle policy this manager speaks.
export { ADVISOR_LIFECYCLE_POLICY }

/**
 * Create the single advisor lifecycle owner.
 *
 * @param {object} options
 * @param {object} [options.sessionBudget] the proven session-budget module
 *        (injected so the manager never imports a second copy of the policy)
 * @param {string} [options.id] conversation id
 * @param {number} [options.turnBudget] ceiling on advisor turns
 * @param {string} [options.resumeCapsule] pending capsule text for the next turn
 * @param {Function} [options.acquireWorker] async () => workerLease | null
 * @param {Function} [options.releaseWorker] async (lease) => void
 * @param {Function} [options.healthCheck] async (lease) => { ok, reason }
 * @param {number} [options.maxReuseCount] recycle after this many reuses
 * @param {number} [options.idleTtlMs] recycle a worker idle longer than this
 * @param {Function} [options.now] injectable clock
 */
export function createAdvisorSessionManager(options = {}) {
  const budgetModule = options.sessionBudget || {
    createConversationSession,
    recordSessionTurn,
    shouldRotateSession,
    rotateConversationSession,
    closeConversationSession,
    sessionTelemetry,
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const acquireWorker = typeof options.acquireWorker === "function" ? options.acquireWorker : null
  const releaseWorker = typeof options.releaseWorker === "function" ? options.releaseWorker : null
  const healthCheckFn = typeof options.healthCheck === "function" ? options.healthCheck : null
  const maxReuseCount = Number.isFinite(Number(options.maxReuseCount)) ? Math.max(0, Math.trunc(Number(options.maxReuseCount))) : 0
  const idleTtlMs = Number.isFinite(Number(options.idleTtlMs)) ? Math.max(0, Number(options.idleTtlMs)) : 0

  let session = options.session
    ? options.session
    : budgetModule.createConversationSession({
        id: options.id,
        taskFingerprint: options.taskFingerprint,
        role: options.role,
        phase: options.phase,
        reasoningMode: options.reasoningMode,
        turnBudget: options.turnBudget,
        env: options.env,
      })
  let turnsUsed = 0
  let rotations = 0
  let pendingResumeCapsule = options.resumeCapsule ? String(options.resumeCapsule) : ""
  let lastTurnAt = null
  let closed = false

  // ---- lifecycle state (single owner) ----
  let identity = createLifecycleIdentity({
    workerEpoch: 0,
    profileEpoch: Number(options.profileEpoch) || 0,
    conversationId: options.id || null,
    conversationEpoch: 0,
    runGeneration: 0,
    workspaceGeneration: Number(options.workspaceGeneration) || 0,
  })
  let workerLease = null
  let workerAcquiredAt = null
  let workerLastUsedAt = null
  let workerReuseCount = 0
  let workerRecycleCount = 0
  let workerAcquireCount = 0
  let conversationOpen = false
  let runActive = false
  let runStartedAt = null
  let shutdownDone = false
  const metrics = {
    workerAcquireCount: 0,
    workerReleaseCount: 0,
    workerRecycleCount: 0,
    workerReuseCount: 0,
    conversationCreated: 0,
    conversationReused: 0,
    conversationInvalidated: 0,
    staleEventDiscarded: 0,
    lateResponseDiscarded: 0,
    runAborts: 0,
    workerCrashes: 0,
  }

  /** The ONLY place "may the advisor send a turn?" is answered. */
  function maySend(kind = "consult", wanted = 1) {
    if (closed) return { allowed: false, reason: `${kind}:session-closed` }
    const turnBudget = Number(session?.turnBudget || 0)
    if (turnBudget <= 0) return { allowed: false, reason: `${kind}:turn-budget-0` }
    if (turnsUsed + wanted > turnBudget) return { allowed: false, reason: `${kind}:turn-budget-exhausted` }
    if (session?.status && session.status !== "open") return { allowed: false, reason: `${kind}:session-not-open` }
    return { allowed: true, reason: null }
  }

  /**
   * Record one completed turn and perform a rotation if the pressure policy
   * says so. The rotation and its resume capsule are produced together so a
   * rotated session always has continuity.
   */
  function recordTurn(kind, result = {}, meta = {}) {
    if (closed) return { recorded: false, reason: "session-closed" }
    turnsUsed += 1
    lastTurnAt = Number(now())
    const outcomeText = String(result?.advisorText || result?.reason || result?.outcome || "")
    try {
      budgetModule.recordSessionTurn(session, {
        inputChars: Number(result?.packet?.chars || meta.inputChars || 0),
        outputChars: outcomeText.length,
        error: result?.outcome === "unavailable" || result?.fallbackToLocal === true ? false : undefined,
        evidenceRefs: result?.packet?.fingerprint ? [String(result.packet.fingerprint)] : [],
        now: lastTurnAt,
      })
    } catch {
      // Accounting failure must never abort a completed turn.
    }
    let rotation = null
    try {
      const decision = budgetModule.shouldRotateSession(session, lastTurnAt)
      if (decision?.rotate === true) rotation = rotate(decision.reasons || [])
    } catch {
      rotation = null
    }
    return { recorded: true, rotation, turnsUsed }
  }

  /** Perform a real rotation: close A, build capsule, open B. */
  function rotate(reasons = []) {
    if (closed) return null
    const outgoing = session
    let capsuleText = ""
    let capsule = null
    try {
      const build = options.buildResumeCapsule
      if (typeof build === "function") {
        capsule = build({ session: outgoing, reasons })
        if (capsule && String(capsule.content || "")) capsuleText = String(capsule.content)
      }
    } catch {
      capsule = null
    }
    let rotated
    try {
      rotated = budgetModule.rotateConversationSession(outgoing, { reason: reasons.join("+") || "rotated" })
    } catch {
      return null
    }
    if (rotated?.ok !== true) return null
    session = rotated.session
    rotations += 1
    // A rotation is a NEW conversation on the same worker epoch. Advance the
    // conversation epoch so any observer bound to the old conversation is stale.
    identity = openConversationIdentity(identity, { conversationId: session?.id })
    if (!capsuleText && rotated.resumeCapsule) capsuleText = String(rotated.resumeCapsule)
    pendingResumeCapsule = capsuleText
    return {
      previous: outgoing,
      session,
      capsule,
      capsuleText,
      reasons,
      conversationChanged: rotated.conversationChanged === true,
      browserProfilePreserved: rotated.browserProfilePreserved === true,
    }
  }

  // ---------------------------------------------------------------------------
  // Worker lease lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Acquire a browser worker lease. Reuses the current lease when it is healthy
   * and within its recycle bounds; otherwise acquires a fresh one and advances
   * the worker epoch (invalidating every conversation bound to the old epoch).
   *
   * Returns `{ ok, lease, reused, workerEpoch }`. A missing `acquireWorker`
   * hook yields `{ ok: false, reason: "no-worker-provider" }` -- the manager
   * never invents a worker.
   */
  async function acquireWorkerLease() {
    if (closed) return { ok: false, reason: "manager-closed" }
    if (workerLease) {
      const health = await runHealthCheck(workerLease)
      const recycle = recycleDecision(health)
      if (recycle.recycle === false) {
        workerReuseCount += 1
        metrics.workerReuseCount += 1
        workerLastUsedAt = Number(now())
        return { ok: true, lease: workerLease, reused: true, workerEpoch: identity.workerEpoch }
      }
      // Recycle the existing lease: release it, bump the worker epoch.
      await releaseLease("recycle")
    }
    if (!acquireWorker) return { ok: false, reason: "no-worker-provider" }
    let lease = null
    try {
      lease = await acquireWorker()
    } catch (error) {
      return { ok: false, reason: `worker-acquire-failed:${String(error?.message || error).slice(0, 120)}` }
    }
    if (!lease) return { ok: false, reason: "worker-unavailable" }
    workerLease = lease
    workerAcquiredAt = Number(now())
    workerLastUsedAt = workerAcquiredAt
    workerReuseCount = 0
    workerAcquireCount += 1
    metrics.workerAcquireCount += 1
    // A NEW worker epoch. Every conversation tied to the previous epoch is now
    // invalid; the current conversation is cleared.
    identity = advanceWorkerEpoch(identity, { workerId: lease.workerId })
    conversationOpen = false
    return { ok: true, lease: workerLease, reused: false, workerEpoch: identity.workerEpoch }
  }

  /** Release the current worker lease. Idempotent and safe to call twice. */
  async function releaseLease(reason = "released") {
    const lease = workerLease
    workerLease = null
    if (!lease) return { released: false, reason: "no-lease" }
    workerRecycleCount += 1
    metrics.workerReleaseCount += 1
    if (reason === "recycle") metrics.workerRecycleCount += 1
    try {
      if (releaseWorker) await releaseWorker(lease)
      else if (typeof lease.close === "function") await lease.close()
    } catch {
      // A release failure must not strand the manager: the lease is already
      // forgotten, so the next acquire starts clean.
    }
    return { released: true, reason }
  }

  /** Explicitly release the worker lease (public API). */
  async function releaseWorkerLease(reason = "released") {
    return releaseLease(reason)
  }

  async function runHealthCheck(lease) {
    if (!healthCheckFn) return { ok: true, reason: null, unproven: true }
    try {
      const result = await healthCheckFn(lease)
      if (result && typeof result === "object") return result
      return { ok: result !== false, reason: null }
    } catch (error) {
      return { ok: false, reason: `health-check-failed:${String(error?.message || error).slice(0, 120)}` }
    }
  }

  function recycleDecision(health = {}) {
    if (health.ok === false) return { recycle: true, reason: health.reason || "unhealthy" }
    if (maxReuseCount > 0 && workerReuseCount >= maxReuseCount) return { recycle: true, reason: "max-reuse-count" }
    if (idleTtlMs > 0 && workerLastUsedAt && Number(now()) - workerLastUsedAt >= idleTtlMs) {
      return { recycle: true, reason: "idle-ttl" }
    }
    return { recycle: false, reason: null }
  }

  /** Cheap read-only health check of the current worker. Never submits a prompt. */
  async function healthCheck() {
    if (!workerLease) return { ok: false, reason: "no-worker-lease" }
    const health = await runHealthCheck(workerLease)
    return { ...health, workerEpoch: identity.workerEpoch, leaseAgeMs: workerAcquiredAt ? Number(now()) - workerAcquiredAt : null }
  }

  /** Recycle the current worker if any bound is exceeded. Idempotent. */
  async function recycleIfNeeded() {
    if (!workerLease) return { recycled: false, reason: "no-lease" }
    const health = await runHealthCheck(workerLease)
    const decision = recycleDecision(health)
    if (decision.recycle !== true) return { recycled: false, reason: null }
    await releaseLease("recycle")
    conversationOpen = false
    return { recycled: true, reason: decision.reason }
  }

  // ---------------------------------------------------------------------------
  // Conversation lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open a NEW conversation on the current worker epoch. Advances the
   * conversation epoch so any observer from a previous conversation is stale.
   */
  function openConversation(input = {}) {
    conversationOpen = true
    identity = openConversationIdentity(identity, { conversationId: input.conversationId || session?.id })
    metrics.conversationCreated += 1
    return {
      ok: true,
      conversationId: identity.conversationId,
      conversationEpoch: identity.conversationEpoch,
      workerEpoch: identity.workerEpoch,
      key: conversationReuseKey(identity),
    }
  }

  /**
   * Decide whether the CURRENT conversation may be reused for a continuation
   * (evidence follow-up / correction). Delegates the decision to the lifecycle
   * module; the manager only supplies its own health and policy.
   */
  async function reuseConversation(input = {}) {
    const health = input.health !== undefined ? input.health : await healthCheck()
    const decision = evaluateConversationReuse({
      conversation: {
        conversationId: identity.conversationId,
        workerId: identity.workerId,
        workerEpoch: identity.workerEpoch,
        profileEpoch: identity.profileEpoch,
        closed: !conversationOpen,
      },
      current: identity,
      health,
      policy: {
        allowContinuation: input.allowContinuation !== false,
        turnsRemaining: Math.max(0, Number(session?.turnBudget || 0) - turnsUsed),
      },
    })
    if (decision.reuse === true) metrics.conversationReused += 1
    else metrics.conversationInvalidated += 1
    return decision
  }

  /**
   * Close the current conversation. Detaches the observer, marks it closed and
   * clears per-conversation state. It does NOT release the worker lease: ending
   * a conversation must never kill a healthy reusable worker.
   */
  function closeConversation(reason = "conversation-complete") {
    const wasOpen = conversationOpen
    conversationOpen = false
    try {
      budgetModule.closeConversationSession(session, reason)
    } catch {
      // A close failure must not prevent the manager from reporting closed.
    }
    return { closed: wasOpen, reason, workerLeaseRetained: workerLease !== null }
  }

  // ---------------------------------------------------------------------------
  // Advisor run lifecycle
  // ---------------------------------------------------------------------------

  /** Begin an advisor run: a new run generation, WITHOUT touching worker epoch. */
  function beginAdvisorRun(input = {}) {
    identity = beginRunIdentity(identity, {
      advisorRunId: input.advisorRunId,
      workspaceGeneration: input.workspaceGeneration,
    })
    runActive = true
    runStartedAt = Number(now())
    return {
      ok: true,
      advisorRunId: identity.advisorRunId,
      runGeneration: identity.runGeneration,
      workspaceGeneration: identity.workspaceGeneration,
      workerEpoch: identity.workerEpoch,
    }
  }

  /** End the current advisor run. Does NOT release the worker or conversation. */
  function endAdvisorRun(reason = "run-complete") {
    const wasActive = runActive
    runActive = false
    return { ended: wasActive, reason, workerLeaseRetained: workerLease !== null, conversationRetained: conversationOpen }
  }

  /**
   * The stale-event gate for THIS manager's current identity. Every browser
   * event and late response must pass through it before it can influence state.
   * Discards are counted so Metrics can report `stale_event_discarded`.
   */
  function acceptEvent(event = {}, options = {}) {
    const verdict = classifyStaleness(event, identity, { runActive, ...options })
    if (verdict.stale === true) {
      metrics.staleEventDiscarded += 1
      if (verdict.reason === "generation-mismatch" || verdict.reason === "run-not-active") {
        metrics.lateResponseDiscarded += 1
      }
    }
    return verdict
  }

  /** True when a result carries the CURRENT conversation generation. */
  function isCurrentGeneration(result) {
    const gen = result?.generationId ?? result?.session?.generationId ?? null
    if (gen == null) return true
    return String(gen) === String(session?.generationId)
  }

  /** Note an abnormal worker termination so recovery/telemetry can see it. */
  function noteWorkerCrash(reason = "worker-crash") {
    metrics.workerCrashes += 1
    workerLease = null
    conversationOpen = false
    // A crash is a real epoch change: the next acquire bumps the worker epoch.
    return { noted: true, reason }
  }

  /** Note an explicit run abort. */
  function noteRunAbort(reason = "aborted") {
    metrics.runAborts += 1
    runActive = false
    return { noted: true, reason }
  }

  /**
   * Idempotent, bounded teardown of everything the manager owns: the run, the
   * conversation and the worker lease. Safe to call more than once.
   */
  async function shutdown(reason = "shutdown") {
    if (shutdownDone) return { shutdown: true, alreadyShutdown: true }
    shutdownDone = true
    closed = true
    runActive = false
    conversationOpen = false
    const released = await releaseLease(reason)
    return {
      shutdown: true,
      reason,
      workerReleased: released.released,
      metrics: { ...metrics },
    }
  }

  return {
    schemaVersion: ADVISOR_SESSION_MANAGER_SCHEMA_VERSION,
    policy: ADVISOR_SESSION_MANAGER_POLICY,
    implementation: ADVISOR_SESSION_MANAGER_IMPLEMENTATION,
    maySend,
    recordTurn,
    rotate,
    // worker lease lifecycle
    acquireWorker: acquireWorkerLease,
    releaseWorkerLease,
    healthCheck,
    recycleIfNeeded,
    // conversation lifecycle
    openConversation,
    reuseConversation,
    closeConversation,
    // run lifecycle
    beginAdvisorRun,
    endAdvisorRun,
    // stale-event gate
    acceptEvent,
    noteWorkerCrash,
    noteRunAbort,
    // teardown
    shutdown,
    /** Consume the pending resume capsule exactly once (for the next turn). */
    takeResumeCapsule() {
      const value = pendingResumeCapsule
      pendingResumeCapsule = ""
      return value || ""
    },
    hasPendingResumeCapsule() {
      return pendingResumeCapsule !== ""
    },
    isCurrentGeneration,
    session() {
      return session
    },
    identity() {
      return identity
    },
    workerLease() {
      return workerLease
    },
    isRunActive() {
      return runActive
    },
    close(reason = "task-complete") {
      if (closed) return false
      closed = true
      conversationOpen = false
      try {
        budgetModule.closeConversationSession(session, reason)
      } catch {
        // A close failure must not prevent the manager from reporting closed.
      }
      return true
    },
    state() {
      return {
        schemaVersion: ADVISOR_SESSION_MANAGER_SCHEMA_VERSION,
        policy: ADVISOR_SESSION_MANAGER_POLICY,
        implementation: ADVISOR_SESSION_MANAGER_IMPLEMENTATION,
        sessionId: session?.id || null,
        generationId: session?.generationId || null,
        turnsUsed,
        rotations,
        closed,
        hasPendingResumeCapsule: pendingResumeCapsule !== "",
        // lifecycle identity
        identity: { ...identity },
        runActive,
        conversationOpen,
        worker: {
          leased: workerLease !== null,
          acquireCount: workerAcquireCount,
          reuseCount: workerReuseCount,
          recycleCount: workerRecycleCount,
          ageMs: workerAcquiredAt ? Number(now()) - workerAcquiredAt : null,
          idleMs: workerLastUsedAt ? Number(now()) - workerLastUsedAt : null,
        },
        metrics: { ...metrics },
        telemetry: (() => {
          try {
            return budgetModule.sessionTelemetry(session)
          } catch {
            return null
          }
        })(),
      }
    },
  }
}
