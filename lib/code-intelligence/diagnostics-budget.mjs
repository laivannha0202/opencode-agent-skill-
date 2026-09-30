// Adaptive diagnostics budget (V15.2 performance hardening).
//
// Language servers publish diagnostics asynchronously after a document sync, so
// a single fixed timeout is either wasteful on small files or too tight on large
// ones. This module derives a bounded, deterministic budget from observable
// workload signals. It never trusts a model-chosen timeout: every input comes
// from the runtime (file size, line count, provider identity, pooled cold/warm
// state, previously observed durations) and every result is clamped.

const DEFAULT_MIN_MS = 1_200
const DEFAULT_MAX_MS = 30_000

const HISTORY_LIMIT = 64
const HISTORY_SAMPLES = 5
const MAX_TIMEOUT_ESCALATIONS = 2
const MAX_TIMEOUT_ESCALATION_FACTOR = 4
const OBSERVED_HEADROOM_FACTOR = 2.5

export const DIAGNOSTICS_WORKLOAD_BUCKETS = Object.freeze([
  Object.freeze({ bucket: "xs", maxBytes: 4 * 1024, baseMs: 2_500 }),
  Object.freeze({ bucket: "s", maxBytes: 32 * 1024, baseMs: 5_000 }),
  Object.freeze({ bucket: "m", maxBytes: 128 * 1024, baseMs: 9_000 }),
  Object.freeze({ bucket: "l", maxBytes: 512 * 1024, baseMs: 16_000 }),
  Object.freeze({ bucket: "xl", maxBytes: Number.POSITIVE_INFINITY, baseMs: 25_000 }),
])

// Providers differ sharply in how long a first analysis takes. The factor is a
// fixed multiplier, never a per-call override.
export const DIAGNOSTICS_PROVIDER_FACTORS = Object.freeze({
  "typescript-language-server": 1,
  "pyright-langserver": 1,
  pylsp: 1.25,
  gopls: 1.25,
  "rust-analyzer": 1.5,
  clangd: 1.25,
})

const COLD_SESSION_FACTOR = 2
// A slow-initializing server will also analyze slowly, and `coldStartMs` is
// measured by the pool before the operation runs. This is the strongest
// available pre-request signal, so it scales the cold budget deterministically.
const STARTUP_FACTOR_PER_MS = 1 / 2_500
const MAX_STARTUP_FACTOR = 3
const HISTORY = new Map()

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function diagnosticsBudgetBounds(options = {}) {
  const env = options.env || process.env
  const minMs = boundedInt(options.minMs ?? env.UES_DIAGNOSTICS_BUDGET_MIN_MS, DEFAULT_MIN_MS, 250, 30_000)
  const maxMs = boundedInt(options.maxMs ?? env.UES_DIAGNOSTICS_BUDGET_MAX_MS, DEFAULT_MAX_MS, 2_000, 120_000)
  return { minMs, maxMs: Math.max(minMs, maxMs) }
}

export function diagnosticsWorkloadClass(input = {}) {
  const bytes = Math.max(0, Number(input.bytes || 0))
  const lineCount = input.lineCount == null ? null : Math.max(0, Math.trunc(Number(input.lineCount)))
  const row = DIAGNOSTICS_WORKLOAD_BUCKETS.find((item) => bytes <= item.maxBytes)
    || DIAGNOSTICS_WORKLOAD_BUCKETS[DIAGNOSTICS_WORKLOAD_BUCKETS.length - 1]
  return { bucket: row.bucket, baseMs: row.baseMs, bytes, lineCount }
}

function historyEntry(key) {
  if (!key) return null
  const existing = HISTORY.get(String(key))
  return existing || null
}

export function diagnosticsBudgetHistory(key) {
  const entry = historyEntry(key)
  if (!entry) return { timeouts: 0, samples: [] }
  return { timeouts: entry.timeouts, samples: [...entry.samples] }
}

export function recordDiagnosticsOutcome(key, outcome = {}) {
  if (!key) return null
  const id = String(key)
  const entry = HISTORY.get(id) || { timeouts: 0, samples: [] }
  if (HISTORY.size >= HISTORY_LIMIT && !HISTORY.has(id)) {
    const oldest = HISTORY.keys().next().value
    if (oldest) HISTORY.delete(oldest)
  }
  if (outcome.timedOut === true) {
    entry.timeouts += 1
  } else {
    const durationMs = Number(outcome.durationMs)
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      entry.samples.push(Math.trunc(durationMs))
      if (entry.samples.length > HISTORY_SAMPLES) entry.samples.splice(0, entry.samples.length - HISTORY_SAMPLES)
    }
  }
  HISTORY.set(id, entry)
  return diagnosticsBudgetHistory(id)
}

export function resetDiagnosticsBudgetHistory() {
  HISTORY.clear()
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function resolveDiagnosticsBudget(input = {}) {
  const bounds = diagnosticsBudgetBounds(input)
  const workload = diagnosticsWorkloadClass(input)
  const providerFactor = DIAGNOSTICS_PROVIDER_FACTORS[String(input.providerId || "")] ?? 1
  const coldSession = input.coldSession === true
  const startupMs = Number(input.startupMs)
  const startupFactor = coldSession && Number.isFinite(startupMs) && startupMs > 0
    ? Math.max(1, Math.min(MAX_STARTUP_FACTOR, 1 + startupMs * STARTUP_FACTOR_PER_MS))
    : 1
  const history = diagnosticsBudgetHistory(input.historyKey)
  const observedMs = history.samples.length ? Math.round(median(history.samples)) : null
  const escalations = Math.min(history.timeouts, MAX_TIMEOUT_ESCALATIONS)
  const historyFactor = Math.min(MAX_TIMEOUT_ESCALATION_FACTOR, 2 ** escalations)

  const explicitMs = Number(input.explicitMs)
  const hasExplicit = Number.isFinite(explicitMs) && explicitMs > 0
  const baseMs = hasExplicit ? explicitMs : workload.baseMs
  const source = hasExplicit ? "explicit" : "workload-bucket"

  const observedBudget = observedMs == null ? null : observedMs * OBSERVED_HEADROOM_FACTOR
  const scaled = Math.max(
    baseMs,
    observedBudget == null ? 0 : observedBudget,
  ) * providerFactor * (coldSession ? COLD_SESSION_FACTOR * startupFactor : 1) * historyFactor
  const budgetMs = boundedInt(scaled, baseMs, bounds.minMs, bounds.maxMs)

  return {
    budgetMs,
    source,
    policy: String(input.policy || "adaptive-diagnostics-v2"),
    bucket: workload.bucket,
    bytes: workload.bytes,
    lineCount: workload.lineCount,
    providerId: input.providerId == null ? null : String(input.providerId),
    providerFactor,
    coldSession,
    startupMs: Number.isFinite(startupMs) && startupMs > 0 ? Math.trunc(startupMs) : null,
    startupFactor,
    historyFactor,
    historyTimeouts: history.timeouts,
    observedMs,
    baseMs,
    bounds,
    historyKey: input.historyKey == null ? null : String(input.historyKey),
  }
}
