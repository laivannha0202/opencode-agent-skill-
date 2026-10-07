// V16.11 advisor lifecycle identity: epochs, ownership and the stale-event gate.
//
// WHY THIS MODULE EXISTS
//
// V16.9/V16.10 track a conversation by a bare string id. A late browser event
// or a late provider response therefore has no way to prove WHICH worker, WHICH
// profile epoch and WHICH advisor run produced it. When a warm browser worker is
// recycled -- or the authenticated profile is reinitialised -- a conversation id
// that "still exists" can silently refer to a dead epoch, and a stale answer can
// be applied to a newer generation.
//
// This module is the SINGLE owner of the lifecycle identity and the stale-event
// decision. It is pure and transport-agnostic: it never opens a socket, spawns a
// process, reads the DOM or talks to a provider. Callers hand it an event and the
// CURRENT identity, and it answers one question: is this event owned by the
// current lifecycle, or must it be discarded?
//
// Three lifecycle concepts are kept DISTINCT (V16.11 directive section 5):
//
//   * BrowserWorker     -- workerId + workerEpoch + profileEpoch
//   * DeepSeekConversation -- conversationId + conversationEpoch (tied to worker epoch)
//   * AdvisorRun        -- advisorRunId + runGeneration + workspaceGeneration
//
// Recycling the worker (workerEpoch++) invalidates every conversation bound to
// the OLD epoch, without touching the run's own generation. A late event whose
// workerEpoch does not match the current one is discarded, never applied.
//
// It owns NO dialogue policy, NO budget, NO evidence and NO authority.

export const ADVISOR_LIFECYCLE_SCHEMA_VERSION = 1
export const ADVISOR_LIFECYCLE_POLICY = "advisor-lifecycle-v16-11"

// A monotonic, non-secret epoch/identity generator. `now` and a sequence are the
// only inputs, so a lifecycle id is deterministic under an injected clock.
let IDENTITY_SEQUENCE = 0

function boundedEpoch(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.trunc(parsed))
}

function normalizeId(value) {
  const raw = value === undefined || value === null ? "" : String(value)
  return raw.slice(0, 200)
}

/**
 * Build a fresh lifecycle identity.
 *
 * Every field is explicit. A caller may adopt a subset (e.g. reuse the
 * conversation id) but a field it does not supply is generated, never inferred
 * from a global.
 */
export function createLifecycleIdentity(input = {}) {
  IDENTITY_SEQUENCE += 1
  const now = typeof input.now === "function" ? Number(input.now()) : Date.now()
  const base = Number.isFinite(now) ? now.toString(36) : "0"
  const seq = IDENTITY_SEQUENCE.toString(36)
  return Object.freeze({
    schemaVersion: ADVISOR_LIFECYCLE_SCHEMA_VERSION,
    policy: ADVISOR_LIFECYCLE_POLICY,
    workerId: normalizeId(input.workerId) || `wkr-${base}-${seq}`,
    workerEpoch: boundedEpoch(input.workerEpoch),
    profileEpoch: boundedEpoch(input.profileEpoch),
    conversationId: normalizeId(input.conversationId) || null,
    conversationEpoch: boundedEpoch(input.conversationEpoch),
    advisorRunId: normalizeId(input.advisorRunId) || `run-${base}-${seq}`,
    runGeneration: boundedEpoch(input.runGeneration),
    workspaceGeneration: boundedEpoch(input.workspaceGeneration),
  })
}

/**
 * Advance the WORKER epoch: a new worker replaces the old one.
 *
 * This bumps `workerEpoch` and -- crucially -- `conversationEpoch`, and clears
 * `conversationId`. A conversation tied to the previous worker epoch can never
 * satisfy `evaluateConversationReuse` afterwards. The run generation is NOT
 * touched: recycling a worker must not reset the advisor run's own staleness.
 */
export function advanceWorkerEpoch(identity = {}, input = {}) {
  const next = createLifecycleIdentity({
    ...identity,
    workerId: input.workerId || identity.workerId,
    workerEpoch: boundedEpoch(identity.workerEpoch) + 1,
    profileEpoch: input.profileEpoch === undefined ? identity.profileEpoch : input.profileEpoch,
    conversationId: null,
    conversationEpoch: boundedEpoch(identity.conversationEpoch) + 1,
    advisorRunId: identity.advisorRunId,
    runGeneration: identity.runGeneration,
    workspaceGeneration: identity.workspaceGeneration,
  })
  return next
}

/**
 * Advance the PROFILE epoch: the authenticated profile context was replaced.
 *
 * Kept separate from the worker epoch because a profile can be reinitialised
 * while the same worker process survives. A conversation is invalid if its
 * stored profileEpoch differs from the current one.
 */
export function advanceProfileEpoch(identity = {}) {
  return createLifecycleIdentity({
    ...identity,
    profileEpoch: boundedEpoch(identity.profileEpoch) + 1,
    conversationId: null,
    conversationEpoch: boundedEpoch(identity.conversationEpoch) + 1,
  })
}

/**
 * Begin a new advisor run against the current identity.
 *
 * The run gets its own generation and, importantly, does NOT reset worker or
 * profile epochs -- a new run on a warm worker keeps the same conversation
 * lineage unless the caller explicitly opens a new conversation.
 */
export function beginAdvisorRun(identity = {}, input = {}) {
  return createLifecycleIdentity({
    ...identity,
    advisorRunId: normalizeId(input.advisorRunId) || identity.advisorRunId,
    runGeneration: boundedEpoch(identity.runGeneration) + 1,
    workspaceGeneration: input.workspaceGeneration === undefined
      ? boundedEpoch(identity.workspaceGeneration)
      : boundedEpoch(input.workspaceGeneration),
  })
}

/**
 * Open (or adopt) a conversation on the current worker epoch.
 *
 * A conversation opened here is bound to the CURRENT workerEpoch and
 * profileEpoch. `conversationEpoch` advances so any observer/lease from a
 * previous conversation on the same worker is invalidated.
 */
export function openConversation(identity = {}, input = {}) {
  return createLifecycleIdentity({
    ...identity,
    conversationId: normalizeId(input.conversationId) || `conv-${boundedEpoch(identity.workerEpoch)}-${boundedEpoch(identity.conversationEpoch) + 1}`,
    conversationEpoch: boundedEpoch(identity.conversationEpoch) + 1,
  })
}

/** The four-field logical key that proves a conversation belongs to an epoch. */
export function conversationReuseKey(identity = {}) {
  return {
    conversationId: normalizeId(identity.conversationId) || null,
    workerId: normalizeId(identity.workerId) || null,
    workerEpoch: boundedEpoch(identity.workerEpoch),
    profileEpoch: boundedEpoch(identity.profileEpoch),
  }
}

function keysEqual(a = {}, b = {}) {
  return (
    a.conversationId === b.conversationId &&
    a.workerId === b.workerId &&
    a.workerEpoch === b.workerEpoch &&
    a.profileEpoch === b.profileEpoch
  )
}

/**
 * Decide whether a stored conversation may be REUSED for the current identity.
 *
 * A conversation id alone is NEVER sufficient. Reuse requires:
 *   - the conversation is not closed;
 *   - the stored worker/profile epochs match the current identity;
 *   - the conversation is healthy (or the caller waived the health requirement
 *     by passing `health: { ok: true }`);
 *   - the caller's policy allows continuation (turn budget, workspace policy).
 *
 * Fail-closed: any missing proof returns `{ reuse: false, reason }`.
 */
export function evaluateConversationReuse(input = {}) {
  const conversation = input.conversation || {}
  const current = input.current || {}
  const health = input.health || null
  const policy = input.policy || {}
  const storedKey = {
    conversationId: normalizeId(conversation.conversationId) || null,
    workerId: normalizeId(conversation.workerId) || null,
    workerEpoch: boundedEpoch(conversation.workerEpoch),
    profileEpoch: boundedEpoch(conversation.profileEpoch),
  }
  const currentKey = conversationReuseKey(current)
  if (!storedKey.conversationId) return { reuse: false, reason: "no-conversation" }
  if (conversation.closed === true) return { reuse: false, reason: "conversation-closed" }
  if (storedKey.workerEpoch !== currentKey.workerEpoch) return { reuse: false, reason: "worker-epoch-changed" }
  if (storedKey.profileEpoch !== currentKey.profileEpoch) return { reuse: false, reason: "profile-epoch-changed" }
  if (storedKey.workerId && currentKey.workerId && storedKey.workerId !== currentKey.workerId) {
    return { reuse: false, reason: "worker-id-changed" }
  }
  if (health && health.ok === false) return { reuse: false, reason: health.reason || "conversation-unhealthy" }
  if (policy.allowContinuation === false) return { reuse: false, reason: policy.reason || "continuation-not-allowed" }
  if (Number(policy.turnsRemaining) === 0) return { reuse: false, reason: "turn-budget-exhausted" }
  return { reuse: true, reason: null, key: currentKey }
}

/**
 * The stale-event gate. Every browser event and late provider response MUST pass
 * through this before it can influence state.
 *
 * An event is OWNED only when:
 *   - (when present) its workerEpoch matches the current workerEpoch;
 *   - (when present) its conversationId/conversationEpoch match the current one;
 *   - (when present) its generation matches the current runGeneration;
 *   - the run is still active (unless the caller is explicitly draining).
 *
 * A field the event does NOT carry is not treated as a mismatch (older workers
 * do not send every field), but a field it DOES carry that disagrees is a hard
 * discard. `missingGeneration` is reported so the caller can fail closed on a
 * response that should have carried a generation.
 */
export function classifyStaleness(event = {}, current = {}, options = {}) {
  const requireGeneration = options.requireGeneration === true
  const currentWorkerEpoch = boundedEpoch(current.workerEpoch)
  const currentConversationEpoch = boundedEpoch(current.conversationEpoch)
  const currentGeneration = boundedEpoch(current.runGeneration)
  const currentConversationId = normalizeId(current.conversationId) || null

  if (options.runActive === false && options.allowLate !== true) {
    return { stale: true, reason: "run-not-active" }
  }
  if (event.workerEpoch !== undefined && event.workerEpoch !== null && boundedEpoch(event.workerEpoch) !== currentWorkerEpoch) {
    return { stale: true, reason: "worker-epoch-mismatch" }
  }
  if (event.profileEpoch !== undefined && event.profileEpoch !== null && boundedEpoch(event.profileEpoch) !== boundedEpoch(current.profileEpoch)) {
    return { stale: true, reason: "profile-epoch-mismatch" }
  }
  if (event.conversationEpoch !== undefined && event.conversationEpoch !== null && boundedEpoch(event.conversationEpoch) !== currentConversationEpoch) {
    return { stale: true, reason: "conversation-epoch-mismatch" }
  }
  const eventConversationId = normalizeId(event.conversationId) || null
  if (eventConversationId && currentConversationId && eventConversationId !== currentConversationId) {
    return { stale: true, reason: "conversation-id-mismatch" }
  }
  const hasGeneration = event.generation !== undefined && event.generation !== null
  if (!hasGeneration) {
    if (requireGeneration) return { stale: true, reason: "missing-generation", missingGeneration: true }
    return { stale: false, reason: null, missingGeneration: true }
  }
  if (boundedEpoch(event.generation) !== currentGeneration) {
    return { stale: true, reason: "generation-mismatch" }
  }
  return { stale: false, reason: null, missingGeneration: false }
}

/** Convenience boolean form of `classifyStaleness`. */
export function isEventOwned(event = {}, current = {}, options = {}) {
  return classifyStaleness(event, current, options).stale !== true
}

export const advisorLifecycleExports = Object.freeze({
  ADVISOR_LIFECYCLE_SCHEMA_VERSION,
  ADVISOR_LIFECYCLE_POLICY,
  createLifecycleIdentity,
  advanceWorkerEpoch,
  advanceProfileEpoch,
  beginAdvisorRun,
  openConversation,
  conversationReuseKey,
  evaluateConversationReuse,
  classifyStaleness,
  isEventOwned,
})
