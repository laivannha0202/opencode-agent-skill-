import { readTaskTelemetry } from "./run-telemetry.mjs"
import { createHash } from "node:crypto"
import { observePrefixDrift } from "./prefix-drift-guard-v16-6.mjs"

const CACHE = new Map()

// V16.5 cache-stable prefix fingerprints: hash the stable leading blocks of
// the provider request (system prompt, project instructions) after redacting
// volatile tokens (run ids, timestamps, tmp paths). Cosmetic churn must not
// break prefix-cache stability measurement; real instruction edits must.

export function redactVolatilePrefixTokens(text = "") {
  let value = String(text || "").replace(/\r\n/g, "\n")
  const patterns = [
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    /\b(run|trace|span|session|request|artifact|handle)[-_ ]?(id)?[:=]?\s*[A-Za-z0-9_.:-]{6,}/gi,
    /\b20\d\d-\d\d-\d\d[T ]\d\d:\d\d(:\d\d)?(\.\d+)?(Z|[+-]\d\d:?\d\d)?/g,
    /\b\d{13,}\b/g,
    /(ues-pi-[A-Za-z0-9]+|[A-Za-z0-9]+\.\d+\.\d+\.tmp)/g,
    /(\/tmp\/|\\Temp\\|\.ues-cache[\/\\])[^\s"']*/g,
    /\bpid\s*[:=]?\s*\d+/gi,
  ]
  for (const pattern of patterns) value = value.replace(pattern, "<volatile>")
  return value
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function fingerprintStablePrefix(text = "") {
  const redacted = redactVolatilePrefixTokens(text)
  if (!redacted) return null
  return "prefix:sha256:" + createHash("sha256").update(redacted).digest("hex")
}

// System prefix = the exact system text UES contributes to the child session
// (agent prompt file + Pi host bridge). Stable per agent across attempts.
export function stableSystemPrefix(systemPrompt = "") {
  const hash = fingerprintStablePrefix(systemPrompt)
  return {
    schemaVersion: 1,
    kind: "system-prefix",
    hash,
    evidence: hash ? "FINGERPRINTED" : "NO_SYSTEM_PREFIX",
  }
}

// Project-instruction prefix = stable workspace-level instruction text visible
// to the child session (workspace AGENTS.md as Pi loads it from the child
// cwd). Null when the workspace carries no such file.
export function stableProjectPrefix(projectInstructions = "") {
  const hash = fingerprintStablePrefix(projectInstructions)
  return {
    schemaVersion: 1,
    kind: "project-prefix",
    hash,
    evidence: hash ? "FINGERPRINTED" : "NO_PROJECT_PREFIX",
  }
}

function prefixHashStats(hashes = []) {
  const series = (hashes || []).map((value) => String(value || "").trim()).filter(Boolean)
  let stableTransitions = 0
  for (let index = 1; index < series.length; index += 1) {
    if (series[index] === series[index - 1]) stableTransitions += 1
  }
  const transitions = Math.max(0, series.length - 1)
  return {
    samples: series.length,
    transitions,
    stableTransitions,
    stableRatio: transitions ? stableTransitions / transitions : series.length === 1 ? 1 : null,
    distinct: new Set(series).size,
  }
}

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
  const provider = String(options.provider || "")
  const usageAccounting = String(options.usageAccounting || "pi-normalized-disjoint")
  const minSamples = Math.max(1, Math.trunc(Number(options.minSamples || 6)))
  const stableSamples = Math.max(minSamples, Math.trunc(Number(options.stableSamples || 12)))
  const previousMode = ["cache", "balanced", "token"].includes(String(options.previousMode || ""))
    ? String(options.previousMode)
    : null
  const filtered = rows.filter((row) => {
    if (row?.type !== "task.telemetry") return false
    if (model && String(row?.model || "") !== model) return false
    if (provider && String(row?.provider || "") !== provider) return false
    const rowAccounting = String(row?.metrics?.usageAccounting || "")
    if (usageAccounting && rowAccounting !== usageAccounting) return false
    return true
  })
  let measured = 0
  let partial = 0
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let promptTotal = 0
  const schemaPrefixHashes = filtered
    .map((row) => String(row?.metrics?.schemaPrefixHash || "").trim())
    .filter(Boolean)
  const schemaStats = prefixHashStats(schemaPrefixHashes)
  const schemaPrefixStableTransitions = schemaStats.stableTransitions
  const schemaPrefixTransitions = schemaStats.transitions
  const schemaPrefixStableRatio = schemaStats.stableRatio
  const distinctSchemaPrefixes = schemaStats.distinct
  // V16.5 system/project prefix telemetry: same consecutive-stability
  // measurement over the stable leading blocks of the provider request.
  const systemStats = prefixHashStats(filtered.map((row) => row?.metrics?.systemPrefixHash))
  const projectStats = prefixHashStats(filtered.map((row) => row?.metrics?.projectPrefixHash))
  for (const row of filtered) {
    const i = finite(row?.metrics?.inputTokens)
    const cr = finite(row?.metrics?.cacheReadTokens)
    const cw = finite(row?.metrics?.cacheWriteTokens)
    if (i == null || cr == null || cw == null) {
      if ([i, cr, cw].some((value) => value != null)) partial += 1
      continue
    }
    measured += 1
    const uncached = Math.max(0, i)
    const read = Math.max(0, cr)
    const write = Math.max(0, cw)
    input += uncached
    cacheRead += read
    cacheWrite += write
    // Pi Usage counters are disjoint: input + cacheRead + cacheWrite is the
    // provider-attributed prompt-side token volume. Do not divide cacheRead by
    // input alone; that can exceed 100% on a healthy cached request.
    promptTotal += uncached + read + write
  }
  const cacheReadRatio = promptTotal > 0 ? clamp(cacheRead / promptTotal, 0, 1) : null
  // V16.6 prefix drift guard: compare the latest observed {system, project,
  // tool-schema} prefix triple against the previous observation for the same
  // provider/model. Only runs when the caller asks for drift tracking so the
  // pure row-fold stays side-effect free by default.
  const lastMetric = (metricKey) => {
    for (let index = filtered.length - 1; index >= 0; index -= 1) {
      const value = String(filtered[index]?.metrics?.[metricKey] || "").trim()
      if (value) return value
    }
    return null
  }
  let prefixDrift = null
  let mode = "neutral"
  let reason = "insufficient-complete-provider-cache-telemetry"
  if (measured >= minSamples && cacheReadRatio != null) {
    const stable = measured >= stableSamples
    if (previousMode === "cache" && cacheReadRatio >= 0.30) {
      mode = "cache"
      reason = "measured-cache-hysteresis"
    } else if (previousMode === "token" && cacheReadRatio <= 0.20) {
      mode = "token"
      reason = "measured-token-hysteresis"
    } else if (cacheReadRatio >= (stable ? 0.45 : 0.55)) {
      mode = "cache"
      reason = stable ? "measured-prefix-cache-benefit" : "candidate-prefix-cache-benefit"
    } else if (cacheReadRatio <= (stable ? 0.10 : 0.05)) {
      mode = "token"
      reason = stable ? "measured-low-prefix-cache-benefit" : "candidate-low-prefix-cache-benefit"
    } else {
      mode = "balanced"
      reason = stable ? "measured-mixed-cache-benefit" : "candidate-mixed-cache-benefit"
    }
  }
  if (options.trackDrift === true) {
    const prefixMode = mode === "cache" ? "CACHE" : mode === "token" ? "TOKEN" : "BALANCED"
    prefixDrift = observePrefixDrift({
      provider: provider || null,
      model: model || null,
      mode: prefixMode,
      systemPrefixHash: lastMetric("systemPrefixHash"),
      projectPrefixHash: lastMetric("projectPrefixHash"),
      toolSchemaPrefixHash: lastMetric("schemaPrefixHash"),
      stableTransitionRatio: systemStats.stableRatio,
      cacheReadRatio,
      env: options.env || process.env,
    })
  }
  return {
    schemaVersion: 4,
    model: model || null,
    provider: provider || null,
    mode,
    reason,
    samples: measured,
    partialSamples: partial,
    inputTokens: measured ? input : null,
    cacheReadTokens: measured ? cacheRead : null,
    cacheWriteTokens: measured ? cacheWrite : null,
    promptSideTokens: measured ? promptTotal : null,
    cacheReadRatio,
    usageAccounting,
    minSamples,
    stableSamples,
    previousMode,
    schemaPrefixSamples: schemaStats.samples,
    schemaPrefixTransitions,
    schemaPrefixStableTransitions,
    schemaPrefixStableRatio,
    distinctSchemaPrefixes,
    systemPrefixSamples: systemStats.samples,
    systemPrefixTransitions: systemStats.transitions,
    systemPrefixStableTransitions: systemStats.stableTransitions,
    systemPrefixStableRatio: systemStats.stableRatio,
    distinctSystemPrefixes: systemStats.distinct,
    projectPrefixSamples: projectStats.samples,
    projectPrefixTransitions: projectStats.transitions,
    projectPrefixStableTransitions: projectStats.stableTransitions,
    projectPrefixStableRatio: projectStats.stableRatio,
    distinctProjectPrefixes: projectStats.distinct,
    // V16.6 prefix drift guard report (null unless options.trackDrift).
    prefixDrift,
    // UES never rewrites already-admitted history in this policy. "token"
    // mode only tightens the newly produced live-zone presentation budget.
    preserveStablePrefix: true,
    compactLiveZoneOnly: true,
    evidence: measured >= minSamples ? "MEASURED" : "NOT_MEASURED",
  }
}

export async function providerCacheStabilityPolicy(root = process.cwd(), options = {}) {
  const minSamples = Math.max(1, Math.trunc(Number(options.minSamples || 6)))
  const stableSamples = Math.max(minSamples, Math.trunc(Number(options.stableSamples || 12)))
  const limit = Math.max(20, Math.min(1000, Number(options.limit || 200)))
  const usageAccounting = String(options.usageAccounting || "pi-normalized-disjoint")
  const key = [
    String(root),
    String(options.provider || ""),
    String(options.model || ""),
    usageAccounting,
    String(minSamples),
    String(stableSamples),
    String(limit),
    options.trackDrift === true ? "drift" : "nodrift",
  ].join("\0")
  const ttlMs = Math.max(1000, Math.min(5 * 60_000, Number(options.ttlMs || 30_000)))
  const now = Date.now()
  const cached = CACHE.get(key)
  if (cached && now - cached.at <= ttlMs) return cached.value
  const rows = await readTaskTelemetry(root, {
    limit,
  })
  const value = cacheStabilityFromRows(rows, {
    ...options,
    minSamples,
    stableSamples,
    usageAccounting,
    previousMode: options.previousMode || cached?.value?.mode || null,
  })
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
