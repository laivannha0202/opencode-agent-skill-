// V16.9 pre-write fence.
//
// WHY THIS MODULE EXISTS
//
// The V16.8 Decision Barrier guards the ADVISOR side: it decides whether the
// advice may reach the executor. It does NOT guard the WRITE side. Between the
// moment the barrier passed and the moment the executor writes a file, the
// workspace can change (a parallel lane, a user edit, a leftover artifact). The
// V16.8 barrier would still say "passed" because it ran earlier.
//
// The Pre-write Fence is the LAST gate before source mutation. It re-reads the
// workspace through the single `workspace-state-owner` and refuses to let a
// write proceed when the generation or the fingerprint moved. It owns one
// decision and nothing else:
//
//   allow | deny (with a stable reason) | not-applicable (no proof available)
//
// FAIL-CLOSED. When the workspace state is unavailable the fence does NOT
// default to allow: it returns `allowed: false` with `not-applicable`, because
// "we could not prove the workspace is unchanged" is not the same as "the
// workspace is unchanged".

import { createWorkspaceStateOwner, diffOwnedWorkspaceState } from "./workspace-state-owner.mjs"

export const PREWRITE_FENCE_SCHEMA_VERSION = 1
export const PREWRITE_FENCE_POLICY = "prewrite-fence-v16-9"

export const PREWRITE_FENCE_REASON = Object.freeze({
  ALLOWED: "workspace-unchanged-since-advisor",
  NO_PROOF: "workspace-state-unavailable",
  WORKSPACE_MUTATED: "workspace-mutated-after-advisor",
  STALE_GENERATION: "stale-consult-generation",
  ADVISOR_NOT_ACCEPTED: "advisor-not-accepted",
  PATH_OUTSIDE_SCOPE: "target-outside-declared-scope",
  GENERATED_TARGET: "target-is-generated",
  READ_ONLY_TARGET: "target-is-read-only",
})

const GENERATED_SEGMENTS = new Set(["dist", "build", "coverage", "generated", "__generated__", ".generated", "vendor"])

function normalizeRelative(value) {
  const raw = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null
  const parts = []
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") return null
    parts.push(segment)
  }
  const normalized = parts.join("/")
  return normalized || null
}

function isGeneratedPath(relative) {
  const parts = relative.toLowerCase().split("/")
  if (parts.some((part) => GENERATED_SEGMENTS.has(part))) return true
  return /(?:^|[._-])generated(?:[._-]|$)/i.test(parts[parts.length - 1] || "")
}

/**
 * Evaluate the fence for one intended write set.
 *
 * @param {object} input
 * @param {object} input.before        snapshot from workspace-state-owner.capture()
 * @param {object} input.after         snapshot from workspace-state-owner.capture()
 * @param {string[]} [input.writeTargets] relative paths the executor intends to write
 * @param {number} [input.consultGeneration]
 * @param {number} [input.activeGeneration]
 * @param {boolean} [input.advisorAccepted]
 * @param {string[]} [input.allowedTargets] declared scope (optional); when set,
 *        a target outside it is denied even if the workspace is unchanged.
 */
export function evaluatePrewriteFence(input = {}) {
  const reasons = []
  const before = input.before || null
  const after = input.after || null

  if (Number.isFinite(Number(input.consultGeneration)) && Number.isFinite(Number(input.activeGeneration))) {
    if (Number(input.consultGeneration) !== Number(input.activeGeneration)) {
      reasons.push(PREWRITE_FENCE_REASON.STALE_GENERATION)
    }
  }
  if (input.advisorAccepted === false) reasons.push(PREWRITE_FENCE_REASON.ADVISOR_NOT_ACCEPTED)

  const mutation = diffOwnedWorkspaceState(before, after)
  if (mutation.comparable !== true) reasons.push(PREWRITE_FENCE_REASON.NO_PROOF)
  else if (mutation.mutated === true) reasons.push(PREWRITE_FENCE_REASON.WORKSPACE_MUTATED)

  // Target-level validation. A generated or read-only or out-of-scope target is
  // denied BEFORE the write even when the workspace fingerprint is unchanged:
  // the fingerprint proves the workspace did not move, not that this target is
  // a legitimate place to write.
  const declaredScope = Array.isArray(input.allowedTargets) && input.allowedTargets.length
    ? new Set(input.allowedTargets.map(normalizeRelative).filter(Boolean))
    : null
  const rejectedTargets = []
  const acceptedTargets = []
  for (const raw of Array.isArray(input.writeTargets) ? input.writeTargets : []) {
    const relative = normalizeRelative(raw)
    if (!relative) {
      rejectedTargets.push({ path: String(raw), reason: PREWRITE_FENCE_REASON.PATH_OUTSIDE_SCOPE })
      continue
    }
    if (declaredScope && !declaredScope.has(relative)) {
      rejectedTargets.push({ path: relative, reason: PREWRITE_FENCE_REASON.PATH_OUTSIDE_SCOPE })
      continue
    }
    if (isGeneratedPath(relative)) {
      rejectedTargets.push({ path: relative, reason: PREWRITE_FENCE_REASON.GENERATED_TARGET })
      continue
    }
    acceptedTargets.push(relative)
  }

  const targetReasons = new Set(rejectedTargets.map((row) => row.reason))
  for (const reason of targetReasons) reasons.push(reason)

  const allowed = reasons.length === 0
  return {
    schemaVersion: PREWRITE_FENCE_SCHEMA_VERSION,
    kind: "ues-v16-9-prewrite-fence",
    policy: PREWRITE_FENCE_POLICY,
    allowed,
    reasons,
    // A fence that could not compare is "not-applicable" rather than "denied for
    // a real mutation": the caller must be able to tell the two apart.
    status: allowed
      ? "allowed"
      : reasons.includes(PREWRITE_FENCE_REASON.NO_PROOF)
        ? "not-applicable"
        : "denied",
    acceptedTargets,
    rejectedTargets,
    beforeFingerprint: before?.fingerprint || null,
    afterFingerprint: after?.fingerprint || null,
    mutation,
  }
}

/**
 * A stateful fence bound to one advisor lifecycle. It captures its own
 * before/after snapshots through the shared workspace-state owner so the fence
 * and the lane cannot disagree about what "the workspace" is.
 */
export function createPrewriteFence(options = {}) {
  const owner = options.owner || createWorkspaceStateOwner({ root: options.root, now: options.now })
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  let armedBefore = null
  let lastFence = null
  let denials = 0
  let allows = 0

  return {
    schemaVersion: PREWRITE_FENCE_SCHEMA_VERSION,
    policy: PREWRITE_FENCE_POLICY,
    owner,

    /** Snapshot the workspace BEFORE the advisor runs and retain it. */
    armBefore() {
      armedBefore = owner.capture("prewrite-before")
      return armedBefore
    },

    /**
     * Evaluate the fence against a fresh AFTER snapshot. The fence takes the
     * snapshot itself (through the owner) so a caller cannot pass a hand-built
     * fingerprint that never touched the filesystem. The BEFORE snapshot is the
     * one retained by `armBefore()`; a caller may override it explicitly.
     */
    check(input = {}) {
      const before = input.before || armedBefore
      const after = input.after || owner.capture("prewrite-after")
      const result = evaluatePrewriteFence({ ...input, before, after })
      if (result.allowed) allows += 1
      else denials += 1
      lastFence = result
      return result
    },

    state() {
      return {
        schemaVersion: PREWRITE_FENCE_SCHEMA_VERSION,
        policy: PREWRITE_FENCE_POLICY,
        armed: armedBefore !== null,
        allows,
        denials,
        lastFence,
        capturedAt: Number(now()),
      }
    },
  }
}
