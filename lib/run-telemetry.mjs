import { createHash } from "node:crypto"
import { mkdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { appendRuntimeEvent, readRuntimeEvents } from "./runtime-events.mjs"
import { recordEfficiencyEvent } from "./efficiency-ledger.mjs"
// V16.6 measurement provenance. Every optimization number is labeled; an
// unmeasured value is explicitly NOT_MEASURED instead of guessed.
import { metric, NOT_MEASURED } from "./measurement-provenance.mjs"

const TELEMETRY_DIR = ".ues-learning"
const TELEMETRY_FILE = "task-telemetry-v1.jsonl"

const TELEMETRY_LOCK_STALE_MS = 15_000
const TELEMETRY_LOCK_WAIT_MS = 30_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTelemetryLock(file, fn) {
  const lockDir = file + ".lock"
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + TELEMETRY_LOCK_WAIT_MS
  let delay = 5
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockDir).catch(() => null)
      if (info && Date.now() - info.mtimeMs > TELEMETRY_LOCK_STALE_MS) {
        const confirmed = await stat(lockDir).catch(() => null)
        if (confirmed && confirmed.mtimeMs === info.mtimeMs && confirmed.size === info.size) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) {
        const lockError = new Error("Timed out waiting for UES task telemetry lock")
        lockError.code = "UES_TASK_TELEMETRY_LOCK_TIMEOUT"
        throw lockError
      }
      await sleep(delay)
      delay = Math.min(80, delay * 2)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

function finite(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = finite(value)
    if (parsed !== null) return parsed
  }
  return null
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex")
}

function tokenMetrics(usage = {}) {
  // Pi RPC/eval emits compact aliases while OpenAI-compatible providers often
  // emit *Tokens or snake_case. Missing values stay null; never fake zero.
  const inputTokens = firstFinite(usage.input, usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens)
  const outputTokens = firstFinite(usage.output, usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens)
  const cacheReadTokens = firstFinite(usage.cacheRead, usage.cacheReadTokens, usage.cache_read_tokens, usage.cachedInputTokens, usage.cached_input_tokens)
  const cacheWriteTokens = firstFinite(usage.cacheWrite, usage.cacheWriteTokens, usage.cache_write_tokens)
  const explicitTotal = firstFinite(usage.totalTokens, usage.total_tokens)
  // Pi reports input/output and cache read/write as disjoint buckets. Keep
  // totalTokens compatible with the historical provider-token contract:
  // total = input + output. Cache buckets remain separately measurable and must
  // not be double-counted into the aggregate when the provider omits a total.
  const derivedTotal = inputTokens !== null && outputTokens !== null
    ? inputTokens + outputTokens
    : null
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: explicitTotal ?? derivedTotal,
    usageAccounting: "pi-normalized-disjoint",
  }
}

export function aggregateUsageSamples(samples = []) {
  const rows = Array.isArray(samples) ? samples : []
  const sums = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  }
  const seen = {
    inputTokens: false,
    outputTokens: false,
    cacheReadTokens: false,
    cacheWriteTokens: false,
    totalTokens: false,
  }
  for (const sample of rows) {
    if (!sample || typeof sample !== "object") continue
    const normalized = tokenMetrics(sample)
    for (const key of Object.keys(sums)) {
      const value = normalized[key]
      if (value === null) continue
      sums[key] += value
      seen[key] = true
    }
  }
  if (!Object.values(seen).some(Boolean)) return null
  return {
    input: seen.inputTokens ? sums.inputTokens : null,
    output: seen.outputTokens ? sums.outputTokens : null,
    cacheRead: seen.cacheReadTokens ? sums.cacheReadTokens : null,
    cacheWrite: seen.cacheWriteTokens ? sums.cacheWriteTokens : null,
    totalTokens: seen.totalTokens ? sums.totalTokens : null,
    usageAccounting: "pi-normalized-disjoint",
  }
}

export function taskTelemetryFile(root = process.cwd()) {
  return path.join(path.resolve(root), TELEMETRY_DIR, TELEMETRY_FILE)
}

/**
 * V16.6 telemetry block.
 *
 * Rules: a number without a provenance label is invalid, and anything we did
 * not observe is reported as NOT_MEASURED rather than estimated. The token and
 * latency "savings" stay NOT_MEASURED until scripts/eval-v16-6.mjs produces a
 * real A/B measurement.
 */
function buildV166Telemetry(budget, deepSeek) {
  if (!budget && !deepSeek) return null
  const row = budget || {}
  const turn = row.deepSeekTurnBudget || {}
  const consultation = deepSeek || {}
  const num = (value, provenance) => metric(
    Number.isFinite(Number(value)) ? Number(value) : null,
    provenance,
  )
  return {
    schemaVersion: 1,
    release: "v16.6",
    executionProfile: row.executionProfile ? String(row.executionProfile) : null,
    taskPolicyExecutionProfile: row.taskPolicyExecutionProfile ? String(row.taskPolicyExecutionProfile) : null,
    fingerprint: row.fingerprint ? String(row.fingerprint) : null,
    // Budget reasons are structured records: {signal, basis, impact}.
    reasons: Array.isArray(row.reasons)
      ? row.reasons.slice(0, 12).map((item) => (
        typeof item === "string"
          ? { signal: item, basis: null, impact: null }
          : { signal: String(item?.signal ?? ""), basis: item?.basis ? String(item.basis) : null, impact: Number(item?.impact) || 0 }
      ))
      : [],
    // Profile-granted numbers are POLICY facts, not measurements of this run.
    contextBudget: num(row.contextBudget, "DERIVED"),
    skillBudget: {
      maxSkills: num(row.skillBudget?.maxSkills, "DERIVED"),
      capsuleChars: num(row.skillBudget?.capsuleChars, "DERIVED"),
    },
    maxAdvertisedTools: num(row.maxAdvertisedTools, "DERIVED"),
    toolDescriptionProfile: row.toolDescriptionProfile ? String(row.toolDescriptionProfile) : null,
    deepSeekMode: row.deepSeekMode ? String(row.deepSeekMode) : null,
    deepSeekTurnBudget: {
      maxTurns: num(turn.maxTurns, "DERIVED"),
      effectiveMaxTurns: num(turn.effectiveMaxTurns, "DERIVED"),
      maxConsultations: num(turn.maxConsultations, "DERIVED"),
      maxFollowUps: num(turn.maxFollowUps, "DERIVED"),
      clampedByLaneSafety: turn.clampedByLaneSafety === true,
    },
    deepSeek: {
      turnsUsed: num(consultation.turnsUsed, "MEASURED"),
      consultations: num(consultation.consultations, "MEASURED"),
      followUps: num(consultation.followUps, "MEASURED"),
      cacheHits: num(consultation.cacheHits, "MEASURED"),
      cacheMisses: num(consultation.cacheMisses, "MEASURED"),
      rotations: num(consultation.rotations, "MEASURED"),
      refusals: Array.isArray(consultation.refusals) ? consultation.refusals.slice(0, 8).map(String) : [],
      tokensSaved: NOT_MEASURED,
      latencySavedMs: NOT_MEASURED,
    },
  }
}

export function buildTaskTelemetry(result = {}, options = {}) {
  const latency = result?.optimizations?.latencyMs || {}
  const timing = result?.timing || result?.timings || result?.telemetry?.timing || {}
  const diagnostics = result?.diagnosticsTelemetry || result?.telemetry?.diagnostics || {}
  const wallTimeMs = firstFinite(latency.total, result.durationMs)
  const workspaceSnapshotMs = firstFinite(latency.workspaceSnapshot)
  const contextBuildMs = firstFinite(latency.contextBuild)
  const agentRunMs = firstFinite(latency.modelRun)
  const hygieneMs = firstFinite(latency.hygiene)
  const exclusiveParts = [workspaceSnapshotMs, contextBuildMs, agentRunMs, hygieneMs].filter((value) => value !== null)
  const exclusiveMeasuredMs = exclusiveParts.length ? exclusiveParts.reduce((sum, value) => sum + value, 0) : null
  const timingConsistent = wallTimeMs === null || exclusiveMeasuredMs === null || exclusiveMeasuredMs <= wallTimeMs + 100
  const verdict = result.verdict == null ? null : String(result.verdict)
  const exitCode = finite(result.exitCode)
  const passed = options.passed === true || (
    options.passed !== false &&
    exitCode === 0 &&
    !["FAIL", "PARTIAL", "REVISE"].includes(String(verdict || "").toUpperCase())
  )
  const taskText = options.task ?? result.task ?? ""
  const aggregatedUsage = aggregateUsageSamples(result.usageSamples)
  const tokens = tokenMetrics(aggregatedUsage || result.usage || {})
  const hasProviderTokens = [
    tokens.inputTokens,
    tokens.outputTokens,
    tokens.cacheReadTokens,
    tokens.cacheWriteTokens,
    tokens.totalTokens,
  ].some((value) => value !== null)
  const advertisedToolNames = Array.isArray(result.allowedTools)
    ? [...new Set(result.allowedTools.map((item) => String(item || "")).filter(Boolean))].slice(0, 96)
    : []
  const usedToolNames = Array.isArray(result.toolNames)
    ? [...new Set(result.toolNames.map((item) => String(item || "")).filter(Boolean))].slice(0, 96)
    : []
  const advertisedSet = new Set(advertisedToolNames)
  const usedAdvertisedTools = usedToolNames.filter((name) => advertisedSet.has(name)).length
  const toolEconomy = result?.toolExposure?.economy || result?.optimizations?.toolSurfaceEconomy || {}
  const hydration = result?.toolExposure?.hydration || {}
  const prefixHashes = result?.toolExposure?.prefixHashes || {}
  const deferredToolNames = Array.isArray(toolEconomy?.deferred)
    ? [...new Set(toolEconomy.deferred.map((item) => String(item || "")).filter(Boolean))].slice(0, 96)
    : []
  const schemaTax = toolEconomy?.schemaTax || {}
  const strategy = result?.optimizations?.strategyProfile || {}
  // V16.6 unified-budget telemetry block. Additive: it never changes an
  // existing field, and every value carries its provenance so a reader can
  // tell a measurement from an estimate from an explicit non-measurement.
  const budget = result?.optimizations?.v16_6Budget || options.v16_6Budget || null
  const deepSeek = result?.optimizations?.deepSeek || options.deepSeek || null
  const v16_6 = buildV166Telemetry(budget, deepSeek)
  return {
    schemaVersion: 2,
    scope: String(options.scope || "specialist-run"),
    runId: options.runId ? String(options.runId) : null,
    traceID: options.traceID ? String(options.traceID) : null,
    taskId: options.taskId ? String(options.taskId) : null,
    taskHash: sha256(taskText),
    taskClass: options.taskClass ? String(options.taskClass) : null,
    agent: options.agent ? String(options.agent) : String(result.agent || "") || null,
    role: options.role ? String(options.role) : null,
    attempt: finite(options.attempt),
    model: options.model ? String(options.model) : (result.model ? String(result.model) : null),
    modelTier: result.modelTier ? String(result.modelTier) : null,
    provider: options.provider ? String(options.provider) : (result.provider ? String(result.provider) : null),
    thinking: options.thinking ? String(options.thinking) : (result.thinking ? String(result.thinking) : null),
    outcome: {
      passed,
      exitCode,
      verdict,
      stopReason: result.stopReason ? String(result.stopReason) : null,
      providerFailure: result.providerFailure ? String(result.providerFailure) : null,
      falsePassDetected: options.falsePassDetected == null ? null : options.falsePassDetected === true,
      verifierPass: options.verifierPass == null ? null : options.verifierPass === true,
    },
    metrics: {
      wallTimeMs, workspaceSnapshotMs, contextBuildMs, agentRunMs, hygieneMs,
      providerWaitMs: firstFinite(timing.providerWaitMs, latency.providerWaitMs, result.providerWaitMs),
      modelGenerationMs: firstFinite(timing.modelGenerationMs, latency.modelGenerationMs, result.modelGenerationMs),
      toolQueueMs: firstFinite(timing.toolQueueMs, result.toolQueueMs),
      toolRoutingMs: firstFinite(timing.toolRoutingMs, result.toolRoutingMs),
      toolExecutionMs: firstFinite(timing.toolExecutionMs, result.toolExecutionMs),
      toolResultProcessingMs: firstFinite(timing.toolResultProcessingMs, result.toolResultProcessingMs),
      lspAcquireMs: firstFinite(diagnostics.lspAcquireMs, timing.lspAcquireMs),
      lspSyncMs: firstFinite(diagnostics.lspSyncMs, timing.lspSyncMs),
      lspWaitForPushMs: firstFinite(diagnostics.lspWaitForPushMs, timing.lspWaitForPushMs),
      lspPullMs: firstFinite(diagnostics.lspPullMs, timing.lspPullMs),
      lspPrimaryMs: firstFinite(diagnostics.lspPrimaryMs, timing.lspPrimaryMs),
      lspFallbackMs: firstFinite(diagnostics.lspFallbackMs, timing.lspFallbackMs),
      verificationMs: firstFinite(timing.verificationMs, latency.verificationMs, result.verificationMs),
      lspPrimaryAttempts: firstFinite(diagnostics.lspPrimaryAttempts),
      lspPrimarySuccess: firstFinite(diagnostics.lspPrimarySuccess),
      lspPullAttempts: firstFinite(diagnostics.lspPullAttempts),
      lspPullSuccess: firstFinite(diagnostics.lspPullSuccess),
      lspFallbackAttempts: firstFinite(diagnostics.lspFallbackAttempts),
      lspFallbackSuccess: firstFinite(diagnostics.lspFallbackSuccess),
      diagnosticsBytes: firstFinite(diagnostics.bytes, diagnostics.diagnosticsBytes),
      diagnosticsFileSize: firstFinite(diagnostics.fileSize, diagnostics.diagnosticsFileSize),
      diagnosticsTemperature: diagnostics.coldOrWarm == null ? null : String(diagnostics.coldOrWarm),
      exclusiveMeasuredMs, timingConsistent,
      providerRetries: firstFinite(result.providerRecoveryAttempts) ?? 0,
      providerSessionResumes: firstFinite(result.providerSessionResumeAttempts) ?? 0,
      toolCalls: firstFinite(result.toolCalls) ?? 0,
      toolNames: usedToolNames,
      advertisedToolNames,
      usedToolNames,
      deferredToolNames,
      advertisedTools: advertisedToolNames.length,
      usedTools: usedAdvertisedTools,
      unusedAdvertisedTools: Math.max(0, advertisedToolNames.length - usedAdvertisedTools),
      deferredTools: deferredToolNames.length,
      toolUtilizationRatio: advertisedToolNames.length ? usedAdvertisedTools / advertisedToolNames.length : null,
      toolSchemaEstimatedChars: firstFinite(schemaTax.estimatedChars),
      toolSchemaEstimatedTokens: firstFinite(schemaTax.estimatedTokens),
      toolSchemaTaxEvidence: schemaTax.evidence ? String(schemaTax.evidence) : null,
      schemaPrefixHash: toolEconomy?.schemaPrefixHash ? String(toolEconomy.schemaPrefixHash) : null,
      hydrationDispatcher: hydration?.dispatcher || toolEconomy?.hydrationDispatcher ? String(hydration?.dispatcher || toolEconomy.hydrationDispatcher) : null,
      hydratedToolNames: Array.isArray(hydration?.hydrated) ? [...new Set(hydration.hydrated.map((item) => String(item || "")).filter(Boolean))].slice(0, 16) : [],
      hydratedTools: Array.isArray(hydration?.hydrated) ? hydration.hydrated.length : 0,
      hydrationDeniedCount: Number.isFinite(Number(hydration?.deniedCount)) ? Number(hydration.deniedCount) : 0,
      hydrationRequests: Number.isFinite(Number(hydration?.hydrationRequests)) ? Number(hydration.hydrationRequests) : 0,
      sameAttemptHydration: hydration?.sameAttempt === true,
      systemPrefixHash: prefixHashes?.systemPrefixHash ? String(prefixHashes.systemPrefixHash) : null,
      projectPrefixHash: prefixHashes?.projectPrefixHash ? String(prefixHashes.projectPrefixHash) : null,
      prefixHashEvidence: prefixHashes?.evidence ? String(prefixHashes.evidence) : null,
      editStrategy: strategy.editStrategy ? String(strategy.editStrategy) : null,
      searchStrategy: strategy.searchStrategy ? String(strategy.searchStrategy) : null,
      contextStrategy: strategy.contextStrategy ? String(strategy.contextStrategy) : null,
      strategyId: strategy.id ? String(strategy.id) : null,
      contextCacheHit: result?.optimizations?.contextCacheHit === true,
      microSkillCacheHit: result?.optimizations?.microSkillCacheHit === true,
      affectedTestCacheHit: result?.optimizations?.affectedTestCacheHit === true,
      warmWorkerReused: result?.optimizations?.warmWorkerReused === true,
      runtimeContextBudget: firstFinite(result?.optimizations?.runtimeContextBudget),
      tokenScope: hasProviderTokens ? "provider-reported-result" : "unavailable",
      ...tokens,
    },
    // V16.6: unified adaptive orchestration + DeepSeek reasoning partner.
    v16_6,
  }
}

export async function recordTaskTelemetry(root, result = {}, options = {}) {
  const file = taskTelemetryFile(root)
  await mkdir(path.dirname(file), { recursive: true })
  const receipt = buildTaskTelemetry(result, options)
  const event = await withTelemetryLock(file, () => appendRuntimeEvent(file, "task.telemetry", receipt))
  await recordEfficiencyEvent(root, {
    kind: "task",
    runId: receipt.runId,
    model: receipt.model,
    provider: receipt.provider,
    inputTokens: receipt.metrics.inputTokens,
    outputTokens: receipt.metrics.outputTokens,
    cacheReadTokens: receipt.metrics.cacheReadTokens,
    cacheWriteTokens: receipt.metrics.cacheWriteTokens,
    uncachedInputTokens: receipt.metrics.inputTokens,
    usageAccounting: "pi-normalized-disjoint",
    toolCalls: receipt.metrics.toolCalls,
    advertisedTools: receipt.metrics.advertisedTools,
    usedTools: receipt.metrics.usedTools,
    toolUtilizationRatio: receipt.metrics.toolUtilizationRatio,
    toolSchemaEstimatedTokens: receipt.metrics.toolSchemaEstimatedTokens,
    wallTimeMs: receipt.metrics.wallTimeMs,
    toolQueueMs: receipt.metrics.toolQueueMs,
    qualityMeasured: receipt.outcome.verifierPass === true && receipt.outcome.falsePassDetected === false,
  }).catch(() => null)
  return { file, receipt, event }
}

export async function readTaskTelemetry(root = process.cwd(), options = {}) {
  const rows = await readRuntimeEvents(taskTelemetryFile(root), options)
  return rows.filter((row) => row?.type === "task.telemetry")
}

export function summarizeTaskTelemetryRows(rows = []) {
  const events = (rows || []).filter((row) => row?.type === "task.telemetry")
  const summarize = (items) => {
    const values = (key) => items.map((row) => finite(row?.metrics?.[key])).filter((value) => value !== null)
    const average = (numbers) => numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
    const passed = items.filter((row) => row?.outcome?.passed === true).length
    return {
      runs: items.length,
      passed,
      failed: items.length - passed,
      passRate: items.length ? passed / items.length : null,
      averageWallTimeMs: average(values("wallTimeMs")),
      averageToolCalls: average(values("toolCalls")),
      averageAdvertisedTools: average(values("advertisedTools")),
      averageUsedTools: average(values("usedTools")),
      averageDeferredTools: average(values("deferredTools")),
      averageToolUtilizationRatio: average(values("toolUtilizationRatio")),
      averageToolSchemaEstimatedTokens: average(values("toolSchemaEstimatedTokens")),
      averageToolQueueMs: average(values("toolQueueMs")),
      averageProviderWaitMs: average(values("providerWaitMs")),
      averageModelGenerationMs: average(values("modelGenerationMs")),
      averageToolExecutionMs: average(values("toolExecutionMs")),
      averageToolResultProcessingMs: average(values("toolResultProcessingMs")),
      averageVerificationMs: average(values("verificationMs")),
      averageLspPrimaryMs: average(values("lspPrimaryMs")),
      averageLspFallbackMs: average(values("lspFallbackMs")),
      averageTotalTokens: average(values("totalTokens")),
      providerRetries: items.reduce((sum, row) => sum + Number(row?.metrics?.providerRetries || 0), 0),
      providerSessionResumes: items.reduce((sum, row) => sum + Number(row?.metrics?.providerSessionResumes || 0), 0),
      timingInconsistencies: items.filter((row) => row?.metrics?.timingConsistent === false).length,
    }
  }
  const byScope = {}
  for (const scope of [...new Set(events.map((row) => String(row?.scope || "specialist-run")))]) {
    byScope[scope] = summarize(events.filter((row) => String(row?.scope || "specialist-run") === scope))
  }
  return { schemaVersion: 1, ...summarize(events), byScope }
}

export async function taskTelemetrySummary(root = process.cwd(), options = {}) {
  return summarizeTaskTelemetryRows(await readTaskTelemetry(root, {
    limit: Math.max(1, Math.min(2000, Number(options.limit || 200))),
  }))
}
