// V16.9 production wrapper: stateful advisor + evidence broker + adaptive
// admission, layered over the proven V16.8 lane.
//
// WHY A WRAPPER (strangler, not a rewrite)
//
// V16.8 owns escalation, packet budgets, provider trust, local advice
// verification, deadline cancellation and the generation/workspace Decision
// Barrier. None of that is re-implemented here. V16.9 ADDS a lifecycle layer on
// top and delegates every existing decision to its owner:
//
//   * ADMISSION (new): `advisor-admission` decides whether to consult AT ALL,
//     before a browser session or a token is spent. This is the only behavioural
//     addition on the hot path, and it is measurable: a PI_ONLY/LOCAL route never
//     starts the provider.
//   * SEQUENCING (new): `advisor-dialogue-coordinator` owns the single-flight
//     turn invariant so no second advisor turn can run concurrently.
//   * HANDOFF (new): `execution-coordinator` adds the WRITE-side pre-write fence
//     (the workspace must be unchanged from the consult window through to the
//     handoff) and keeps ONE current dialogue-aware capsule.
//
// `advisor-session-manager` and `advisor-answer-observer` were built and tested
// but are deliberately NOT wired here: the adapter's own poll loop already owns
// answer stability/read-failure recovery and the controller already owns the
// conversation lifecycle inline. Wrapping them would create a SECOND owner for
// behaviour that is already correct, with no measured benefit - which the
// release directive forbids. They are reported, not wired.
//
// Everything else is `web-reasoning-lane-v16-8.mjs` unchanged. `createWebReasoningLane`
// here returns the SAME shape as V16.8 plus a `v16_9` receipt, so existing
// callers keep working.
//
// The V16.9 rules are enforced by construction:
//   - DeepSeek Web never runs a tool (it ASKS via the evidence broker).
//   - Pi is the sole executor; admission only ROUTES, it never grants authority.
//   - No source mutation before the Decision Barrier AND the Pre-write Fence pass.

import {
  createWebReasoningLane as createV16_8WebReasoningLane,
  WEB_LANE_OUTCOME,
} from "./web-reasoning-lane-v16-8.mjs"
import { WEB_REASONING_UNAVAILABLE } from "./web-reasoning-provider.mjs"
import {
  ADMISSION_ROUTE,
  decideAdmission,
} from "./advisor-admission.mjs"
import { createAdvisorDialogueCoordinator } from "./advisor-dialogue-coordinator.mjs"
import { createAdvisorCapsuleOwner } from "./advisor-capsule.mjs"
import { createExecutionCoordinator, HANDOFF_STATUS } from "./execution-coordinator.mjs"
import { createPrewriteFence } from "./prewrite-fence.mjs"
import { createWorkspaceStateOwner } from "./workspace-state-owner.mjs"

export * from "./web-reasoning-lane-v16-8.mjs"

export const V16_9_LANE_POLICY = "web-reasoning-lane-v16-9"

// A route that must not start a provider session.
const NON_CONSULTING_ROUTES = new Set([ADMISSION_ROUTE.LOCAL_DETERMINISTIC, ADMISSION_ROUTE.PI_ONLY])

/**
 * The canonical "no consultation happened" result.
 *
 * EQUIVALENCE: when the escalation router itself declined (no-signal / mode-off),
 * this MUST reproduce the base lane's skip shape byte-for-byte in the fields the
 * controller reads: `outcome: "skipped"`, the ESCALATION reason
 * (`task-already-well-grounded` / `web-reasoning-disabled`), the `decision`
 * object, and NO `fallbackToLocal`. The controller's `webLaneOutcomeSkipped()`
 * gates advisor injection on `outcome === "skipped"`, so a `fallback-local` here
 * would silently change production behaviour.
 *
 * The only genuinely NEW case is a V16.9 de-escalation (escalation fired, history
 * vetoed it): there `admission.escalation.escalate === true`, so we report the
 * admission reason instead of the escalation reason, still as a `skipped` result.
 */
function skippedLaneResult(base, admission) {
  const escalation = admission?.escalation || null
  const escalationDeclined = escalation ? escalation.escalate !== true : false
  const reason = escalation && escalationDeclined ? escalation.reason : admission.reason
  // EQUIVALENCE: the base lane bumps `webReasoningSkipped` on every skip and
  // returns `telemetry: telemetry.snapshot()`. The controller journals these
  // counters, so a skip that does not bump them would under-report. This is a
  // genuine skip in BOTH cases (escalation declined, or history de-escalated).
  try { base.telemetry?.bump?.("webReasoningSkipped") } catch { /* telemetry is best-effort */ }
  return {
    schemaVersion: 1,
    kind: "ues-web-reasoning-lane",
    mode: base.mode,
    provider: base.providerId,
    live: false,
    outcome: WEB_LANE_OUTCOME.SKIPPED,
    reason,
    // The escalation decision the base lane would have reported. A caller that
    // reads `.decision` keeps working unchanged.
    decision: escalation,
    consulted: false,
    advisorText: null,
    telemetry: base.telemetry?.snapshot?.() || null,
    admission,
  }
}

/**
 * Production V16.9 web lane.
 *
 * @param {object} options same options as the V16.8 lane, plus:
 * @param {object} [options.admissionInput] default measured/declared inputs for
 *        the adaptive admission decision
 * @param {boolean} [options.adaptiveAdmission] set false to consult whenever the
 *        base lane would (bypasses the new admission pre-gate)
 */
export function createWebReasoningLane(options = {}) {
  const base = createV16_8WebReasoningLane(options)
  const adaptiveAdmission = options.adaptiveAdmission !== false
  const dialogue = createAdvisorDialogueCoordinator({
    maxFollowUps: Number(options.maxFollowUps ?? 1),
    submitBudget: options.submitBudget,
  })
  const workspaceOwner = createWorkspaceStateOwner({ root: options.workspaceRoot, now: options.now })
  const capsuleOwner = createAdvisorCapsuleOwner({ maxChars: options.capsuleMaxChars })
  const fence = createPrewriteFence({ owner: workspaceOwner, now: options.now })
  const coordinator = createExecutionCoordinator({
    owner: workspaceOwner,
    capsuleOwner,
    fence,
    capsuleMaxChars: options.capsuleMaxChars,
  })
  let admissions = 0
  let admissionSkips = 0
  let handoffsReady = 0
  let handoffsRefused = 0
  let lastAdmission = null
  let lastHandoff = null

  /**
   * Run the adaptive admission pre-gate. Returns the admission decision, or a
   * "consult" decision when adaptive admission is disabled or the caller already
   * supplied one.
   */
  function admit(kind, input) {
    if (input.admission) return input.admission
    if (!adaptiveAdmission) {
      return decideAdmission({ ...input, mode: "force" })
    }
    admissions += 1
    // The admission pre-gate reads the SAME untrusted task/notes surface the
    // escalation router normalizes. A getter that throws while being read is an
    // ESCALATION failure, not a provider failure: it must be tagged and
    // re-thrown with the closed vocabulary, never swallowed into a local run.
    // (V16.7.1 contract: an escalation throw is tagged and classified.)
    let decision
    try {
      decision = decideAdmission({
        ...(options.admissionInput || {}),
        ...input,
        mode: input.mode || base.mode,
      })
    } catch (error) {
      const tagged = /** @type {any} */ (new Error("web-reasoning escalation failed"))
      tagged.name = "WebEscalationError"
      tagged.uesConsultationReason = "escalation-error"
      tagged.cause = error
      throw tagged
    }
    lastAdmission = decision
    return decision
  }

  async function runConsult(kind, input, invoke) {
    const admission = admit(kind, input)
    const mode = input.mode || base.mode

    // A non-consulting route (or an explicit operator "do not consult") skips
    // the provider entirely. FORCE never lands here: `decideAdmission` always
    // routes FORCE to PI_PLUS_ADVISOR.
    if (NON_CONSULTING_ROUTES.has(admission.route) && mode !== "force") {
      admissionSkips += 1
      const result = skippedLaneResult(base, admission)
      return { ...result, v16_9: { admission, consulted: false } }
    }

    // Single-flight invariant: reserve the turn slot. A concurrent advisor turn
    // is REFUSED, never queued.
    const turn = dialogue.beginTurn(kind)
    if (!turn.ok) {
      return { ...skippedLaneResult(base, admission), reason: turn.reason, v16_9: { admission, consulted: false, refusedConcurrent: true } }
    }

    // Arm the write-side fence BEFORE the advisor runs. This snapshot is the
    // "before" the fence compares against at handoff, covering the WHOLE window
    // (provider call, local prep, evidence loop) - not only the barrier window.
    const before = fence.armBefore()
    let result
    try {
      result = await invoke(input)
    } finally {
      dialogue.endTurn(turn.token)
    }
    if (kind === "consult") dialogue.noteConsultDispatched(result?.packet ? { fingerprint: result.packet.fingerprint } : null)
    else dialogue.noteFollowUpDispatched(result?.packet ? { fingerprint: result.packet.fingerprint } : null)

    const v16_8 = result?.v16_8 || null

    // Only an ADVICE-ACCEPTED result reaches the write-side handoff. A skipped/
    // fallback/unavailable result already has no advisorText; its admission and
    // dialogue state are still reported.
    if (result?.outcome !== WEB_LANE_OUTCOME.ADVISED) {
      return { ...result, v16_9: { admission, consulted: result?.consulted === true, handoff: null } }
    }

    // Reuse the V16.8 barrier verdict and capsule; ADD the write-side fence and
    // the dialogue-aware capsule bookkeeping.
    const handoff = coordinator.coordinate({
      result,
      prep: v16_8?.localPrep ? { critical: { fileRows: [] } } : {},
      beforeFingerprint: before,
      afterFingerprint: v16_8?.localPrep?.workspaceFingerprintAfter
        ? { available: true, fingerprint: v16_8.localPrep.workspaceFingerprintAfter, changedFiles: [] }
        : null,
      consultGeneration: v16_8?.consultGeneration,
      activeGeneration: v16_8?.activeGeneration,
      precomputedBarrier: result.decisionBarrier,
      precomputedCapsule: result.advisorCapsuleV16_8,
      executorAdvice: result.advisorText,
      writeTargets: input.writeTargets,
      allowedTargets: input.allowedTargets,
      turn: kind,
    })
    lastHandoff = handoff
    if (handoff.status === HANDOFF_STATUS.READY) handoffsReady += 1
    else {
      handoffsRefused += 1
      // The barrier passed but the WRITE-side fence refused: the workspace moved
      // between the barrier and the handoff. Downgrade to a local fallback and
      // drop the advice, exactly like a barrier rejection.
      const forced = base.mode === "force"
      return {
        ...result,
        outcome: forced ? WEB_LANE_OUTCOME.UNAVAILABLE : WEB_LANE_OUTCOME.FALLBACK,
        reason: handoff.reasons[0] || "prewrite-fence-rejected",
        code: forced ? WEB_REASONING_UNAVAILABLE : null,
        fallbackToLocal: !forced,
        advisorText: null,
        v16_9: { admission, consulted: true, handoff },
      }
    }

    return {
      ...result,
      advisorText: handoff.executorAdvice,
      v16_9: { admission, consulted: true, handoff },
    }
  }

  return {
    ...base,
    schemaVersion: base.schemaVersion,
    mode: base.mode,
    providerId: base.providerId,
    maxConsultations: base.maxConsultations,
    maxFollowUps: base.maxFollowUps,
    followUpAllowance: base.followUpAllowance,
    telemetry: base.telemetry,
    policy: V16_9_LANE_POLICY,
    async consult(input = {}) {
      return runConsult("consult", input, (next) => base.consult(next))
    },
    async followUp(input = {}) {
      return runConsult("follow-up", input, (next) => base.followUp(next))
    },
    state() {
      return {
        ...base.state(),
        v16_9: {
          policy: V16_9_LANE_POLICY,
          admissions,
          admissionSkips,
          handoffsReady,
          handoffsRefused,
          lastAdmission,
          lastHandoff,
          dialogue: dialogue.state(),
          capsule: capsuleOwner.state(),
          fence: fence.state(),
        },
      }
    },
    snapshot() {
      return {
        ...base.snapshot(),
        v16_9: {
          policy: V16_9_LANE_POLICY,
          admissions,
          admissionSkips,
          handoffsReady,
          handoffsRefused,
          lastAdmission,
          lastHandoff,
        },
      }
    },
  }
}
