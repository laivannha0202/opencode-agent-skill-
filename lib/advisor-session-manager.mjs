// V16.9 advisor session manager.
//
// WHY THIS MODULE EXISTS
//
// In V16.8 the advisor conversation lifecycle is spread across the controller:
// `deepSeekSession` is created inline, `recordDeepSeekTurn` mutates six counters
// on a plain object, rotation is detected mid-turn, and the resume capsule is
// built by a separate module. Four owners touch one session, so no single place
// can answer "is this advisor session healthy, current, and allowed to send?".
//
// This module is the single owner of the advisor session lifecycle. It does NOT
// re-implement the budget: `lib/deepseek-session-budget.mjs` owns creation,
// turn recording, rotation and telemetry, and `lib/deepseek-session-pool.mjs`
// owns concurrency leases. This module composes those primitives behind one
// stateful owner with the invariants the controller needs:
//
//   * ONE active conversation per lifecycle (single-writer);
//   * a turn gate that is the ONLY place "may I send?" is answered;
//   * rotation performed exactly once per trigger, with the resume capsule
//     produced at the same moment so a rotated session is never left without
//     its continuity artifact;
//   * an honest generation identity so a late response from a rotated-away
//     conversation can be recognised as stale.
//
// It owns NO evidence policy, NO escalation rule and NO authority.

import {
  closeConversationSession,
  createConversationSession,
  recordSessionTurn,
  rotateConversationSession,
  sessionTelemetry,
  shouldRotateSession,
} from "./deepseek-session-budget.mjs"

export const ADVISOR_SESSION_MANAGER_SCHEMA_VERSION = 1
export const ADVISOR_SESSION_MANAGER_POLICY = "advisor-session-manager-v16-9"

/**
 * Create the single advisor session owner.
 *
 * @param {object} options
 * @param {object} [options.sessionBudget] the proven session-budget module
 *        (injected so the manager never imports a second copy of the policy)
 * @param {string} [options.id] conversation id
 * @param {number} [options.turnBudget] ceiling on advisor turns
 * @param {string} [options.resumeCapsule] pending capsule text for the next turn
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
    // A capsule produced by the caller's builder wins; otherwise the rotated
    // session's own continuity text (if the budget module provided one) is used.
    if (!capsuleText && rotated.resumeCapsule) capsuleText = String(rotated.resumeCapsule)
    // The capsule is consumed exactly once by the NEXT turn.
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

  return {
    schemaVersion: ADVISOR_SESSION_MANAGER_SCHEMA_VERSION,
    policy: ADVISOR_SESSION_MANAGER_POLICY,
    maySend,
    recordTurn,
    rotate,
    /** Consume the pending resume capsule exactly once (for the next turn). */
    takeResumeCapsule() {
      const value = pendingResumeCapsule
      pendingResumeCapsule = ""
      return value || ""
    },
    hasPendingResumeCapsule() {
      return pendingResumeCapsule !== ""
    },
    /** True when a result carries the CURRENT conversation generation. */
    isCurrentGeneration(result) {
      const gen = result?.generationId ?? result?.session?.generationId ?? null
      if (gen == null) return true
      return String(gen) === String(session?.generationId)
    },
    session() {
      return session
    },
    close(reason = "task-complete") {
      if (closed) return false
      closed = true
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
        sessionId: session?.id || null,
        generationId: session?.generationId || null,
        turnsUsed,
        rotations,
        closed,
        hasPendingResumeCapsule: pendingResumeCapsule !== "",
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
