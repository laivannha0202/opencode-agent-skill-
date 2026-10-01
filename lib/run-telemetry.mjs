import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { appendRuntimeEvent, readRuntimeEvents } from "./runtime-events.mjs"

const TELEMETRY_DIR = ".ues-learning"
const TELEMETRY_FILE = "task-telemetry-v1.jsonl"

function finite(value) {
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
  const inputTokens = firstFinite(usage.inputTokens, usage.input_tokens, usage.promptTokens, usage.prompt_tokens)
  const outputTokens = firstFinite(usage.outputTokens, usage.output_tokens, usage.completionTokens, usage.completion_tokens)
  const cacheReadTokens = firstFinite(usage.cacheReadTokens, usage.cache_read_tokens, usage.cachedInputTokens, usage.cached_input_tokens)
  const cacheWriteTokens = firstFinite(usage.cacheWriteTokens, usage.cache_write_tokens)
  const explicitTotal = firstFinite(usage.totalTokens, usage.total_tokens)
  const derivedTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens: explicitTotal ?? derivedTotal }
}

export function taskTelemetryFile(root = process.cwd()) {
  return path.join(path.resolve(root), TELEMETRY_DIR, TELEMETRY_FILE)
}

export function buildTaskTelemetry(result = {}, options = {}) {
  const latency = result?.optimizations?.latencyMs || {}
  const wallTimeMs = firstFinite(latency.total, result.durationMs)
  const workspaceSnapshotMs = firstFinite(latency.workspaceSnapshot)
  const contextBuildMs = firstFinite(latency.contextBuild)
  const modelRunMs = firstFinite(latency.modelRun)
  const hygieneMs = firstFinite(latency.hygiene)
  const exclusiveParts = [workspaceSnapshotMs, contextBuildMs, modelRunMs, hygieneMs].filter((value) => value !== null)
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
    thinking: options.thinking ? String(options.thinking) : null,
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
      wallTimeMs, workspaceSnapshotMs, contextBuildMs, modelRunMs, hygieneMs,
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
      ...tokenMetrics(result.usage || {}),
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
  const values = (key) => events.map((row) => finite(row?.metrics?.[key])).filter((value) => value !== null)
  const average = (items) => items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : null
  const passed = events.filter((row) => row?.outcome?.passed === true).length
  return {
    schemaVersion: 1, runs: events.length, passed, failed: events.length - passed,
    passRate: events.length ? passed / events.length : null,
    averageWallTimeMs: average(values("wallTimeMs")),
    averageToolCalls: average(values("toolCalls")),
    averageTotalTokens: average(values("totalTokens")),
    providerRetries: events.reduce((sum, row) => sum + Number(row?.metrics?.providerRetries || 0), 0),
    providerSessionResumes: events.reduce((sum, row) => sum + Number(row?.metrics?.providerSessionResumes || 0), 0),
    timingInconsistencies: events.filter((row) => row?.metrics?.timingConsistent === false).length,
  }
}

export async function taskTelemetrySummary(root = process.cwd(), options = {}) {
  return summarizeTaskTelemetryRows(await readTaskTelemetry(root, {
    limit: Math.max(1, Math.min(2000, Number(options.limit || 200))),
  }))
}
