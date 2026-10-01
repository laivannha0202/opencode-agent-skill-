import path from "node:path"
import { mkdir, rm, stat } from "node:fs/promises"
import { appendRuntimeEvent, readRuntimeEvents } from "./runtime-events.mjs"

const FILE = "efficiency-ledger-v2.jsonl"
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 30_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withEfficiencyLock(file, fn) {
  const lockDir = file + ".lock"
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  let delay = 5
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockDir).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        const confirmed = await stat(lockDir).catch(() => null)
        if (confirmed && confirmed.ino === info.ino && confirmed.mtimeMs === info.mtimeMs) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) {
        const lockError = new Error("Timed out waiting for UES efficiency ledger lock")
        lockError.code = "UES_EFFICIENCY_LEDGER_LOCK_TIMEOUT"
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
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function efficiencyLedgerFile(root = process.cwd()) {
  return path.join(path.resolve(root), ".ues-learning", FILE)
}

export function buildEfficiencyEvent(input = {}) {
  const inputTokens = finite(input.inputTokens)
  const cacheReadTokens = finite(input.cacheReadTokens)
  const cacheWriteTokens = finite(input.cacheWriteTokens)
  const explicitUncached = finite(input.uncachedInputTokens)
  const accounting = String(input.usageAccounting || "")
  const uncachedInputTokens = explicitUncached != null
    ? Math.max(0, explicitUncached)
    : accounting === "pi-normalized-disjoint" && inputTokens != null
      ? Math.max(0, inputTokens)
      : null
  const beforeChars = finite(input.beforeChars)
  const afterChars = finite(input.afterChars)
  return {
    schemaVersion: 2,
    kind: String(input.kind || "task"),
    runId: input.runId ? String(input.runId) : null,
    model: input.model ? String(input.model) : null,
    provider: input.provider ? String(input.provider) : null,
    commandFamily: input.commandFamily ? String(input.commandFamily) : null,
    contentType: input.contentType ? String(input.contentType) : null,
    cacheMode: input.cacheMode ? String(input.cacheMode) : null,
    usageAccounting: accounting || null,
    metrics: {
      beforeChars,
      afterChars,
      savedChars: beforeChars != null && afterChars != null ? Math.max(0, beforeChars - afterChars) : null,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      uncachedInputTokens,
      outputTokens: finite(input.outputTokens),
      toolCalls: finite(input.toolCalls),
      wallTimeMs: finite(input.wallTimeMs),
      toolQueueMs: finite(input.toolQueueMs),
    },
    provenance: {
      chars: beforeChars != null && afterChars != null ? "MEASURED" : "NOT_MEASURED",
      providerTokens: [inputTokens, cacheReadTokens, cacheWriteTokens, finite(input.outputTokens)]
        .some((value) => value != null) ? "MEASURED" : "NOT_MEASURED",
      inputTokens: inputTokens != null ? "MEASURED" : "NOT_MEASURED",
      cacheReadTokens: cacheReadTokens != null ? "MEASURED" : "NOT_MEASURED",
      cacheWriteTokens: cacheWriteTokens != null ? "MEASURED" : "NOT_MEASURED",
      outputTokens: finite(input.outputTokens) != null ? "MEASURED" : "NOT_MEASURED",
      uncachedInputTokens: explicitUncached != null
        ? "MEASURED"
        : uncachedInputTokens != null
          ? "DERIVED_FROM_MEASURED"
          : "NOT_MEASURED",
      quality: input.qualityMeasured === true ? "MEASURED" : "NOT_MEASURED",
    },
  }
}

export async function recordEfficiencyEvent(root = process.cwd(), input = {}) {
  const file = efficiencyLedgerFile(root)
  await mkdir(path.dirname(file), { recursive: true })
  const receipt = buildEfficiencyEvent(input)
  const event = await withEfficiencyLock(file, () => appendRuntimeEvent(file, "efficiency.observation", receipt))
  return { file, receipt, event }
}

export async function readEfficiencyEvents(root = process.cwd(), options = {}) {
  const rows = await readRuntimeEvents(efficiencyLedgerFile(root), {
    limit: Math.max(1, Math.min(5000, Number(options.limit || 1000))),
  })
  return rows.filter((row) => row?.type === "efficiency.observation")
}

export function summarizeEfficiencyRows(rows = []) {
  const events = rows.filter((row) => row?.type === "efficiency.observation")
  const finiteMetric = (row, key) => {
    const value = finite(row?.metrics?.[key])
    return value == null ? null : Math.max(0, value)
  }
  const measuredRows = (key, provenanceKey = key, accepted = new Set(["MEASURED"])) =>
    events.filter((row) => accepted.has(String(row?.provenance?.[provenanceKey] || "")) && finiteMetric(row, key) != null)
  const sumRows = (items, key) => items.reduce((total, row) => total + Number(finiteMetric(row, key) || 0), 0)
  const measuredCharRows = measuredRows("savedChars", "chars")
  const inputRows = measuredRows("inputTokens")
  const cacheReadRows = measuredRows("cacheReadTokens")
  const cacheWriteRows = measuredRows("cacheWriteTokens")
  const outputRows = measuredRows("outputTokens")
  const uncachedRows = measuredRows(
    "uncachedInputTokens",
    "uncachedInputTokens",
    new Set(["MEASURED", "DERIVED_FROM_MEASURED"]),
  )
  const providerTokenRows = events.filter((row) => row?.provenance?.providerTokens === "MEASURED")
  const toolRows = events.filter((row) => finiteMetric(row, "toolCalls") != null)
  const wallRows = events.filter((row) => finiteMetric(row, "wallTimeMs") != null)
  const queueRows = events.filter((row) => finiteMetric(row, "toolQueueMs") != null)
  return {
    schemaVersion: 2,
    observations: events.length,
    measuredProviderTokenRows: providerTokenRows.length,
    measuredCharRows: measuredCharRows.length,
    measuredInputTokenRows: inputRows.length,
    measuredCacheReadRows: cacheReadRows.length,
    measuredCacheWriteRows: cacheWriteRows.length,
    measuredOutputTokenRows: outputRows.length,
    measuredUncachedInputRows: uncachedRows.length,
    inputTokens: inputRows.length ? sumRows(inputRows, "inputTokens") : null,
    cacheReadTokens: cacheReadRows.length ? sumRows(cacheReadRows, "cacheReadTokens") : null,
    cacheWriteTokens: cacheWriteRows.length ? sumRows(cacheWriteRows, "cacheWriteTokens") : null,
    uncachedInputTokens: uncachedRows.length ? sumRows(uncachedRows, "uncachedInputTokens") : null,
    outputTokens: outputRows.length ? sumRows(outputRows, "outputTokens") : null,
    savedChars: measuredCharRows.length ? sumRows(measuredCharRows, "savedChars") : null,
    toolCalls: toolRows.length ? sumRows(toolRows, "toolCalls") : null,
    wallTimeMs: wallRows.length ? sumRows(wallRows, "wallTimeMs") : null,
    toolQueueMs: queueRows.length ? sumRows(queueRows, "toolQueueMs") : null,
    qualityClaim: "NOT_INFERRED_FROM_EFFICIENCY",
  }
}

export async function efficiencySummary(root = process.cwd(), options = {}) {
  return summarizeEfficiencyRows(await readEfficiencyEvents(root, options))
}
