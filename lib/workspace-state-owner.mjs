// V16.9 workspace state owner.
//
// WHY THIS MODULE EXISTS
//
// V16.8 proved the Decision Barrier works, but it read workspace state from
// several ad-hoc call sites: `captureBarrierFingerprint()` inside the barrier,
// `captureWorkspaceStateV2()` inside the lane, `runtimeWorkspaceFingerprint()`
// inside the controller. Each is a DIFFERENT question ("what is the hash of the
// runtime paths?", "did HEAD move?", "which files are dirty?"), and a run that
// asks three owners can get three answers. A stale answer between the advisor
// call and the executor write is exactly the class of bug the barrier exists to
// prevent.
//
// This module is the SINGLE owner of workspace state for one advisor lifecycle.
// It does not invent a new fingerprint: it wraps the proven
// `captureWorkspaceStateV2()` from `lib/workspace-fingerprint.mjs` and adds only
// what the lifecycle needs and nothing that already exists:
//
//   * a monotonic GENERATION, so a state captured for generation N can never be
//     silently compared against generation N+1;
//   * an explicit before/after MUTATION check that reports WHICH paths changed,
//     not just "the hashes differ";
//   * a fail-closed posture: when the fingerprint is unavailable the owner says
//     so (`available: false`) instead of returning a nonce that looks real.
//
// It owns NO escalation rule, NO budget and NO authority policy. It answers one
// question honestly: "is the workspace still the workspace the advisor saw?"

import path from "node:path"
import { captureWorkspaceStateV2 } from "./workspace-fingerprint.mjs"

export const WORKSPACE_STATE_OWNER_SCHEMA_VERSION = 1
export const WORKSPACE_STATE_OWNER_POLICY = "workspace-state-owner-v16-9"

function normalizeChangedPath(row) {
  if (row == null) return null
  if (typeof row === "string") return row.trim() || null
  const value = row.path ?? row.file ?? null
  return value == null ? null : String(value).trim() || null
}

function changedPathSet(rows) {
  const set = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = normalizeChangedPath(row)
    if (value) set.add(value)
  }
  return set
}

/**
 * Capture a workspace snapshot through the single fingerprint owner.
 *
 * Returns a value object with an explicit `available` flag. A snapshot that
 * could not be produced is `available: false` with a `reason`; it is never a
 * fabricated fingerprint that a later equality check would treat as real.
 */
export function captureOwnedWorkspaceState(root, options = {}) {
  const resolved = root ? path.resolve(String(root)) : null
  if (!resolved) {
    return { available: false, root: null, fingerprint: null, head: null, changedFiles: [], reason: "workspace-root-unavailable" }
  }
  try {
    const state = captureWorkspaceStateV2(resolved, options)
    if (!state?.fingerprint) {
      return {
        available: false,
        root: resolved,
        fingerprint: null,
        head: state?.head ? String(state.head) : null,
        changedFiles: [],
        reason: state?.reason || "workspace-fingerprint-unavailable",
        raw: state || null,
      }
    }
    return {
      available: true,
      root: resolved,
      fingerprint: String(state.fingerprint),
      head: state?.head ? String(state.head) : null,
      git: state.git === true,
      cacheable: state.cacheable === true,
      changedFiles: (state.changedFiles || []).map(normalizeChangedPath).filter(Boolean),
      reason: null,
      // The untouched V2 state, for the consumers that legitimately need the
      // full snapshot (status entries, staged/worktree diff output). Identity and
      // generation stay owned above; this is the same underlying observation, not
      // a second capture.
      raw: state,
    }
  } catch {
    return { available: false, root: resolved, fingerprint: null, head: null, changedFiles: [], reason: "workspace-fingerprint-error", raw: null }
  }
}

/**
 * Compare two owned snapshots and report the mutation honestly.
 *
 * `mutated` is true only when BOTH snapshots are available and their
 * fingerprints differ. When either side is unavailable the answer is
 * `unknown` (fail closed at the caller) rather than a guess.
 */
export function diffOwnedWorkspaceState(before, after) {
  const beforeAvailable = before?.available === true
  const afterAvailable = after?.available === true
  if (!beforeAvailable || !afterAvailable) {
    return {
      comparable: false,
      mutated: null,
      addedPaths: [],
      removedPaths: [],
      reason: !beforeAvailable ? "before-unavailable" : "after-unavailable",
    }
  }
  const mutated = before.fingerprint !== after.fingerprint
  if (!mutated) {
    return { comparable: true, mutated: false, addedPaths: [], removedPaths: [], reason: null }
  }
  const beforePaths = changedPathSet(before.changedFiles)
  const afterPaths = changedPathSet(after.changedFiles)
  const addedPaths = [...afterPaths].filter((value) => !beforePaths.has(value)).sort()
  const removedPaths = [...beforePaths].filter((value) => !afterPaths.has(value)).sort()
  // A fingerprint change with no dirty-path delta is still a real mutation
  // (HEAD moved, or an untracked file's CONTENT changed). It is reported as a
  // fingerprint-level change rather than being dropped because the path sets
  // happen to match.
  const reason = addedPaths.length || removedPaths.length ? "dirty-paths-changed" : "fingerprint-changed"
  return { comparable: true, mutated: true, addedPaths, removedPaths, reason }
}

/**
 * The single RUN-SCOPED workspace state owner (V16.18).
 *
 * WHY THIS EXISTS
 *
 * `createWorkspaceStateOwner()` above is generation-per-capture: it is the right
 * shape for an advisor lifecycle that wants a before/after pair. A RUN wants the
 * opposite: ONE immutable generation shared by every read-only consumer
 * (admission, budget, context, cache, advisor, telemetry, hygiene, planner), and
 * a fresh generation only at a real MUTATION BOUNDARY.
 *
 * The V16.8/V16.9 audit showed exactly the duplicate-capture problem this fixes:
 * `workspaceDecisionInputs()`, `boundedWorkspaceDiff()` and
 * `boundedWorkspaceHead()` each took their OWN full `captureWorkspaceStateV2()`
 * (four Git processes plus an untracked-content hash each) to answer three
 * questions about the same repository state.
 *
 * THE CONTRACT
 *
 *   current(label)      reuse the live generation; captures ONLY when there is
 *                       no live generation or the previous one was invalidated.
 *                       Read-only work therefore costs ONE capture for the whole
 *                       run, and the first read-only consumer after a mutation
 *                       is the one that pays for the refresh.
 *   invalidate(reason)  mark the live generation stale. NO capture happens here;
 *                       a later `current()` performs exactly one.
 *   refresh(label)      an explicit mutation boundary: ALWAYS exactly one new
 *                       generation, never a reuse.
 *   isCurrent(snapshot) fail closed: a snapshot from an older generation can
 *                       never be handed to the verifier, the cache or the advisor
 *                       as if it were current.
 *
 * This adds no authority: it wraps the proven `captureWorkspaceStateV2()` and
 * never weakens it. A capture that fails is reported as `available:false` and
 * consumers fail closed exactly as before.
 */
export function createRunWorkspaceStateOwner(options = {}) {
  const root = options.root ? path.resolve(String(options.root)) : null
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  let generation = 0
  let captures = 0
  let refreshes = 0
  let reuses = 0
  let invalidations = 0
  let current = null
  let stale = true
  const history = []

  function capture(label) {
    const snapshot = {
      ...captureOwnedWorkspaceState(root, options.captureOptions || {}),
      label: String(label || "run-state"),
      generation: generation + 1,
      capturedAt: Number(now()),
    }
    generation = snapshot.generation
    captures += 1
    stale = false
    current = snapshot
    history.push({
      label: snapshot.label,
      generation: snapshot.generation,
      fingerprint: snapshot.fingerprint,
      available: snapshot.available,
    })
    if (history.length > 64) history.shift()
    return snapshot
  }

  return {
    schemaVersion: WORKSPACE_STATE_OWNER_SCHEMA_VERSION,
    policy: WORKSPACE_STATE_OWNER_POLICY,
    root,
    runScoped: true,

    /** Reuse the live generation; capture only when none is live or it is stale. */
    current(label = "run-state") {
      if (current && !stale) {
        reuses += 1
        return current
      }
      return capture(label)
    },

    /** Current generation identifier (0 when nothing has been captured yet). */
    generationOf() {
      return generation
    },

    /** The live snapshot without capturing anything (null when none is live). */
    peek() {
      return stale ? null : current
    },

    /**
     * Mark the live generation stale after a real mutation. This deliberately
     * does NOT capture: the byte cost is paid once, by the next reader.
     */
    invalidate(reason = "mutation") {
      const previous = current
      invalidations += 1
      stale = true
      return {
        schemaVersion: WORKSPACE_STATE_OWNER_SCHEMA_VERSION,
        generation,
        invalidatedGeneration: generation,
        mutated: previous?.available === true,
        fingerprint: previous?.fingerprint || null,
        reason: String(reason || "mutation"),
      }
    },

    /** Explicit mutation boundary: exactly ONE new generation, never a reuse. */
    refresh(label = "post-mutation") {
      refreshes += 1
      return capture(label)
    },

    /** Fail closed when a candidate snapshot is not from the live generation. */
    isCurrent(candidate) {
      if (!current || stale) return false
      return Number(candidate?.generation || 0) === generation && candidate?.generation === current.generation
    },

    /** Compare the live generation against a candidate, or null when uncomparable. */
    mutationSince(candidate) {
      const live = current
      if (!live || !candidate) return { comparable: false, mutated: null, reason: "no-live-generation" }
      if (Number(candidate.generation || 0) === live.generation) {
        return { comparable: false, mutated: null, reason: "same-generation" }
      }
      const diff = diffOwnedWorkspaceState(candidate, live)
      return { ...diff, since: Number(candidate.generation || 0) }
    },

    state() {
      return {
        schemaVersion: WORKSPACE_STATE_OWNER_SCHEMA_VERSION,
        policy: WORKSPACE_STATE_OWNER_POLICY,
        root,
        runScoped: true,
        generation,
        captures,
        refreshes,
        reuses,
        invalidations,
        stale,
        history: history.slice(-8),
      }
    },
  }
}

/**
 * The single workspace-state owner for one advisor lifecycle.
 *
 * Usage:
 *   const owner = createWorkspaceStateOwner({ root })
 *   const before = owner.capture("pre-consult")
 *   ... advisor runs ...
 *   const after = owner.capture("pre-write")
 *   const fence = owner.mutationBetween(before, after)
 *
 * For a whole RUN (admission + budget + context + cache + advisor + telemetry +
 * planner, refreshed only at a mutation boundary) use
 * `createRunWorkspaceStateOwner()` below instead: it reuses one immutable
 * generation for every read-only consumer rather than capturing per question.
 */
export function createWorkspaceStateOwner(options = {}) {
  const root = options.root ? path.resolve(String(options.root)) : null
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  let generation = 0
  let captures = 0
  let mutationsObserved = 0
  const history = []

  return {
    schemaVersion: WORKSPACE_STATE_OWNER_SCHEMA_VERSION,
    policy: WORKSPACE_STATE_OWNER_POLICY,
    root,

    /**
     * Capture a labelled snapshot bound to the CURRENT generation. Every capture
     * is tagged with the generation so a stale snapshot cannot be compared
     * against a newer one without the caller noticing.
     */
    capture(label = "state") {
      generation += 1
      captures += 1
      const snapshot = {
        ...captureOwnedWorkspaceState(root),
        label: String(label),
        generation,
        capturedAt: Number(now()),
      }
      history.push({ label: snapshot.label, generation: snapshot.generation, fingerprint: snapshot.fingerprint, available: snapshot.available })
      if (history.length > 32) history.shift()
      return snapshot
    },

    /**
     * Mutation check between two captures. Same generation => no comparison is
     * possible (the caller compared a snapshot with itself); that is reported as
     * `comparable: false` rather than "not mutated".
     */
    mutationBetween(before, after) {
      if (before && after && before.generation === after.generation) {
        return { comparable: false, mutated: null, addedPaths: [], removedPaths: [], reason: "same-generation" }
      }
      const diff = diffOwnedWorkspaceState(before, after)
      if (diff.mutated === true) mutationsObserved += 1
      return diff
    },

    /** Whether the workspace is safe to mutate for the given generation. */
    isGenerationCurrent(candidate) {
      return Number(candidate?.generation || 0) === generation
    },

    state() {
      return {
        schemaVersion: WORKSPACE_STATE_OWNER_SCHEMA_VERSION,
        policy: WORKSPACE_STATE_OWNER_POLICY,
        root,
        generation,
        captures,
        mutationsObserved,
        history: history.slice(-8),
      }
    },
  }
}
