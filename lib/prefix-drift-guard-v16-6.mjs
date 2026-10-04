// V16.6 prefix drift guard.
//
// The model's prompt prefix (system prompt + ordered tool surface) is what the
// provider caches. If two economy modes disagree about the ORDER of the first
// entries, the cache is invalidated and every "saving" from the cheaper mode is
// paid back as re-read tokens.
//
// Three declared orders:
//   CACHE     maximize prompt-cache hits -> the shared head must not move at all
//   BALANCED  normal operation           -> at most 1 entry may differ
//   TOKEN     maximum token economy      -> at most 2 entries may differ
//
// The guard never reorders anything itself: it REPORTS drift with a stable
// fingerprint so the runtime (and the eval) can prove the prefix is stable.
// Safety tools are checked separately: a mode may drop a tool from the
// ADVERTISED surface (hydration covers that) but it may never drop a safety
// capability, and this guard fails loudly if it appears to.

import { createHash } from "node:crypto"
import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"

export const PREFIX_DRIFT_SCHEMA_VERSION = 1
export const PREFIX_DRIFT_RELEASE = "v16.6"
export const PREFIX_DRIFT_POLICY = "prefix-drift-guard-v16-6"

export const DRIFT_MODES = Object.freeze(["CACHE", "BALANCED", "TOKEN"])

export const DRIFT_BUDGETS = Object.freeze({
  CACHE: Object.freeze({ maxDrift: 0, window: 12 }),
  BALANCED: Object.freeze({ maxDrift: 1, window: 12 }),
  TOKEN: Object.freeze({ maxDrift: 2, window: 12 }),
})

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeList(list) {
  if (Array.isArray(list)) return list.map((row) => String(row ?? "")).filter(Boolean)
  return String(list || "")
    .split(/[,\s]+/)
    .map((row) => row.trim())
    .filter(Boolean)
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

/** Fingerprint of the leading `window` entries (the cache-relevant head). */
export function prefixFingerprint(entries, window = 12) {
  const list = normalizeList(entries).slice(0, int(window, 12, 1, 64))
  return sha256(list.join("|"))
}

/** Length of the longest common prefix of two ordered lists. */
export function commonPrefixLength(a, b) {
  const left = normalizeList(a)
  const right = normalizeList(b)
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

/**
 * Compare one order against its cached baseline.
 *
 * `current`  the ordered entries as compiled now
 * `baseline` the order that was cached (or the CACHE order)
 * `mode`     CACHE | BALANCED | TOKEN (default BALANCED)
 */
export function guardPrefixDrift(input = {}) {
  const modeRaw = String(input.mode || "BALANCED").toUpperCase()
  const mode = DRIFT_MODES.includes(modeRaw) ? modeRaw : "BALANCED"
  const budget = DRIFT_BUDGETS[mode]
  const window = int(input.window, budget.window, 1, 64)
  const current = normalizeList(input.current)
  const baseline = normalizeList(input.baseline)
  const violations = []

  const shared = commonPrefixLength(current, baseline)
  const windowedCurrent = current.slice(0, window)
  const windowedBaseline = baseline.slice(0, window)
  let driftCount = 0
  const limit = Math.max(windowedCurrent.length, windowedBaseline.length)
  for (let index = 0; index < limit; index += 1) {
    if (windowedCurrent[index] !== windowedBaseline[index]) driftCount += 1
  }
  const allowed = int(input.maxDrift, budget.maxDrift, 0, 8)

  if (driftCount > allowed) violations.push(`prefix-drift:${driftCount}>${allowed}`)

  // Safety entries must survive in every mode.
  const safetyTools = normalizeList(input.safetyTools)
  const missing = safetyTools.filter((tool) => !current.includes(tool))
  if (missing.length) violations.push(`safety-entries-dropped:${missing.join(",")}`)

  // The baseline itself must be non-empty to be meaningful.
  if (!baseline.length && input.requireBaseline !== false) violations.push("baseline-empty")

  return {
    schemaVersion: PREFIX_DRIFT_SCHEMA_VERSION,
    policy: PREFIX_DRIFT_POLICY,
    mode,
    window,
    ok: violations.length === 0,
    violations,
    commonPrefix: shared,
    driftIndex: driftCount > 0 ? shared : -1,
    driftCount,
    allowed,
    safetyToolsMissing: missing,
    fingerprints: {
      current: prefixFingerprint(current, window),
      baseline: prefixFingerprint(baseline, window),
    },
    measurements: {
      driftCount: measured(driftCount),
      allowed: derived(allowed),
      commonPrefix: derived(shared),
      savedTokens: NOT_MEASURED,
    },
    provenance: { driftCount: "MEASURED", allowed: "DERIVED" },
  }
}

/**
 * Compare CACHE / BALANCED / TOKEN orders against each other: the shared head
 * of all three must be identical for the declared budget.
 */
export function guardProfilePrefixes(input = {}) {
  const profiles = input.profiles || {}
  const present = DRIFT_MODES.filter((mode) => Array.isArray(profiles[mode]) && profiles[mode].length)
  const window = int(input.window, 12, 1, 64)
  const rows = present.map((mode) => ({
    mode,
    report: guardPrefixDrift({
      mode,
      window,
      current: profiles[mode],
      baseline: profiles.CACHE && profiles.CACHE.length ? profiles.CACHE : profiles[mode],
      maxDrift: input.maxDrift,
      safetyTools: input.safetyTools,
      requireBaseline: false,
    }),
  }))

  // Pairwise: every mode must share at least (window - its budget) entries with CACHE.
  const violations = rows.flatMap((row) => row.report.violations.map((violation) => `${row.mode}:${violation}`))
  const reference = profiles.CACHE && profiles.CACHE.length ? profiles.CACHE : profiles[present[0]] || []
  const sharedPrefix = Math.min(
    ...present.map((mode) => commonPrefixLength(profiles[mode], reference)),
  )

  return {
    schemaVersion: PREFIX_DRIFT_SCHEMA_VERSION,
    policy: PREFIX_DRIFT_POLICY,
    window,
    ok: violations.length === 0,
    violations,
    modes: present,
    sharedPrefix,
    referenceFingerprint: prefixFingerprint(reference, window),
    rows,
    measurements: {
      sharedPrefix: derived(sharedPrefix),
      modesCompared: derived(present.length),
      promptCacheSavings: NOT_MEASURED,
    },
    provenance: { sharedPrefix: "MEASURED-from-ordered-lists" },
  }
}

/**
 * Environment knob: `UES_PREFIX_DRIFT_BUDGET` may only LOWER a budget, never
 * raise it (raising it would silently disable the guard).
 */
export function resolveDriftBudget(env = process.env, mode = "BALANCED") {
  const modeKey = DRIFT_MODES.includes(String(mode).toUpperCase()) ? String(mode).toUpperCase() : "BALANCED"
  const base = DRIFT_BUDGETS[modeKey]
  const raw = Number(env?.UES_PREFIX_DRIFT_BUDGET)
  const declared = Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : base.maxDrift
  return {
    mode: modeKey,
    maxDrift: Math.min(base.maxDrift, declared),
    window: base.window,
    lowered: declared < base.maxDrift,
    raised: false,
    source: Number.isFinite(raw) && raw >= 0 ? "env" : "default",
  }
}

// ---------------------------------------------------------------------------
// Production observer
// ---------------------------------------------------------------------------
//
// The stable prompt prefix that a provider caches is composed of three logical
// components: the system prompt, the workspace project instructions and the
// ordered tool schema. Each already has a redacted fingerprint (see
// lib/provider-cache-stability.mjs). The observer compares the latest observed
// triple against the previous triple for the same provider/model and reports
// drift against the mode's budget.
//
// The instruction prefix (system + project) is expected to be byte-stable for a
// given provider/model within a session: a change there is reported as
// `unexpectedDrift` so the runtime and the eval can see it instead of silently
// paying re-read tokens. The schema component may legitimately change when the
// advertised tool surface changes, so it is budgeted, not flagged.
//
// State is a bounded in-memory map. V16.6 does not add a second persistent
// store; the loopback baseline is seeded once per process and never written to
// disk.
const PREFIX_BASELINE = new Map()
export const PREFIX_BASELINE_MAX = 64

function componentList(input) {
  return [
    input.systemPrefixHash ? `system:${String(input.systemPrefixHash)}` : "system:none",
    input.projectPrefixHash ? `project:${String(input.projectPrefixHash)}` : "project:none",
    input.toolSchemaPrefixHash ? `schema:${String(input.toolSchemaPrefixHash)}` : "schema:none",
  ]
}

function normalizeDriftMode(value) {
  const key = String(value || "").toUpperCase()
  return DRIFT_MODES.includes(key) ? key : "BALANCED"
}

/** Test / lifecycle hook: drop every remembered baseline. */
export function resetPrefixDriftForTests() {
  PREFIX_BASELINE.clear()
}

export function prefixDriftBaselineSize() {
  return PREFIX_BASELINE.size
}

/**
 * Observe the current stable-prefix component fingerprints and return a drift
 * report relative to the previous observation for the same provider/model.
 *
 * @param {object} input
 * @param {string} [input.provider]
 * @param {string} [input.model]
 * @param {string} [input.mode]                 CACHE | BALANCED | TOKEN
 * @param {string} [input.systemPrefixHash]
 * @param {string} [input.projectPrefixHash]
 * @param {string} [input.toolSchemaPrefixHash]
 * @param {number} [input.stableTransitionRatio]
 * @param {number} [input.cacheReadRatio]
 * @param {object} [input.env]
 */
export function observePrefixDrift(input = {}) {
  const provider = String(input.provider || "")
  const model = String(input.model || "")
  const key = `${provider}\u0000${model}`
  const current = componentList(input)
  const mode = normalizeDriftMode(input.mode)
  const budget = resolveDriftBudget(input.env || process.env, mode)
  const previous = PREFIX_BASELINE.get(key) || null
  const window = current.length

  const base = previous
    ? guardPrefixDrift({
        mode,
        current,
        baseline: previous.components,
        window,
        maxDrift: budget.maxDrift,
        requireBaseline: false,
      })
    : {
        schemaVersion: PREFIX_DRIFT_SCHEMA_VERSION,
        policy: PREFIX_DRIFT_POLICY,
        mode,
        window,
        ok: true,
        violations: [],
        commonPrefix: window,
        driftIndex: -1,
        driftCount: 0,
        allowed: budget.maxDrift,
        safetyToolsMissing: [],
        fingerprints: { current: prefixFingerprint(current, window), baseline: null },
        measurements: {
          driftCount: measured(0),
          allowed: derived(budget.maxDrift),
          commonPrefix: derived(window),
          savedTokens: NOT_MEASURED,
        },
        provenance: { driftCount: "MEASURED", allowed: "DERIVED" },
      }

  const systemChanged = previous ? previous.components[0] !== current[0] : false
  const projectChanged = previous ? previous.components[1] !== current[1] : false
  const schemaChanged = previous ? previous.components[2] !== current[2] : false
  const unexpectedDrift = Boolean(previous && (systemChanged || projectChanged))

  PREFIX_BASELINE.set(key, { components: current, provider, model, at: Date.now() })
  while (PREFIX_BASELINE.size > PREFIX_BASELINE_MAX) {
    PREFIX_BASELINE.delete(PREFIX_BASELINE.keys().next().value)
  }

  return {
    ...base,
    release: PREFIX_DRIFT_RELEASE,
    provider: provider || null,
    model: model || null,
    baselinePresent: Boolean(previous),
    systemChanged,
    projectChanged,
    schemaChanged,
    unexpectedDrift,
    unexpectedReason: unexpectedDrift ? "instruction-prefix-changed" : null,
    stableTransitionRatio: input.stableTransitionRatio ?? null,
    cacheReadRatio: input.cacheReadRatio ?? null,
    budget,
    evidence: previous ? "MEASURED" : "BASELINE_SEEDED",
  }
}

export const PREFIX_DRIFT_EXPORTS = Object.freeze([
  "observePrefixDrift",
  "resetPrefixDriftForTests",
  "guardPrefixDrift",
  "guardProfilePrefixes",
  "prefixFingerprint",
  "commonPrefixLength",
  "resolveDriftBudget",
  "DRIFT_MODES",
  "DRIFT_BUDGETS",
])
