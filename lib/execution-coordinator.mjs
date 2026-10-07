// V16.9 execution coordinator.
//
// WHY THIS MODULE EXISTS
//
// V16.8 has a Decision Barrier that decides whether ADVICE may reach the
// executor. But the HANDOFF - "here is the verified advice, here is the
// workspace it was verified against, go write" - is assembled inline in the
// controller from four different owners: the barrier result, the capsule, the
// workspace fingerprint, and (implicitly) nothing at all on the WRITE side.
//
// The execution coordinator is the single owner of the HANDOFF. It composes,
// and does not re-implement, four proven pieces:
//
//   * `evaluateDecisionBarrier`     - may the advice reach the executor?
//   * `advisor-capsule` owner       - which capsule is CURRENT?
//   * `prewrite-fence`              - is the workspace still the one we verified?
//   * `workspace-state-owner`       - the shared before/after snapshots
//
// It produces ONE handoff record. The rule it enforces and the barrier alone
// cannot: advice is not merely "accepted" - it is accepted AND the workspace is
// still the workspace the advisor saw AND the intended write targets are inside
// the declared scope. The executor receives either a complete handoff or an
// explicit refusal with a stable reason; there is no partial handoff.

import {
  evaluateDecisionBarrier,
} from "./web-decision-barrier-v16-8.mjs"
import { createAdvisorCapsuleOwner } from "./advisor-capsule.mjs"
import { createPrewriteFence, PREWRITE_FENCE_POLICY, PREWRITE_FENCE_REASON, PREWRITE_FENCE_SCHEMA_VERSION } from "./prewrite-fence.mjs"
import { createWorkspaceStateOwner } from "./workspace-state-owner.mjs"

export const EXECUTION_COORDINATOR_SCHEMA_VERSION = 1
export const EXECUTION_COORDINATOR_POLICY = "execution-coordinator-v16-9"

export const HANDOFF_STATUS = Object.freeze({
  READY: "ready",
  REFUSED: "refused",
})

/**
 * Create the execution coordinator for one advisor lifecycle.
 *
 * @param {object} options
 * @param {string} [options.root] workspace root
 * @param {number} [options.capsuleMaxChars]
 */
export function createExecutionCoordinator(options = {}) {
  const owner = options.owner || createWorkspaceStateOwner({ root: options.root, now: options.now })
  const capsuleOwner = options.capsuleOwner || createAdvisorCapsuleOwner({ maxChars: options.capsuleMaxChars })
  const fence = options.fence || createPrewriteFence({ owner, now: options.now })
  let handoffs = 0
  let refusals = 0
  let lastHandoff = null

  /** Snapshot the workspace BEFORE the advisor runs. */
  function armBefore() {
    return fence.armBefore()
  }

  /**
   * Assemble the handoff from an accepted lane result.
   *
   * @param {object} input
   * @param {object} input.result              lane result (outcome advice-accepted)
   * @param {object} input.prep                local prep result (critical/optional)
   * @param {object} input.afterFingerprint    captureBarrierFingerprint(prep.root)
   * @param {number} input.consultGeneration
   * @param {number} input.activeGeneration
   * @param {string[]} [input.writeTargets]     paths the executor intends to write
   * @param {string[]} [input.allowedTargets]   declared scope
   */
  function coordinate(input = {}) {
    // When the V16.8 lane already evaluated the barrier, reuse its verdict: the
    // V16.9 coordinator must ADD the write-side fence, not re-run the same
    // barrier. Re-evaluating would be pure duplicated work with no benefit.
    const precomputedBarrier = input.precomputedBarrier || null
    const capsule = input.precomputedCapsule || capsuleOwner.build(input.result, input.prep || {}, { consultGeneration: input.consultGeneration })
    const capsuleReceipt = capsuleOwner.commit(capsule, { turn: input.turn })
    const barrier = precomputedBarrier || evaluateDecisionBarrier({
      result: input.result,
      consultGeneration: input.consultGeneration,
      activeGeneration: input.activeGeneration,
      beforeFingerprint: input.beforeFingerprint,
      afterFingerprint: input.afterFingerprint,
      capsule,
      workspaceRequired: input.workspaceRequired === true,
    })
    // Prefer the text the caller already rendered (the V16.8 lane renders it
    // once). Falling back to the owner's own render keeps the standalone path
    // correct without rendering twice on the strangler path.
    const rendered = barrier.passed && capsuleReceipt.accepted
      ? (typeof input.executorAdvice === "string" ? input.executorAdvice : capsuleOwner.current())
      : null

    const reasons = [...barrier.reasons]
    if (!capsuleReceipt.accepted && !reasons.includes(capsuleReceipt.reason)) reasons.push(capsuleReceipt.reason || "capsule-not-accepted")

    // The WRITE-side fence guards an actual WRITE. When the caller declares no
    // write target there is nothing to fence: the V16.8 barrier already proved
    // generation + workspace identity for the consult, and re-running a
    // mutation check here would only manufacture a `no-proof` refusal on a
    // read-only handoff (a real regression). The fence is therefore
    // NOT-APPLICABLE until a write target exists, and only then does it add
    // value the barrier does not have: per-target scope + generated-path
    // validation, and a mutation window that starts before the consult.
    const hasWriteTargets = Array.isArray(input.writeTargets) && input.writeTargets.length > 0
    let writeFence = null
    if (reasons.length === 0 && hasWriteTargets) {
      writeFence = fence.check({
        after: input.afterFingerprint,
        writeTargets: input.writeTargets,
        allowedTargets: input.allowedTargets,
        consultGeneration: input.consultGeneration,
        activeGeneration: input.activeGeneration,
        advisorAccepted: true,
      })
      if (!writeFence.allowed) reasons.push(writeFence.reasons[0] || PREWRITE_FENCE_REASON.NO_PROOF)
    } else if (reasons.length === 0) {
      writeFence = {
        schemaVersion: PREWRITE_FENCE_SCHEMA_VERSION,
        kind: "ues-v16-9-prewrite-fence",
        policy: PREWRITE_FENCE_POLICY,
        allowed: true,
        reasons: [],
        status: "not-applicable",
        acceptedTargets: [],
        rejectedTargets: [],
        beforeFingerprint: null,
        afterFingerprint: null,
        mutation: { comparable: false, mutated: null, reason: "no-write-target" },
      }
    }

    const ready = reasons.length === 0 && typeof rendered === "string"
    if (ready) handoffs += 1
    else refusals += 1
    const handoff = {
      schemaVersion: EXECUTION_COORDINATOR_SCHEMA_VERSION,
      kind: "ues-v16-9-execution-handoff",
      policy: EXECUTION_COORDINATOR_POLICY,
      status: ready ? HANDOFF_STATUS.READY : HANDOFF_STATUS.REFUSED,
      reasons,
      // The ONLY text the executor may act on. Null on refusal.
      executorAdvice: ready ? rendered : null,
      capsuleReceipt,
      decisionBarrier: barrier,
      writeFence,
      // A handoff NEVER grants the advisor authority: it is a routing artifact.
      mayProducePass: false,
      mayGrantPermissions: false,
      isToolInvocation: false,
    }
    lastHandoff = handoff
    return handoff
  }

  return {
    schemaVersion: EXECUTION_COORDINATOR_SCHEMA_VERSION,
    policy: EXECUTION_COORDINATOR_POLICY,
    owner,
    capsuleOwner,
    fence,
    armBefore,
    coordinate,
    currentAdvice() {
      return capsuleOwner.current()
    },
    state() {
      return {
        schemaVersion: EXECUTION_COORDINATOR_SCHEMA_VERSION,
        policy: EXECUTION_COORDINATOR_POLICY,
        handoffs,
        refusals,
        lastHandoff,
        capsule: capsuleOwner.state(),
        fence: fence.state(),
        workspace: owner.state(),
      }
    },
  }
}
