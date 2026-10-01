import { readTaskTelemetry } from "./run-telemetry.mjs"

const CACHE = new Map()

function finite(value) {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)))
}

export function cacheStabilityFromRows(rows = [], options = {}) {
  const model = String(options.model || "")
  const minSamples = Math.max(1, Math.trunc(Number(options.minSamples || 4)))
  const filtered = rows.filter((row) => {
    if (row?.type !== "task.telemetry") return false
    if (!model) return true
    return String(row?.model || "") === model
  })
  let measured = 0
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let promptTotal = 0
  for (const row of filtered) {
    const i = finite(row?.metrics?.inputTokens)
    const cr = finite(row?.metrics?.cacheReadTokens)
    const cw = finite(row?.metrics?.cacheWriteTokens)
    if (i == null || cr == null) continue
    measured += 1
    const uncached = Math.max(0, i)
    const read = Math.max(0, cr)
    const write = Math.max(0, cw || 0)
    input += uncached
    cacheRead += read
    cacheWrite += write
    // Pi Usage counters are disjoint: input + cacheRead + cacheWrite is the
    // provider-attributed prompt-side token volume. Do not divide cacheRead by
    // input alone; that can exceed 100% on a healthy cached request.
    promptTotal += uncached + read + write
  }
  const cacheReadRatio = promptTotal > 0 ? clamp(cacheRead / promptTotal, 0, 1) : null
  let mode = "neutral"
  let reason = "insufficient-provider-cache-telemetry"
  if (measured >= minSamples && cacheReadRatio != null) {
    if (cacheReadRatio >= 0.45) {
      mode = "cache"
      reason = "measured-prefix-cache-benefit"
    } else if (cacheReadRatio <= 0.10) {
      mode = "token"
      reason = "measured-low-prefix-cache-benefit"
    } else {
      mode = "balanced"
      reason = "measured-mixed-cache-benefit"
    }
  }
  return {
    schemaVersion: 1,
    model: model || null,
    mode,
    reason,
    samples: measured,
    inputTokens: measured ? input : null,
    cacheReadTokens: measured ? cacheRead : null,
    cacheWriteTokens: measured ? cacheWrite : null,
    promptSideTokens: measured ? promptTotal : null,
    cacheReadRatio,
    usageAccounting: "pi-normalized-disjoint",
    // UES never rewrites already-admitted history in this policy. "token"
    // mode only tightens the newly produced live-zone presentation budget.
    preserveStablePrefix: true,
    compactLiveZoneOnly: true,
    evidence: measured >= minSamples ? "MEASURED" : "NOT_MEASURED",
  }
}

export async function providerCacheStabilityPolicy(root = process.cwd(), options = {}) {
  const key = String(root) + "\0" + String(options.model || "")
  const ttlMs = Math.max(1000, Math.min(5 * 60_000, Number(options.ttlMs || 30_000)))
  const now = Date.now()
  const cached = CACHE.get(key)
  if (cached && now - cached.at <= ttlMs) return cached.value
  const rows = await readTaskTelemetry(root, {
    limit: Math.max(20, Math.min(1000, Number(options.limit || 200))),
  })
  const value = cacheStabilityFromRows(rows, options)
  CACHE.set(key, { at: now, value })
  return value
}

export function clearProviderCachePolicyCache() {
  CACHE.clear()
}

export function cacheAwareVisibleBudget(baseMaxChars, route = {}, policy = {}) {
  const base = Math.max(8 * 1024, Math.min(256 * 1024, Math.trunc(Number(baseMaxChars || 24 * 1024))))
  const routeMultiplier = Number.isFinite(Number(route?.budgetMultiplier))
    ? Number(route.budgetMultiplier)
    : 1
  // Only the live zone is reduced. A cache-oriented policy does not rewrite
  // already-admitted history merely to save visible bytes.
  const cacheMultiplier = policy?.mode === "cache" ? 0.90 : policy?.mode === "token" ? 0.80 : 1
  return Math.max(8 * 1024, Math.min(128 * 1024, Math.trunc(base * routeMultiplier * cacheMultiplier)))
}
