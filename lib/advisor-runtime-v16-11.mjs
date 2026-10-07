// V16.11 advisor runtime: the single production composition.
//
// WHY THIS MODULE EXISTS
//
// V16.11 introduces a lifecycle identity module, a transport protocol, an event
// bridge, a recovery coordinator, a latency-metrics aggregator and a Windows
// hygiene prover. Individually correct, but the release directive's hardest law
// is NO DUAL OWNERSHIP: exactly one object must own the advisor lifecycle for a
// run, or the same behaviour is implemented twice and drifts.
//
// This module is that ONE owner. `createAdvisorRuntime()` builds ONE
// `advisor-session-manager` (the canonical lifecycle owner) and wires the event
// bridge, the recovery coordinator and the latency metrics INTO it. It exposes a
// small, explicit surface the controller calls:
//
//   * `beginConsult()`  -- reserve a turn, open/refresh the conversation, begin a
//     run generation and return the identity a submit must carry.
//   * `observeEvent()`  -- feed a decoded transport event to the bridge, gate it
//     against the current epoch, and report whether it was accepted.
//   * `pollOnce()`      -- the bounded fallback read.
//   * `onFailure()`     -- classify a failure and get a recovery plan.
//   * `completeConsult()` -- record the turn, emit an honest latency sample.
//   * `shutdown()`      -- tear down everything, provably.
//
// It owns NO transport and NO browser: the caller injects `acquireWorker` /
// `releaseWorker` / `healthCheck` / `readObservation`. It owns NO provider
// policy: the caller injects the answer parser. This keeps the composition
// deterministically testable with doubles and keeps the browser in ues.ts.

import { createAdvisorSessionManager, ADVISOR_SESSION_MANAGER_POLICY } from "./advisor-session-manager.mjs"
import { createAdvisorEventBridge, OBSERVATION_CHANNEL } from "./advisor-event-bridge-v16-11.mjs"
import { RECOVERY_ACTION, createSubmitGuard, planRecovery } from "./advisor-recovery-v16-11.mjs"
import { LATENCY_CHANNEL, LATENCY_PROVENANCE, aggregateLatencyMetrics, buildLatencySample } from "./advisor-latency-metrics-v16-11.mjs"

export const ADVISOR_RUNTIME_SCHEMA_VERSION = 1
export const ADVISOR_RUNTIME_POLICY = "advisor-runtime-v16-11"

// Map an observation channel to a latency channel (they are the same vocabulary
// but this keeps the two modules decoupled if either evolves).
const CHANNEL_TO_LATENCY = Object.freeze({
  [OBSERVATION_CHANNEL.EVENT]: LATENCY_CHANNEL.EVENT,
  [OBSERVATION_CHANNEL.POLL]: LATENCY_CHANNEL.POLL,
  [OBSERVATION_CHANNEL.EVENT_THEN_POLL]: LATENCY_CHANNEL.EVENT_THEN_POLL,
  [OBSERVATION_CHANNEL.NONE]: LATENCY_CHANNEL.NONE,
})

/**
 * Create the single per-run advisor runtime.
 *
 * @param {object} options
 * @param {string} options.runId
 * @param {string} [options.workspaceRoot]
 * @param {number} [options.turnBudget]
 * @param {boolean} [options.eventChannel] whether the worker advertises events
 * @param {Function} [options.acquireWorker]
 * @param {Function} [options.releaseWorker]
 * @param {Function} [options.healthCheck]
 * @param {Function} [options.parseAnswer]
 * @param {Function} [options.now]
 * @param {string} [options.latencyProvenance] MEASURED | SIMULATED
 */
export function createAdvisorRuntime(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const parseAnswer = typeof options.parseAnswer === "function" ? options.parseAnswer : (text) => ({ ok: false, error: "no-parser", text })
  const latencyProvenance = Object.values(LATENCY_PROVENANCE).includes(options.latencyProvenance)
    ? options.latencyProvenance
    : LATENCY_PROVENANCE.MEASURED

  const manager = createAdvisorSessionManager({
    id: options.runId,
    taskFingerprint: options.taskFingerprint,
    turnBudget: options.turnBudget,
    maxReuseCount: options.maxReuseCount,
    idleTtlMs: options.idleTtlMs,
    acquireWorker: options.acquireWorker,
    releaseWorker: options.releaseWorker,
    healthCheck: options.healthCheck,
    now,
  })
  const submitGuard = createSubmitGuard()
  const latencySamples = []
  const attempts = { total: 0, byKind: {} }
  let workerState = "cold" // the FIRST consult of a fresh worker is cold
  let consultCount = 0
  let lastSample = null

  /**
   * Begin a consult. Reserves a turn, ensures a worker lease, opens/reuses the
   * conversation and begins a run generation. Returns the identity the caller
   * must stamp on the submit.
   */
  async function beginConsult(input = {}) {
    const gate = manager.maySend("consult")
    if (!gate.allowed) return { ok: false, reason: gate.reason }

    const acquire = await manager.acquireWorker()
    if (acquire.ok !== true) return { ok: false, reason: acquire.reason }
    const cold = acquire.reused !== true
    workerState = cold ? "cold" : "warm"

    // Reuse a healthy conversation on the same worker epoch; otherwise open one.
    const reuse = await manager.reuseConversation({ allowContinuation: input.allowContinuation !== false })
    if (reuse.reuse !== true) manager.openConversation()
    const run = manager.beginAdvisorRun({ advisorRunId: input.advisorRunId, workspaceGeneration: input.workspaceGeneration })
    const identity = manager.identity()

    // The bridge is per-consult: it observes ONE answer against ONE baseline.
    const bridge = createAdvisorEventBridge({
      baseline: input.baseline || null,
      eventChannel: options.eventChannel === true,
      eventSilenceMs: options.eventSilenceMs,
      pollIntervalMs: options.pollIntervalMs,
      maxPolls: options.maxPolls,
      now,
      readObservation: options.readObservation,
      parseAnswer,
    })

    const claim = submitGuard.claim({ promptId: input.promptId, identity })
    consultCount += 1
    return {
      ok: true,
      identity,
      promptId: input.promptId,
      runGeneration: run.runGeneration,
      workerEpoch: identity.workerEpoch,
      conversationId: identity.conversationId,
      conversationEpoch: identity.conversationEpoch,
      workerState,
      cold,
      reusedConversation: reuse.reuse === true,
      submitAllowed: claim.allowed,
      submitReason: claim.reason,
      submitKey: claim.key,
      bridge,
      startedAt: Number(now()),
    }
  }

  /**
   * Re-claim the right to submit an EXISTING consult. A recovery calls this
   * before re-submitting: a consult whose claim is already in-flight or already
   * completed is refused, so a recovery loop can never double-submit. A genuine
   * retry (after `onFailure` released the claim) is allowed.
   */
  function claimSubmit(consult) {
    if (!consult?.ok) return { allowed: false, reason: "no-active-consult", key: null }
    return submitGuard.claim({ promptId: consult.promptId, identity: consult.identity })
  }

  /** Mark a consult's submit as completed (idempotency receipt). */
  function completeSubmit(consult) {
    if (!consult?.ok) return { completed: false }
    return submitGuard.complete({ promptId: consult.promptId, identity: consult.identity })
  }

  /**
   * Feed ONE decoded transport event. It is FIRST gated against the current
   * lifecycle identity, so a stale event can never reach the bridge.
   */
  function observeEvent(consult, decodedEvent) {
    if (!consult?.ok || !consult.bridge) return { handled: false, reason: "no-active-consult" }
    const owned = manager.acceptEvent(decodedEvent, { requireGeneration: false })
    if (owned.stale === true) {
      return { handled: false, stale: true, reason: owned.reason }
    }
    const result = consult.bridge.onEvent(decodedEvent)
    if (result.done === true && !result.recovery) manager.noteRunAbort("event-answer")
    return result
  }

  /** Run ONE bounded poll tick of the active consult's bridge. */
  async function pollOnce(consult) {
    if (!consult?.ok || !consult.bridge) return { done: false, reason: "no-active-consult" }
    return consult.bridge.pollOnce()
  }

  /**
   * Complete a consult with the accepted answer. Records the turn, emits an
   * honest latency sample and marks the submit guard complete.
   */
  function completeConsult(consult, input = {}) {
    if (!consult?.ok) return { recorded: false, reason: "no-active-consult" }
    const bridgeState = consult.bridge.state()
    const accepted = consult.bridge.accepted()
    const totalMs = input.totalMs != null ? Number(input.totalMs) : Number(now()) - consult.startedAt
    manager.recordTurn("consult", { advisorText: accepted?.text || input.advisorText || "" })
    manager.endAdvisorRun("consult-complete")
    submitGuard.complete({ promptId: consult.promptId, identity: consult.identity })
    const sample = buildLatencySample({
      workerState: consult.workerState,
      channel: CHANNEL_TO_LATENCY[bridgeState.answerChannel] || LATENCY_CHANNEL.NONE,
      totalMs,
      acquireMs: consult.acquireMs,
      observeMs: input.observeMs,
      recoveryMs: input.recoveryMs,
      answerChars: accepted?.text ? accepted.text.length : null,
      polls: bridgeState.polls,
      events: bridgeState.eventsSeen,
      provenance: latencyProvenance,
    })
    latencySamples.push(sample)
    lastSample = sample
    return { recorded: true, sample, accepted: accepted || null }
  }

  /**
   * Classify a failure and return a recovery plan, advancing the attempt budget
   * ONLY when the plan says to recover. A refused recovery is fail-closed.
   */
  async function onFailure(consult, failure = {}) {
    const plan = planRecovery({
      event: failure.event,
      reason: failure.reason,
      failureKind: failure.failureKind,
      attempts,
      duplicateSubmitSuspected: failure.duplicateSubmitSuspected,
      authAvailable: failure.authAvailable,
      canReopenConversation: failure.canReopenConversation,
      lateEvent: failure.lateEvent,
      current: manager.identity(),
    })
    if (plan.recover !== true) return plan

    attempts.total += 1
    attempts.byKind[plan.failureKind] = (attempts.byKind[plan.failureKind] || 0) + 1

    // Apply the recovery action to the lifecycle owner.
    if (plan.action === RECOVERY_ACTION.RECYCLE_WORKER) {
      await manager.releaseWorkerLease("recovery-recycle")
      manager.noteWorkerCrash(plan.failureKind)
    } else if (plan.action === RECOVERY_ACTION.REOPEN_CONVERSATION) {
      manager.closeConversation("recovery-reopen")
    } else if (plan.action === RECOVERY_ACTION.REAUTH) {
      // Auth recovery preserves the conversation; the caller runs the reauth.
      manager.noteRunAbort("recovery-reauth")
    }
    // A recovered failure releases the in-flight submit claim so the retry can
    // legitimately re-submit on the (possibly fresh) identity.
    if (consult?.ok) submitGuard.release({ promptId: consult.promptId, identity: consult.identity })
    return plan
  }

  /** Aggregate the latency samples collected this run. */
  function metrics() {
    return aggregateLatencyMetrics(latencySamples)
  }

  async function shutdown(reason = "run-complete") {
    return manager.shutdown(reason)
  }

  return {
    schemaVersion: ADVISOR_RUNTIME_SCHEMA_VERSION,
    policy: ADVISOR_RUNTIME_POLICY,
    sessionManagerPolicy: ADVISOR_SESSION_MANAGER_POLICY,
    beginConsult,
    claimSubmit,
    completeSubmit,
    observeEvent,
    pollOnce,
    completeConsult,
    onFailure,
    metrics,
    shutdown,
    manager: () => manager,
    lastSample: () => lastSample,
    state() {
      return {
        schemaVersion: ADVISOR_RUNTIME_SCHEMA_VERSION,
        policy: ADVISOR_RUNTIME_POLICY,
        runId: options.runId || null,
        consultCount,
        workerState,
        attempts: { ...attempts, byKind: { ...attempts.byKind } },
        submitGuard: submitGuard.state(),
        latency: aggregateLatencyMetrics(latencySamples),
        session: manager.state(),
      }
    },
  }
}

export const advisorRuntimeExports = Object.freeze({
  ADVISOR_RUNTIME_SCHEMA_VERSION,
  ADVISOR_RUNTIME_POLICY,
  createAdvisorRuntime,
})
