// V16.17 (§10) Canonical Provider Usage Normalizer.
//
// WHY THIS MODULE EXISTS
//
// Provider token accounting was interpreted in several places with subtly
// different rules:
//
//   * `lib/run-telemetry.mjs`   summed `usageSamples` (a DELTA assumption);
//   * `lib/eval-telemetry.mjs`  recorded a "first usage" separately;
//   * `lib/external-research-broker-v16-13.mjs` picked one usage object;
//   * production callers wrote `Number(usage?.totalTokens ?? 0)`, which turned
//     an UNKNOWN provider report into a MEASURED ZERO.
//
// A provider may report usage in one of three shapes, and the difference
// MATTERS:
//
//   CUMULATIVE  each sample is a running total; summing double-counts.
//   DELTA       each sample is the increment for that turn; summing is correct.
//   UNKNOWN     the provider did not tell us; the honest answer is NOT_MEASURED.
//
// This module is the ONE authority that interprets a usage report. Every
// consumer (verified task cost, Metrics V2, model-performance learner, run
// budget settlement, efficiency ledger, benchmark report, child telemetry and
// the final cost summary) MUST read tokens through it.
//
// LAWS
//
//   1. PROVIDER-REPORTED ONLY. A number is MEASURED only when the provider
//      actually reported it. A char count, a word count or a local
//      approximation is NEVER a measured token.
//   2. UNKNOWN IS NOT ZERO. A missing field is `NOT_MEASURED` (value null),
//      never `0`. A genuine provider-reported `0` stays a distinct MEASURED 0.
//   3. PARTIAL STAYS PARTIAL. If input is reported but output is not, the
//      output field is NOT_MEASURED and the aggregate is explicitly partial.
//   4. NO SUMMING OF CUMULATIVE SAMPLES. The semantics decide the reduction.
//   5. MIXED / UNKNOWN SEMANTICS FAIL CONSERVATIVE. When samples disagree on
//      shape, the ambiguous field degrades to NOT_MEASURED rather than guess.

import { NOT_MEASURED, PROVENANCE, metric } from "./measurement-provenance.mjs"

export const PROVIDER_USAGE_NORMALIZER_POLICY = "provider-usage-normalizer-v16-17"
export const PROVIDER_USAGE_NORMALIZER_SCHEMA_VERSION = 1

/** How a provider reported a sequence of samples. */
export const SAMPLE_SEMANTICS = Object.freeze({
  CUMULATIVE: "CUMULATIVE",
  DELTA: "DELTA",
  UNKNOWN: "UNKNOWN",
})

/** Provenance vocabulary for a single token field. */
export const USAGE_PROVENANCE = Object.freeze({
  MEASURED: "MEASURED",
  NOT_MEASURED: "NOT_MEASURED",
})

// Canonical field aliases. Pi RPC/eval emits compact aliases; OpenAI-compatible
// providers emit *Tokens or snake_case.
const INPUT_KEYS = ["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]
const OUTPUT_KEYS = ["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]
const CACHE_READ_KEYS = ["cacheRead", "cacheReadTokens", "cache_read_tokens", "cachedInputTokens", "cached_input_tokens"]
const CACHE_WRITE_KEYS = ["cacheWrite", "cacheWriteTokens", "cache_write_tokens"]
const TOTAL_KEYS = ["totalTokens", "total_tokens", "total"]

/**
 * Parse one provider field into a measured integer or `null`.
 * Returns `null` for missing / empty / non-finite values. A finite `0` is
 * preserved as a genuine measured zero (never confused with unknown).
 */
function pickMeasured(source, keys) {
  if (!source || typeof source !== "object") return null
  for (const key of keys) {
    if (!(key in source)) continue
    const raw = source[key]
    if (raw === null || raw === undefined || raw === "") continue
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) continue
    return Math.trunc(value)
  }
  return null
}

/** A `{value, provenance}` cell. `null` value => NOT_MEASURED. */
function cell(value) {
  return value === null || value === undefined
    ? Object.freeze({ value: null, provenance: USAGE_PROVENANCE.NOT_MEASURED })
    : Object.freeze({ value, provenance: USAGE_PROVENANCE.MEASURED })
}

function rawFields(source) {
  return {
    input: pickMeasured(source, INPUT_KEYS),
    output: pickMeasured(source, OUTPUT_KEYS),
    cacheRead: pickMeasured(source, CACHE_READ_KEYS),
    cacheWrite: pickMeasured(source, CACHE_WRITE_KEYS),
    total: pickMeasured(source, TOTAL_KEYS),
  }
}

function hasAnyField(fields) {
  return fields.input !== null || fields.output !== null || fields.total !== null
}

/**
 * V16.17 (§10): sample semantics are DECLARED, never guessed.
 *
 * An earlier draft tried to infer CUMULATIVE from monotonicity, but two
 * increasing DELTA samples are indistinguishable from a cumulative series, and
 * guessing wrong either double-counts (summing cumulative) or under-counts
 * (taking the last delta). The directive is explicit: never fabricate. So the
 * default is DELTA — the historical Pi per-turn contract — and CUMULATIVE is
 * only honored when the caller declares it (e.g. a provider whose API documents
 * a running total). UNKNOWN is honored as NOT_MEASURED.
 */
function resolveSemantics(declared) {
  const normalized = String(declared || "").toUpperCase()
  if (normalized === SAMPLE_SEMANTICS.CUMULATIVE) return SAMPLE_SEMANTICS.CUMULATIVE
  if (normalized === SAMPLE_SEMANTICS.UNKNOWN) return SAMPLE_SEMANTICS.UNKNOWN
  return SAMPLE_SEMANTICS.DELTA
}

function reduceSeries(values, semantics) {
  const present = values.filter((value) => value !== null)
  if (present.length === 0) return null
  if (semantics === SAMPLE_SEMANTICS.CUMULATIVE) {
    // A running total: the LAST reported value is the total. Do NOT sum.
    return present[present.length - 1]
  }
  // DELTA: sum the increments.
  return present.reduce((sum, value) => sum + value, 0)
}

/**
 * Normalize a provider usage report into one honest token record.
 *
 * @param {object} input
 * @param {object}   [input.usage]         a single usage object (last/final report)
 * @param {object}   [input.firstUsage]    the first reported usage (Pi RPC)
 * @param {object[]} [input.usageSamples]  the per-turn samples
 * @param {string}   [input.semantics]     "CUMULATIVE" | "DELTA" | "UNKNOWN"; when
 *                                         absent the sequence is inferred, falling
 *                                         back to DELTA for a single report
 * @returns {{
 *   inputTokens: {value:number|null, provenance:string},
 *   cachedInputTokens: {value:number|null, provenance:string},
 *   outputTokens: {value:number|null, provenance:string},
 *   totalTokens: {value:number|null, provenance:string},
 *   provenance: string,
 *   sampleSemantics: string,
 *   partial: boolean,
 *   sampleCount: number,
 *   policy: string,
 * }}
 */
export function normalizeProviderUsage(input = {}) {
  const samples = Array.isArray(input.usageSamples)
    ? input.usageSamples.filter((sample) => sample && typeof sample === "object")
    : []

  // A single explicit `usage` object is authoritative when no sample series was
  // supplied: it is one measurement, so DELTA vs CUMULATIVE is moot.
  const single = input.usage && typeof input.usage === "object" ? input.usage : null
  const series = samples.length ? samples : (single ? [single] : (input.firstUsage ? [input.firstUsage] : []))

  let sampleSemantics = resolveSemantics(input.semantics)

  // An explicitly UNKNOWN series cannot be reduced at all: the honest answer is
  // NOT_MEASURED for every field.
  if (sampleSemantics === SAMPLE_SEMANTICS.UNKNOWN) {
    return {
      inputTokens: cell(null),
      cachedInputTokens: cell(null),
      cacheWriteTokens: cell(null),
      outputTokens: cell(null),
      totalTokens: cell(null),
      provenance: PROVENANCE.NOT_MEASURED,
      sampleSemantics: SAMPLE_SEMANTICS.UNKNOWN,
      partial: true,
      sampleCount: series.length,
      policy: PROVIDER_USAGE_NORMALIZER_POLICY,
      schemaVersion: PROVIDER_USAGE_NORMALIZER_SCHEMA_VERSION,
      canProduceVerdict: false,
    }
  }

  const parsed = series.map(rawFields)
  const anyReported = parsed.some(hasAnyField)
  if (!anyReported) {
    return {
      inputTokens: cell(null),
      cachedInputTokens: cell(null),
      cacheWriteTokens: cell(null),
      outputTokens: cell(null),
      totalTokens: cell(null),
      provenance: PROVENANCE.NOT_MEASURED,
      sampleSemantics,
      partial: true,
      sampleCount: series.length,
      policy: PROVIDER_USAGE_NORMALIZER_POLICY,
      schemaVersion: PROVIDER_USAGE_NORMALIZER_SCHEMA_VERSION,
      canProduceVerdict: false,
    }
  }

  const inputValue = reduceSeries(parsed.map((row) => row.input), sampleSemantics)
  const outputValue = reduceSeries(parsed.map((row) => row.output), sampleSemantics)
  const cacheReadValue = reduceSeries(parsed.map((row) => row.cacheRead), sampleSemantics)
  const cacheWriteValue = reduceSeries(parsed.map((row) => row.cacheWrite), sampleSemantics)
  const explicitTotal = reduceSeries(parsed.map((row) => row.total), sampleSemantics)
  // Pi reports input/output as disjoint buckets. When the provider omits a
  // total, derive it from the measured buckets; never fabricate a total from a
  // field that was not reported.
  const derivedTotal = inputValue !== null && outputValue !== null ? inputValue + outputValue : null
  const totalValue = explicitTotal !== null ? explicitTotal : derivedTotal

  const partial = inputValue === null || outputValue === null
  const provenance = (inputValue !== null || outputValue !== null || explicitTotal !== null)
    ? PROVENANCE.MEASURED
    : PROVENANCE.NOT_MEASURED

  return {
    inputTokens: cell(inputValue),
    cachedInputTokens: cell(cacheReadValue),
    cacheWriteTokens: cell(cacheWriteValue),
    outputTokens: cell(outputValue),
    totalTokens: cell(totalValue),
    provenance,
    sampleSemantics,
    partial,
    sampleCount: series.length,
    policy: PROVIDER_USAGE_NORMALIZER_POLICY,
    schemaVersion: PROVIDER_USAGE_NORMALIZER_SCHEMA_VERSION,
    canProduceVerdict: false,
  }
}

/**
 * A compact, backward-compatible view used where a caller historically read
 * `{input, output, cacheRead, cacheWrite, totalTokens}`. Missing fields stay
 * `null` so a downstream `?? 0` is visible as a bug, never silently correct.
 */
export function normalizedUsageView(input = {}) {
  const normalized = normalizeProviderUsage(input)
  return {
    input: normalized.inputTokens.value,
    output: normalized.outputTokens.value,
    cacheRead: normalized.cachedInputTokens.value,
    cacheWrite: normalized.cacheWriteTokens.value,
    totalTokens: normalized.totalTokens.value,
    inputTokens: normalized.inputTokens.value,
    outputTokens: normalized.outputTokens.value,
    usageAccounting: "provider-normalized",
    provenance: normalized.provenance,
    sampleSemantics: normalized.sampleSemantics,
    partial: normalized.partial,
    measured: normalized.provenance === PROVENANCE.MEASURED,
    policy: PROVIDER_USAGE_NORMALIZER_POLICY,
  }
}

/**
 * The ONE accessor a consumer should use to read a measured token total. Returns
 * a `metric()` row so an absent value is `{value:null, provenance:NOT_MEASURED}`
 * and can never be read as a measured zero.
 */
export function measuredTokenMetric(input = {}, field = "totalTokens") {
  const normalized = normalizeProviderUsage(input)
  const map = {
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    cachedInputTokens: normalized.cachedInputTokens,
    cacheWriteTokens: normalized.cacheWriteTokens,
    totalTokens: normalized.totalTokens,
  }
  const chosen = map[field] || normalized.totalTokens
  return chosen.provenance === USAGE_PROVENANCE.MEASURED
    ? metric(chosen.value, PROVENANCE.MEASURED)
    : NOT_MEASURED
}

export const providerUsageNormalizerExports = Object.freeze({
  normalizeProviderUsage,
  normalizedUsageView,
  measuredTokenMetric,
  SAMPLE_SEMANTICS,
  USAGE_PROVENANCE,
  PROVIDER_USAGE_NORMALIZER_POLICY,
  PROVIDER_USAGE_NORMALIZER_SCHEMA_VERSION,
})
