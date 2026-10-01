import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { appendRuntimeEvent, readRuntimeEvents } from "./runtime-events.mjs"

const TELEMETRY_DIR = ".ues-learning"
const TELEMETRY_FILE = "task-telemetry-v1.jsonl"

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
  const derivedTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: explicitTotal ?? derivedTotal }
}

export function taskTelemetryFile(root = process.cwd()) {
  return path.join(path.resolve(root), TELEMETRY_DIR, TELEMETRY_FILE)
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
  const tokens = tokenMetrics(result.usage || {})
  const hasProviderTokens = Object.values(tokens).some((value) => value !== null)
  return {
    schemaVersion: 1,
    scope: String(options.scope || "specialist-run"),
    runId: options.runId ? String(options.runId) : null,
    traceID: options.traceID ? String(options.traceID) : null,
    taskId: options.taskId ? String(options.taskId) : null,
    taskHash: sha256(taskText),
    taskClass: options.taskClass ? String(options.taskClass) : null,
    agent: options.agent ? String(options.agent) : String(result.agent || "") || null,
    role: options.role ? String(options.role) : null,
    attempt: finite(options.attempt),
    model: result.model ? String(result.model) : null,
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
      toolNames: Array.isArray(result.toolNames) ? [...new Set(result.toolNames.map((item) => String(item)))].slice(0, 64) : [],
      contextCacheHit: result?.optimizations?.contextCacheHit === true,
      microSkillCacheHit: result?.optimizations?.microSkillCacheHit === true,
      affectedTestCacheHit: result?.optimizations?.affectedTestCacheHit === true,
      warmWorkerReused: result?.optimizations?.warmWorkerReused === true,
      runtimeContextBudget: firstFinite(result?.optimizations?.runtimeContextBudget),
      tokenScope: hasProviderTokens ? "provider-reported-result" : "unavailable",
      ...tokens,
    },
  }
}

export async function recordTaskTelemetry(root, result = {}, options = {}) {
  const file = taskTelemetryFile(root)
  await mkdir(path.dirname(file), { recursive: true })
  const receipt = buildTaskTelemetry(result, options)
  const event = await appendRuntimeEvent(file, "task.telemetry", receipt)
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
