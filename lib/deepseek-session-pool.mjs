// V16.6 DeepSeek session intelligence - pool (part 2 of 4).
//
// Lifecycle manager for the persistent browser/profile sessions plus the
// conversation threads. Rules enforced here:
//
//   * bounded concurrency (default 2, hard max 3) - never a swarm
//   * ONE writer per session; read-only observers may overlap with a writer
//   * a session that rotates hands a resume capsule to its successor
//   * everything a session did is reported through bounded telemetry
//
// Deliberately synchronous and in-memory: browser control stays where the
// caller already owns the browser (ues.ts web lane). This module only
// arbitrates access and budget.

import {
  createConversationSession,
  resolveSessionBudget,
  shouldRotateSession,
  recordSessionTurn,
  closeConversationSession,
  sessionTelemetry,
} from "./deepseek-session-budget.mjs"
import { buildResumeCapsule, resumeFingerprint } from "./deepseek-resume-capsule.mjs"

export const DEEPSEEK_SESSION_POOL_SCHEMA_VERSION = 1
export const DEEPSEEK_SESSION_POOL_POLICY = "deepseek-session-pool-v16-6"

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Create a pool. `maxConcurrent` is clamped to the session budget ceiling.
 */
export function createSessionPool(input = {}) {
  const env = input.env || process.env
  const budget = input.budget || resolveSessionBudget(env)
  const state = {
    sessions: new Map(),
    leases: new Map(),
    order: [],
    telemetry: {
      created: 0,
      rotations: 0,
      evictions: 0,
      leaseConflicts: 0,
      writersActive: 0,
      maxConcurrentWriters: 0,
      capsules: 0,
      errors: 0,
    },
    lastCapsule: null,
  }

  const maxConcurrent = Math.min(
    budget.hardMaxConcurrentSessions,
    int(input.maxConcurrent, budget.maxConcurrentSessions, 1, budget.hardMaxConcurrentSessions),
  )

  function activeWriters() {
    let count = 0
    for (const lease of state.leases.values()) if (lease.mode === "write" && !lease.released) count += 1
    return count
  }

  function createSession(meta = {}) {
    const session = createConversationSession({ ...meta, budget, env })
    state.sessions.set(session.id, session)
    state.order.push(session.id)
    state.telemetry.created += 1
    return session
  }

  /**
   * Acquire an exclusive write lease. Only one write lease per session exists;
   * a second writer is refused rather than queued, so a stalled browser action
   * can never silently block the whole run.
   */
  function acquire(sessionId, options = {}) {
    const id = String(sessionId || "")
    let session = state.sessions.get(id)
    if (!session) session = createSession({ id, ...options })
    if (session.status !== "open") {
      return { ok: false, reason: "session-closed", session }
    }
    const existing = state.leases.get(id)
    const mode = options.mode === "read" ? "read" : "write"
    if (mode === "write" && existing && !existing.released && existing.mode === "write") {
      state.telemetry.leaseConflicts += 1
      return { ok: false, reason: "write-lease-held", holder: existing.owner, session }
    }
    const lease = {
      sessionId: id,
      mode,
      owner: String(options.owner || "ues"),
      reason: String(options.reason || ""),
      released: false,
      acquiredAt: Number.isFinite(options.now) ? options.now : Date.now(),
    }
    if (lease.mode === "read" && existing && !existing.released && existing.mode === "write") {
      // read-only overlap with an active writer is explicitly allowed
      lease.readOnlyOverlap = true
    } else {
      state.leases.set(id, lease)
    }
    if (lease.mode === "write") {
      const active = activeWriters() + 1
      state.telemetry.writersActive = active
      state.telemetry.maxConcurrentWriters = Math.max(state.telemetry.maxConcurrentWriters, active)
      if (active > maxConcurrent) {
        lease.released = true
        state.telemetry.leaseConflicts += 1
        state.telemetry.writersActive = active - 1
        return { ok: false, reason: "concurrency-exceeded", maxConcurrent, session }
      }
    }
    return { ok: true, lease, session }
  }

  function release(lease) {
    if (!lease || lease.released) return false
    lease.released = true
    if (lease.mode === "write") {
      state.telemetry.writersActive = Math.max(0, state.telemetry.writersActive - 1)
      if (state.leases.get(lease.sessionId) === lease) state.leases.delete(lease.sessionId)
    }
    return true
  }

  /** Run `fn` under a lease; always releases, even on throw. */
  async function withSession(sessionId, options, fn) {
    const result = acquire(sessionId, options)
    if (!result.ok) return result
    try {
      const value = await fn(result.session, result.lease)
      return { ok: true, value, session: result.session }
    } catch (error) {
      state.telemetry.errors += 1
      return { ok: false, reason: "threw", error, session: result.session }
    } finally {
      release(result.lease)
    }
  }

  /** Rotate a session: close it, build a resume capsule, open the successor. */
  function rotate(sessionId, context = {}) {
    const session = state.sessions.get(String(sessionId || ""))
    if (!session) return { ok: false, reason: "unknown-session" }
    const decision = shouldRotateSession(session, context.now ?? Date.now(), context)
    const capsule = buildResumeCapsule({
      ...context,
      session,
      sessionBudget: {
        turnsUsed: session.turnsUsed,
        rotations: session.rotations,
        budget: session.budget,
      },
    })
    state.telemetry.capsules += 1
    state.lastCapsule = capsule
    closeConversationSession(session, decision.reasons[0] || "rotated")
    const successor = createSession({
      id: `${session.id}#${session.rotations + 1}`,
      taskFingerprint: session.taskFingerprint,
      role: session.role,
      phase: session.phase,
      reasoningMode: session.reasoningMode,
      turnBudget: session.turnBudget,
    })
    successor.rotations = session.rotations + 1
    successor.evidenceRefs = [...session.evidenceRefs]
    successor.capsuleFingerprint = resumeFingerprint(capsule)
    successor.parentSessionId = session.id
    state.telemetry.rotations += 1
    evict()
    return { ok: true, session: successor, previous: session, capsule, reasons: decision.reasons }
  }

  /** LRU eviction of closed/oldest sessions so the pool stays bounded. */
  function evict() {
    const maxEntries = Math.max(maxConcurrent + 1, 3)
    while (state.sessions.size > maxEntries) {
      const id = state.order.shift()
      if (!id) break
      const candidate = state.sessions.get(id)
      if (candidate && candidate.status === "open") {
        const held = state.leases.get(id)
        if (held && !held.released) {
          state.order.push(id)
          break
        }
        closeConversationSession(candidate, "evicted")
      }
      state.sessions.delete(id)
      state.leases.delete(id)
      state.telemetry.evictions += 1
    }
  }

  function recordTurn(sessionId, turn) {
    const session = state.sessions.get(String(sessionId || ""))
    if (!session) return null
    const result = recordSessionTurn(session, turn)
    if (turn && turn.rotate === true) return rotate(sessionId, turn)
    return result
  }

  function report(options = {}) {
    return {
      schemaVersion: DEEPSEEK_SESSION_POOL_SCHEMA_VERSION,
      policy: DEEPSEEK_SESSION_POOL_POLICY,
      maxConcurrent,
      budget,
      openSessions: [...state.sessions.values()].filter((row) => row.status === "open").length,
      totalSessions: state.sessions.size,
      telemetry: { ...state.telemetry },
      sessions: [...state.sessions.values()].map((row) => sessionTelemetry(row, options)),
      lastCapsule: state.lastCapsule
        ? {
            fingerprint: state.lastCapsule.fingerprint,
            sizeChars: state.lastCapsule.sizeChars,
            truncated: state.lastCapsule.truncated,
            secretScanClean: state.lastCapsule.secretScanClean,
          }
        : null,
    }
  }

  return {
    schemaVersion: DEEPSEEK_SESSION_POOL_SCHEMA_VERSION,
    policy: DEEPSEEK_SESSION_POOL_POLICY,
    maxConcurrent,
    budget,
    createSession,
    get: (sessionId) => state.sessions.get(String(sessionId || "")) || null,
    list: () => [...state.sessions.values()],
    acquire,
    release,
    withSession,
    rotate,
    recordTurn,
    evict,
    report,
    telemetry: state.telemetry,
  }
}
