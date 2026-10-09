// V16.16 Critical-Path History (bounded EMA of measured wave timings).
//
// WHY THIS MODULE EXISTS
//
// V16.15's economy gate compares estimated benefit against estimated overhead
// using FIXED constants only. A fixed constant is honest but blind: on a fast
// machine `git worktree add` may take 400ms, on a loaded Windows box 4s. The
// gate therefore needs REAL local measurements when they exist - without ever
// inventing them when they do not.
//
// This module is the single owner of that memory:
//
//   * record()  ingests one MEASURED wave observation (component timings);
//   * estimates() returns bounded, clamped component estimates for the gate;
//   * everything is an in-memory bounded EMA: no file, no second database, no
//     unbounded growth, no cross-process sharing (a sibling process's disk
//     latency is not this process's evidence).
//
// LAWS
//
//   1. MISSING HISTORY IS NOT_MEASURED. `estimates()` reports which components
//      are MEASURED and which are NOT_MEASURED. A caller that treats a
//      NOT_MEASURED component as measured is lying about its evidence.
//   2. HISTORY TUNES, NEVER OVERRIDES. Estimates are clamped to a configured
//      band around the V16.15 fallback constants, and history can never change
//      the hard writer maximum or promote a TINY/SMALL task.
//   3. BOUNDED ALWAYS. At most MAX_SAMPLES observations are retained per
//      component; the EMA needs O(1) state per component.
//   4. NO FABRICATED VALUES. The module ships with NO seed data. Until record()
//      has been called, every component is NOT_MEASURED.

import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const CRITICAL_PATH_HISTORY_POLICY = "critical-path-history-v16-16"
export const CRITICAL_PATH_HISTORY_SCHEMA_VERSION = 1

/** Wave timing components the economy gate may tune. Stable ids. */
export const HISTORY_COMPONENT = Object.freeze({
  SANDBOX_CREATE_MS: "sandboxCreateMs",
  RPC_WORKER_START_MS: "rpcWorkerStartMs",
  CONTEXT_BUILD_MS: "contextBuildMs",
  CHILD_EXECUTION_MS: "childExecutionMs",
  TARGETED_VERIFY_MS: "targetedVerifyMs",
  INTEGRATION_MS: "integrationMs",
  QUEUE_MS: "queueMs",
  WAVE_WALL_MS: "waveWallMs",
})

/** Fallback constants: the V16.15 declared estimates, unchanged. */
export const HISTORY_FALLBACK_MS = Object.freeze({
  [HISTORY_COMPONENT.SANDBOX_CREATE_MS]: 1_400,
  [HISTORY_COMPONENT.RPC_WORKER_START_MS]: 900,
  [HISTORY_COMPONENT.CONTEXT_BUILD_MS]: 600,
  [HISTORY_COMPONENT.CHILD_EXECUTION_MS]: 4_000,
  [HISTORY_COMPONENT.TARGETED_VERIFY_MS]: 1_200,
  [HISTORY_COMPONENT.INTEGRATION_MS]: 500,
  [HISTORY_COMPONENT.QUEUE_MS]: 0,
  [HISTORY_COMPONENT.WAVE_WALL_MS]: 0,
})

/** Measured values are clamped to this band around the fallback. */
export const HISTORY_CLAMP = Object.freeze({
  minRatio: 0.25,
  maxRatio: 4,
  minSamples: 3,
})

export const HISTORY_LIMITS = Object.freeze({
  maxSamplesPerComponent: 32,
  emaAlpha: 0.35,
  maxComponents: 8,
})

function finiteMs(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 4 * 3_600_000) return null
  return n
}

function clampToBand(value, fallback) {
  if (!(fallback > 0)) return Math.max(0, value)
  const min = fallback * HISTORY_CLAMP.minRatio
  const max = fallback * HISTORY_CLAMP.maxRatio
  return Math.max(min, Math.min(max, value))
}

/**
 * Create a bounded critical-path history.
 *
 * Pure in-memory state; one instance per process is the expected use (the
 * parallel-execution policy owns a module-level default via
 * `defaultCriticalPathHistory()`).
 */
export function createCriticalPathHistory(options = {}) {
  const maxSamples = Math.max(
    1,
    Math.min(
      256,
      Math.trunc(Number(options.maxSamplesPerComponent) || HISTORY_LIMITS.maxSamplesPerComponent),
    ),
  )
  const alpha = Number(options.emaAlpha)
  const smoothing = Number.isFinite(alpha) && alpha > 0 && alpha < 1 ? alpha : HISTORY_LIMITS.emaAlpha
  // component -> { ema, samples }
  const state = new Map()
  let observations = 0

  function record(observation = {}) {
    if (!observation || typeof observation !== "object") {
      return { recorded: 0, observations, deterministic: true }
    }
    let recorded = 0
    for (const component of Object.values(HISTORY_COMPONENT)) {
      const value = finiteMs(observation[component])
      if (value == null) continue
      const row = state.get(component) || { ema: value, samples: 0 }
      row.ema = row.samples === 0 ? value : row.ema + smoothing * (value - row.ema)
      row.samples = Math.min(maxSamples, row.samples + 1)
      state.set(component, row)
      recorded += 1
    }
    if (recorded > 0) observations += 1
    return { recorded, observations, deterministic: true }
  }

  function estimates() {
    const components = {}
    for (const component of Object.values(HISTORY_COMPONENT)) {
      const row = state.get(component)
      const fallback = HISTORY_FALLBACK_MS[component] ?? 0
      if (!row || row.samples < HISTORY_CLAMP.minSamples) {
        components[component] = {
          ...NOT_MEASURED,
          fallbackMs: fallback,
          samples: row?.samples || 0,
        }
        continue
      }
      components[component] = {
        ...measured(Math.round(clampToBand(row.ema, fallback))),
        fallbackMs: fallback,
        samples: row.samples,
      }
    }
    return {
      schemaVersion: CRITICAL_PATH_HISTORY_SCHEMA_VERSION,
      policy: CRITICAL_PATH_HISTORY_POLICY,
      components,
      observations,
      deterministic: true,
    }
  }

  function componentMs(component, fallbackMs) {
    const row = state.get(String(component))
    if (!row || row.samples < HISTORY_CLAMP.minSamples) {
      return { value: null, provenance: "NOT_MEASURED", fallbackMs: fallbackMs ?? null }
    }
    const fallback = Number.isFinite(Number(fallbackMs)) ? Number(fallbackMs) : (HISTORY_FALLBACK_MS[component] ?? 0)
    return {
      value: Math.round(clampToBand(row.ema, fallback)),
      provenance: "MEASURED",
      fallbackMs: fallback,
      samples: row.samples,
    }
  }

  function snapshot() {
    return {
      schemaVersion: CRITICAL_PATH_HISTORY_SCHEMA_VERSION,
      policy: CRITICAL_PATH_HISTORY_POLICY,
      observations,
      components: Object.fromEntries(
        [...state.entries()].map(([key, row]) => [key, { emaMs: Math.round(row.ema), samples: row.samples }]),
      ),
      deterministic: true,
    }
  }

  function reset() {
    state.clear()
    observations = 0
    return { reset: true, deterministic: true }
  }

  return {
    schemaVersion: CRITICAL_PATH_HISTORY_SCHEMA_VERSION,
    policy: CRITICAL_PATH_HISTORY_POLICY,
    record,
    estimates,
    componentMs,
    snapshot,
    reset,
    deterministic: true,
  }
}

let defaultHistory = null

/** Process-wide default history. Bounded, lazy, never pre-seeded. */
export function defaultCriticalPathHistory() {
  if (!defaultHistory) defaultHistory = createCriticalPathHistory()
  return defaultHistory
}

export function resetDefaultCriticalPathHistory() {
  if (defaultHistory) defaultHistory.reset()
  defaultHistory = null
}

export const criticalPathHistoryExports = Object.freeze({
  createCriticalPathHistory,
  defaultCriticalPathHistory,
  resetDefaultCriticalPathHistory,
  HISTORY_COMPONENT,
  HISTORY_FALLBACK_MS,
  HISTORY_CLAMP,
  HISTORY_LIMITS,
})
