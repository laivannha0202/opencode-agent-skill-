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

// Request-id ledger that makes "exactly one terminal outcome per diagnostics
// request" a property of this module rather than a promise made by each caller.
//
// The tier A / tier B race has several legitimate exits and one request can pass
// through more than one of them (an incomplete tier B that settles mid-race, a
// continuation that later times out). Previously every exit recorded, so a single
// request could add both a sample and a timeout to the history and inflate the
// next request's budget twice. Recording is now idempotent per request id.
const RECORDED_REQUESTS = new Map()
const RECORDED_REQUEST_LIMIT = 256
const LAST_OUTCOME_SAMPLES = 4

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
  if (!entry) return { timeouts: 0, samples: [], outcomes: [] }
  return {
    timeouts: entry.timeouts,
    samples: [...entry.samples],
    outcomes: [...(entry.outcomes || [])],
  }
}

// Stable diagnostics history identity (V3).
//
// The previous key was `${sessionId}:${uri}`. `sessionId` is a `randomUUID()`
// minted per language-server process, so every idle-TTL eviction, crash-bounded
// restart or config-driven re-acquisition silently threw away everything that had
// been learned, even though the workspace, provider, configuration and file were
// all unchanged. Learning therefore never survived a session replacement, which
// is the exact case adaptive budgets exist for.
//
// The identity is now derived from the workload, not from the process:
//
//   workspace + provider + configFingerprint + relative file + cold/warm class
//
// - `configFingerprint` is the pool's own hash of the provider identity plus the
//   discovered config files (tsconfig.json, package.json, ...), so a relevant
//   configuration change produces a different key and stale timings are dropped
//   rather than reused.
// - `workspace` keeps two checkouts of the same repository apart; timings from
//   one are not evidence about the other.
// - `cold`/`warm` are kept separate because they are scaled by different factors
//   in the formula below (COLD_SESSION_FACTOR * startupFactor), so pooling them
//   would feed warm timings into cold requests and vice versa.
export function diagnosticsHistoryKey(input = {}) {
  const workspace = String(input.workspace ?? "").trim()
  if (!workspace) return null
  const provider = String(input.providerId ?? input.provider ?? "")
  const fingerprint = String(input.configFingerprint ?? "none")
  const file = String(input.file ?? "").replaceAll("\\", "/")
  const workloadClass = input.coldSession === true ? "cold" : "warm"
  return [workspace, provider, fingerprint, workloadClass, file].join("\u0000")
}

export function recordDiagnosticsOutcome(key, outcome = {}) {
  if (!key) return null
  const id = String(key)

  // Idempotence: a request id may contribute at most one terminal outcome.
  const requestId = outcome.requestId == null ? null : String(outcome.requestId)
  if (requestId) {
    if (RECORDED_REQUESTS.has(requestId)) return diagnosticsBudgetHistory(id)
    if (RECORDED_REQUESTS.size >= RECORDED_REQUEST_LIMIT) {
      const oldest = RECORDED_REQUESTS.keys().next().value
      if (oldest != null) RECORDED_REQUESTS.delete(oldest)
    }
    RECORDED_REQUESTS.set(requestId, id)
  }

  const entry = HISTORY.get(id) || { timeouts: 0, samples: [], outcomes: [] }
  if (HISTORY.size >= HISTORY_LIMIT && !HISTORY.has(id)) {
    const oldest = HISTORY.keys().next().value
    if (oldest) HISTORY.delete(oldest)
  }

  const timedOut = outcome.timedOut === true
  const durationMs = Number(outcome.durationMs)

  if (timedOut) {
    entry.timeouts += 1
  } else if (Number.isFinite(durationMs) && durationMs >= 0) {
    // Only the *actual* observed duration is admitted. A configured budget, an
    // initial-window timeout or an intermediate race exit is not evidence of how
    // long this workload takes, and feeding one back in inflated the next
    // request's budget on every call (observed: 2500ms -> 6250ms).
    entry.samples.push(Math.trunc(durationMs))
    if (entry.samples.length > HISTORY_SAMPLES) entry.samples.splice(0, entry.samples.length - HISTORY_SAMPLES)
  }

  // Terminal evidence kept alongside the aggregates, so the recorded outcome can
  // be audited without re-running the operation.
  entry.outcomes = entry.outcomes || []
  entry.outcomes.push({
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.trunc(durationMs) : null,
    timedOut,
    complete: outcome.complete === true,
    source: outcome.source == null ? null : String(outcome.source),
    cold: outcome.coldSession === true,
  })
  if (entry.outcomes.length > LAST_OUTCOME_SAMPLES) {
    entry.outcomes.splice(0, entry.outcomes.length - LAST_OUTCOME_SAMPLES)
  }

  HISTORY.set(id, entry)
  return diagnosticsBudgetHistory(id)
}

export function resetDiagnosticsBudgetHistory() {
  HISTORY.clear()
  RECORDED_REQUESTS.clear()
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
