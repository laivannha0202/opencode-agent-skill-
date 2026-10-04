// V16.6 measurement provenance.
//
// V16.6 adds an adaptive budget that *spends* effort (context, skills, tools,
// DeepSeek turns). Every number such a decision consumes must carry an honest
// provenance label, otherwise the release would be inventing savings.
//
// Vocabulary (frozen - do not add synonyms):
//
//   MEASURED     a value observed in this workspace / this run (hashes,
//                counts, timings, byte lengths read from an artifact)
//   DERIVED      computed from MEASURED inputs by a documented pure function
//   ESTIMATED    a plausible approximation (token counts from chars, provider
//                context window from published capability, heuristic sizes)
//   NOT_MEASURED explicitly recorded as unavailable. Never silently omitted.
//
// Rules enforced here:
//   - a metric without a provenance label is invalid
//   - NOT_MEASURED is a first-class value, not null-by-omission
//   - no helper may invent a number: unknown input => NOT_MEASURED
//
// See docs/V16.6-UNIFIED-ADAPTIVE-ORCHESTRATION.md (Telemetry provenance).

/**
 * @type {Readonly<{
 *   MEASURED: "MEASURED";
 *   DERIVED: "DERIVED";
 *   ESTIMATED: "ESTIMATED";
 *   NOT_MEASURED: "NOT_MEASURED";
 * }>}
 */
export const PROVENANCE = Object.freeze({
  MEASURED: "MEASURED",
  DERIVED: "DERIVED",
  ESTIMATED: "ESTIMATED",
  NOT_MEASURED: "NOT_MEASURED",
})

export const PROVENANCE_RANK = Object.freeze({
  [PROVENANCE.MEASURED]: 4,
  [PROVENANCE.DERIVED]: 3,
  [PROVENANCE.ESTIMATED]: 2,
  [PROVENANCE.NOT_MEASURED]: 0,
})

// Evidence priority for orchestration decisions (V16.6 §1). Runtime evidence
// outranks repository structure, which outranks verifier history, which
// outranks the task text. Task text must never be the dominant signal.
export const EVIDENCE_PRIORITY = Object.freeze([
  "runtime-evidence",
  "repository-structure",
  "verifier-evidence",
  "task-text",
])

/** @param {any} value */
export function isProvenance(value) {
  return Object.values(PROVENANCE).includes(String(value))
}

/** @param {any} value @param {any} provenance */
export function metric(value, provenance) {
  const label = String(provenance || "")
  if (!isProvenance(label)) {
    return Object.freeze({ value: null, provenance: PROVENANCE.NOT_MEASURED, reason: "invalid-provenance" })
  }
  if (label === PROVENANCE.NOT_MEASURED) {
    return Object.freeze({ value: null, provenance: PROVENANCE.NOT_MEASURED, reason: "not-measured" })
  }
  if (value === null || value === undefined) {
    return Object.freeze({ value: null, provenance: PROVENANCE.NOT_MEASURED, reason: "missing-value" })
  }
  return Object.freeze({ value, provenance: label })
}

export function measured(value) {
  return metric(value, "MEASURED")
}

export function derived(value) {
  return metric(value, "DERIVED")
}

export function estimated(value) {
  return metric(value, "ESTIMATED")
}

export const NOT_MEASURED = Object.freeze({ value: null, provenance: PROVENANCE.NOT_MEASURED, reason: "not-measured" })

/** @param {any} metricRow */
export function isMeasured(metricRow) {
  return metricRow?.provenance === PROVENANCE.MEASURED
}

/** @param {any} a @param {any} b */
export function strongerProvenance(a, b) {
  const rankA = PROVENANCE_RANK[a?.provenance] ?? 0
  const rankB = PROVENANCE_RANK[b?.provenance] ?? 0
  return rankA >= rankB ? a : b
}

// chars -> tokens is an approximation, never a measurement. The ratio is the
// standard English/code heuristic and is labeled ESTIMATED at every call site.
export const CHARS_PER_TOKEN = 4

export function estimateTokensFromChars(chars) {
  const value = Number(chars)
  if (!Number.isFinite(value) || value < 0) return NOT_MEASURED
  return estimated(Math.max(0, Math.round(value / CHARS_PER_TOKEN)))
}

// Rank of an evidence basis for scoring (higher wins on conflict).
export function evidenceRank(basis) {
  const index = EVIDENCE_PRIORITY.indexOf(String(basis || ""))
  return index === -1 ? -1 : EVIDENCE_PRIORITY.length - index
}

export function strongerEvidenceBasis(a, b) {
  return evidenceRank(a) >= evidenceRank(b) ? a : b
}

export const MEASUREMENT_PROVENANCE_SCHEMA_VERSION = 1
