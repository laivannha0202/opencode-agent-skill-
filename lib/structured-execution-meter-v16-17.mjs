// V16.17.1 structured-execution measurement bridge.
//
// This module owns no budget, verdict, scheduling, or timeout policy. It is a
// bounded transport for measurements/absolute deadlines that already have a
// canonical owner but must cross lazy module boundaries without duplicating
// policy in the Pi controller.
//
// Laws:
// - run deadlines are absolute epoch-ms values and may only narrow work;
// - wave-context measurements are MEASURED characters only, never token claims;
// - at most one pending context measurement exists per run (latest attempt wins);
// - all state is bounded and stale entries are pruned opportunistically.

export const STRUCTURED_EXECUTION_METER_POLICY = "structured-execution-meter-v16-17"
export const STRUCTURED_EXECUTION_METER_SCHEMA_VERSION = 1

const MAX_RUNS = 64
const MAX_AGE_MS = 12 * 60 * 60_000

const deadlines = new Map()
const pendingContext = new Map()

function finiteNonNegative(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function prune(now = Date.now()) {
  for (const [runId, row] of deadlines) {
    if (!row || row.expiresAt < now - MAX_AGE_MS) deadlines.delete(runId)
  }
  for (const [runId, row] of pendingContext) {
    if (!row || row.recordedAt < now - MAX_AGE_MS) pendingContext.delete(runId)
  }
  while (deadlines.size > MAX_RUNS) deadlines.delete(deadlines.keys().next().value)
  while (pendingContext.size > MAX_RUNS) pendingContext.delete(pendingContext.keys().next().value)
}

export function registerStructuredRunDeadline(input = {}) {
  const runId = String(input.runId || "").trim()
  const deadlineAt = finiteNonNegative(input.deadlineAt)
  if (!runId || deadlineAt === null) return null
  const now = Date.now()
  prune(now)
  const existing = deadlines.get(runId)
  // A later writer may only tighten an existing run deadline, never extend it.
  const expiresAt = existing && Number.isFinite(existing.expiresAt)
    ? Math.min(existing.expiresAt, deadlineAt)
    : deadlineAt
  const row = Object.freeze({
    schemaVersion: STRUCTURED_EXECUTION_METER_SCHEMA_VERSION,
    policy: STRUCTURED_EXECUTION_METER_POLICY,
    runId,
    expiresAt,
    recordedAt: now,
  })
  deadlines.set(runId, row)
  return row
}

export function resolveStructuredRunDeadline(runId) {
  const key = String(runId || "").trim()
  if (!key) return null
  const now = Date.now()
  prune(now)
  const row = deadlines.get(key)
  if (!row) return null
  // Keep an expired deadline readable: consumers must fail closed rather than
  // treating expiry as "no deadline". Opportunistic pruning removes it later.
  return Number.isFinite(row.expiresAt) ? row.expiresAt : null
}

export function recordStructuredContextMeasurement(input = {}) {
  const runId = String(input.runId || "").trim()
  const chars = finiteNonNegative(input.chars)
  if (!runId || chars === null || input.provenance !== "MEASURED") return null
  const now = Date.now()
  prune(now)
  const row = Object.freeze({
    schemaVersion: STRUCTURED_EXECUTION_METER_SCHEMA_VERSION,
    policy: STRUCTURED_EXECUTION_METER_POLICY,
    runId,
    snapshotId: input.snapshotId == null ? null : String(input.snapshotId),
    waveId: input.waveId == null ? null : String(input.waveId),
    chars,
    provenance: "MEASURED",
    providerTokens: null,
    providerTokenProvenance: "NOT_MEASURED",
    recordedAt: now,
  })
  // Structured execution is wave-serial at this boundary. Overwrite instead of
  // queueing so an infrastructure failure before settlement cannot make a later
  // retry consume stale context accounting from the previous attempt.
  pendingContext.set(runId, row)
  return row
}

export function consumeStructuredContextMeasurement(runId) {
  const key = String(runId || "").trim()
  if (!key) return null
  prune(Date.now())
  const row = pendingContext.get(key) || null
  if (row) pendingContext.delete(key)
  return row
}

export function clearStructuredExecutionMeter(runId) {
  const key = String(runId || "").trim()
  if (!key) return false
  const a = deadlines.delete(key)
  const b = pendingContext.delete(key)
  return a || b
}

export function structuredExecutionMeterStatus() {
  prune(Date.now())
  return {
    schemaVersion: STRUCTURED_EXECUTION_METER_SCHEMA_VERSION,
    policy: STRUCTURED_EXECUTION_METER_POLICY,
    deadlines: deadlines.size,
    pendingContext: pendingContext.size,
    maxRuns: MAX_RUNS,
  }
}
