// V16.12 Execution Acceleration Runtime - composition / fast-path orchestrator.
//
// WHY THIS MODULE EXISTS
//
// V16.12 ships six acceleration capabilities. Each owns exactly one question and
// none of them is allowed to know about the others. This module is the SINGLE
// owner of the COMPOSITION: it picks a FAST PATH for a task and wires the
// capabilities into one bounded execution.
//
//   A. verification-receipt-cache-v16-12   (receipt reuse)
//   B. task-dag-scheduler-v16-12           (safe overlap)
//   C. incremental-verification-v16-12     (smallest sufficient plan)
//   D. tool-result-reuse-v16-12            (deterministic result reuse)
//   E. warm-service-reuse-v16-12           (bounded warm services)
//   F. waste-detector-v16-12               (waste + wall attribution)
//
// FAST PATHS
//
//   TINY_FAST_PATH   docs/single-file low-risk. Static verification, result reuse
//                    ON, receipt reuse ON, no full suite, no advisor unless asked.
//   NORMAL_PATH      a few files. Affected tests, safe overlap ON.
//   DEEP_PATH        shared surface / high risk. Affected -> suite, advisor and
//                    browser permitted, full suite allowed.
//   RELEASE_PATH     final release. Receipt reuse DISABLED. Full suite AND
//                    release verifier run FRESH. The acceleration runtime may
//                    ATTRIBUTE this work but must never SKIP it.
//
// LAWS
//
//   1. THE RELEASE PATH IS SACRED. On RELEASE_PATH, `receiptReuseEnabled` is
//      false and `freshGatesRequired` is true. No cached receipt can stand in
//      for `npm test` or `release:verify`.
//   2. ACCELERATION IS OBSERVABLE. Every decision is emitted as an event with a
//      reason. A reused result is labelled; a skipped gate is refused.
//   3. ONE COMPOSITION, NO DUPLICATE TRUTH. This module holds no cache, no
//      ladder and no ledger. It reads the other owners and delegates.
//   4. BOUNDED. It never starts a service, a process or a suite on its own; it
//      describes WHAT should happen and, when asked, runs a bounded DAG.

import {
  classifyTaskShape,
  planIncrementalVerification,
  shapeFastPath,
  TASK_SHAPE,
  FAST_PATH,
} from "./incremental-verification-v16-12.mjs"
import { finalReleaseMode } from "./verification-receipt-cache-v16-12.mjs"
import { createWasteDetector, createWallTimeAttribution, wallAttributionToEfficiencyEvents, WALL_CATEGORY } from "./waste-detector-v16-12.mjs"
import { createWarmServiceRegistry } from "./warm-service-reuse-v16-12.mjs"
import { planTaskDag, runTaskDag } from "./task-dag-scheduler-v16-12.mjs"

export const EXECUTION_ACCELERATION_SCHEMA_VERSION = 1
export const EXECUTION_ACCELERATION_POLICY = "execution-acceleration-v16-12"

export { TASK_SHAPE, FAST_PATH }

/**
 * Decide the acceleration posture for a task. PURE: reads the task shape, the
 * incremental-verification plan and the final-release flag; returns what each
 * capability is allowed to do. It starts nothing.
 */
export function planExecutionAcceleration(input = {}) {
  const finalRelease = input.finalRelease === true
  const shape = input.shape || classifyTaskShape({ ...input, finalRelease })
  const verification = planIncrementalVerification({ ...input, shape, finalRelease })
  const fastPath = shapeFastPath(shape)
  const release = finalReleaseMode({ finalRelease, gateName: input.gateName || "npm test" })

  // The release path disables EVERY dev-time shortcut, not just receipts.
  const allowReuse = !finalRelease && input.allowReuse !== false
  const allowOverlap = input.allowOverlap !== false

  return {
    schemaVersion: EXECUTION_ACCELERATION_SCHEMA_VERSION,
    policy: EXECUTION_ACCELERATION_POLICY,
    shape,
    fastPath,
    finalRelease,
    capabilities: {
      // A. verification receipt cache
      receiptReuse: {
        enabled: allowReuse && verification.receiptReuseEnabled,
        reason: finalRelease ? "final-release-disables-receipt-reuse" : (allowReuse ? "dev-time-reuse-enabled" : "reuse-disabled-by-caller"),
        finalReleaseMode: release.enabled,
      },
      // B. task DAG scheduler
      dagScheduling: {
        enabled: allowOverlap,
        reason: allowOverlap ? "safe-overlap-enabled" : "overlap-disabled-by-caller",
        // Writes always serialize; only read/pure/cache nodes may overlap.
        writesSerialized: true,
      },
      // C. incremental verification
      incrementalVerification: {
        enabled: true,
        targetRung: verification.targetRung,
        escalationPath: verification.escalationPath,
        allowFullSuiteDuringImplementation: verification.allowFullSuiteDuringImplementation,
      },
      // D. tool result reuse
      toolResultReuse: {
        enabled: allowReuse,
        reason: allowReuse ? "deterministic-result-reuse-enabled" : "reuse-disabled-by-caller",
      },
      // E. warm service reuse (never always-on)
      warmServiceReuse: {
        enabled: input.allowWarmServices !== false,
        lazy: true,
        alwaysOn: false,
      },
      // F. waste + wall attribution
      wasteAttribution: {
        enabled: true,
      },
    },
    // On the release path, these gates MUST run fresh and must NOT be replaced
    // by any receipt.
    freshGatesRequired: finalRelease,
    requiredFreshGates: finalRelease ? ["npm test", "release:verify"] : [],
    verification,
    deterministic: true,
  }
}

/**
 * Build a run-scoped acceleration context: the waste detector, the wall-time
 * attribution and a bounded warm-service registry, all sharing one clock so the
 * attribution is internally consistent.
 *
 * @param {object} [options] { root, now, limits }
 */
export function createAccelerationContext(options = {}) {
  const root = options.root || process.cwd()
  const clock = typeof options.now === "function" ? options.now : () => Date.now()
  const detector = createWasteDetector({ now: clock })
  const wall = createWallTimeAttribution({ totalWallMs: options.totalWallMs })
  const warm = createWarmServiceRegistry({ now: clock, limits: options.limits })
  const startedAt = clock()

  return {
    schemaVersion: EXECUTION_ACCELERATION_SCHEMA_VERSION,
    policy: EXECUTION_ACCELERATION_POLICY,
    root,
    detector,
    wall,
    warm,

    /** Record one occurrence of an expensive deterministic operation. */
    observeOperation(operation, identity, wallMs, generation) {
      return detector.record(operation, identity, wallMs, generation)
    },

    /** Attribute a MEASURED wall sample to a category. */
    attribute(category, wallMs) {
      wall.observe(category, wallMs)
    },

    /** Increment an operation counter (fresh/reused tool calls, gate runs, ...). */
    count(name, delta = 1) {
      wall.count(name, delta)
    },

    /**
     * Produce `efficiency.observation` rows that V16.10 Metrics V2 aggregates.
     * This module PRODUCES; Metrics V2 remains the single metrics authority.
     */
    toEfficiencyEvents() {
      wall.setTotalWall(Math.max(0, clock() - startedAt))
      return wallAttributionToEfficiencyEvents(wall.summary(), detector.report())
    },

    /** Convenience: time a phase and attribute it. */
    async timePhase(category, fn) {
      const at = clock()
      try {
        return await fn()
      } finally {
        wall.observe(category, Math.max(0, clock() - at))
      }
    },

    /** The honest end-of-run report. */
    report() {
      const total = Math.max(0, clock() - startedAt)
      wall.setTotalWall(total)
      return {
        schemaVersion: EXECUTION_ACCELERATION_SCHEMA_VERSION,
        policy: EXECUTION_ACCELERATION_POLICY,
        wall: wall.summary(),
        waste: detector.report(),
        warm: warm.status(),
      }
    },

    async shutdown() {
      return warm.shutdown()
    },
  }
}

/**
 * Run a set of acceleration nodes through the DAG scheduler. A thin, honest
 * wrapper so callers do not import the scheduler directly and so the DAG always
 * respects the plan's `writesSerialized` law.
 */
export async function runAcceleratedDag(nodes, options = {}) {
  const plan = planExecutionAcceleration(options.plan || {})
  if (plan.capabilities.dagScheduling.enabled === false) {
    // Overlap disabled: force a serial run by giving every resource width 1.
    return runTaskDag(nodes, { ...options, limits: { CPU: 1, FS_READ: 1, CACHE: 1, SUBPROCESS: 1, WRITE: 1 } })
  }
  return runTaskDag(nodes, options)
}

/**
 * Guard: assert that a claimed gate result was NOT produced by a cached receipt
 * on the release path. Returns a refusal reason when the release invariant is
 * violated, so a release cannot be "accelerated" by skipping a fresh gate.
 */
export function assertFreshGateAllowed(plan, gateName, evidence = {}) {
  if (plan?.finalRelease !== true) return { allowed: true }
  if (evidence?.fromReceipt === true) {
    return {
      allowed: false,
      reason: `release gate ${gateName} must run fresh; a cached receipt cannot stand in`,
    }
  }
  return { allowed: true }
}

export { planTaskDag, runTaskDag }

export const executionAccelerationExports = Object.freeze({
  planExecutionAcceleration,
  createAccelerationContext,
  runAcceleratedDag,
  assertFreshGateAllowed,
  planTaskDag,
  runTaskDag,
  wallAttributionToEfficiencyEvents,
  WALL_CATEGORY,
})
