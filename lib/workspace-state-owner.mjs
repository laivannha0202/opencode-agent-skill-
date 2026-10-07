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
    }
  } catch {
    return { available: false, root: resolved, fingerprint: null, head: null, changedFiles: [], reason: "workspace-fingerprint-error" }
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
 * The single workspace-state owner for one advisor lifecycle.
 *
 * Usage:
 *   const owner = createWorkspaceStateOwner({ root })
 *   const before = owner.capture("pre-consult")
 *   ... advisor runs ...
 *   const after = owner.capture("pre-write")
 *   const fence = owner.mutationBetween(before, after)
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
