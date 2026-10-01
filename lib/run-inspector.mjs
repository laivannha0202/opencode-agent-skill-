import { createHash } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { readRunJournal, runJournalFile, summarizeRunJournalRows } from "./run-journal.mjs"
import { listRunArtifacts } from "./run-artifacts.mjs"

function hashInput(value) {
  return createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 16)
}

const READ_TOOLS = new Set(["read", "ues_code", "ues_evidence_get"])
const SEARCH_TOOLS = new Set(["grep", "find", "ls"])

function repeatedKind(tool, concurrencyClass) {
  const name = String(tool || "").toLowerCase()
  const concurrency = String(concurrencyClass || "").toUpperCase()
  if (READ_TOOLS.has(name)) return "read"
  if (SEARCH_TOOLS.has(name)) return "search"
  if (concurrency.includes("WRITE") || concurrency.includes("PROCESS")) return "mutation"
  return "other"
}

export async function listRunJournals(root = process.cwd(), options = {}) {
  const dir = path.dirname(runJournalFile(root, "probe"))
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
    const file = path.join(dir, entry.name)
    const info = await stat(file).catch(() => null)
    if (!info) continue
    rows.push({
      runId: entry.name.slice(0, -6),
      file,
      mtimeMs: info.mtimeMs,
      size: info.size,
    })
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows.slice(0, Math.max(1, Math.min(200, Number(options.limit || 20))))
}

export function inspectRunRows(rows = []) {
  const summary = summarizeRunJournalRows(rows)
  const counts = {}
  const repeated = new Map()
  let totalToolQueueMs = 0
  let maxToolQueueMs = 0
  let hiddenOutputPipelines = 0
  let blockedTools = 0
  let interruptedTools = 0
  let failedTools = 0
  for (const row of rows) {
    counts[row.type] = Number(counts[row.type] || 0) + 1
    if (row.type === "command.intelligence" && row.finding === "verification-output-hidden-by-pipeline") {
      hiddenOutputPipelines += 1
    }
    if (row.type === "tool.blocked") blockedTools += 1
    if (row.type === "tool.interrupted") interruptedTools += 1
    if (row.type === "tool.failed") failedTools += 1
    if (row.type === "tool.started") {
      const signature = String(row.tool || "unknown") + ":" + String(row.inputHash || hashInput(row.input))
      const previous = repeated.get(signature) || {
        count: 0,
        tool: String(row.tool || "unknown"),
        concurrencyClass: row.concurrencyClass || null,
      }
      previous.count += 1
      repeated.set(signature, previous)
      const queuedMs = Number(row.queuedMs || 0)
      totalToolQueueMs += queuedMs
      maxToolQueueMs = Math.max(maxToolQueueMs, queuedMs)
    }
  }
  const duplicateToolSignatures = [...repeated.entries()]
    .filter(([, row]) => row.count > 1)
    .map(([signature, row]) => ({
      signature,
      count: row.count,
      tool: row.tool,
      concurrencyClass: row.concurrencyClass,
      kind: repeatedKind(row.tool, row.concurrencyClass),
    }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
  const repeatedReadSignatures = duplicateToolSignatures.filter((row) => row.kind === "read")
  const repeatedSearchSignatures = duplicateToolSignatures.filter((row) => row.kind === "search")
  const repeatedMutationSignatures = duplicateToolSignatures.filter((row) => row.kind === "mutation")
  const findings = []
  if (duplicateToolSignatures.length) findings.push({ kind: "repeated-tool-signature", count: duplicateToolSignatures.length })
  if (repeatedReadSignatures.length) findings.push({ kind: "repeated-read-signature", count: repeatedReadSignatures.length })
  if (repeatedSearchSignatures.length) findings.push({ kind: "repeated-search-signature", count: repeatedSearchSignatures.length })
  if (repeatedMutationSignatures.length) findings.push({ kind: "repeated-mutation-signature", count: repeatedMutationSignatures.length })
  if (maxToolQueueMs >= 1000) findings.push({ kind: "tool-queue-delay", maxToolQueueMs })
  if (summary.danglingToolCalls.length) findings.push({ kind: "dangling-tool-call", count: summary.danglingToolCalls.length })
  if (blockedTools) findings.push({ kind: "blocked-tool-call", count: blockedTools })
  if (interruptedTools) findings.push({ kind: "interrupted-tool-call", count: interruptedTools })
  if (failedTools) findings.push({ kind: "failed-tool-call", count: failedTools })
  if (hiddenOutputPipelines) findings.push({ kind: "hidden-output-verification-pipeline", count: hiddenOutputPipelines })

  return {
    schemaVersion: 2,
    summary,
    eventCounts: counts,
    totalToolQueueMs,
    maxToolQueueMs,
    duplicateToolSignatures,
    repeatedReadSignatures,
    repeatedSearchSignatures,
    repeatedMutationSignatures,
    blockedTools,
    interruptedTools,
    failedTools,
    hiddenOutputPipelines,
    findings,
  }
}

export async function inspectRun(root, runId) {
  const rows = await readRunJournal(root, runId, { limit: 5000 })
  const artifacts = await listRunArtifacts(root, runId)
  return {
    schemaVersion: 2,
    runId: String(runId),
    ...inspectRunRows(rows),
    artifacts,
  }
}

export function compareRunInspections(left = {}, right = {}) {
  const metric = (value, key) => Number(value?.[key] || 0)
  return {
    schemaVersion: 1,
    leftRunId: left.runId || null,
    rightRunId: right.runId || null,
    deltas: {
      events: metric(right.summary, "events") - metric(left.summary, "events"),
      totalToolQueueMs: metric(right, "totalToolQueueMs") - metric(left, "totalToolQueueMs"),
      maxToolQueueMs: metric(right, "maxToolQueueMs") - metric(left, "maxToolQueueMs"),
      duplicateToolSignatures:
        (right.duplicateToolSignatures?.length || 0) - (left.duplicateToolSignatures?.length || 0),
      repeatedReadSignatures:
        (right.repeatedReadSignatures?.length || 0) - (left.repeatedReadSignatures?.length || 0),
      repeatedSearchSignatures:
        (right.repeatedSearchSignatures?.length || 0) - (left.repeatedSearchSignatures?.length || 0),
      repeatedMutationSignatures:
        (right.repeatedMutationSignatures?.length || 0) - (left.repeatedMutationSignatures?.length || 0),
      blockedTools: metric(right, "blockedTools") - metric(left, "blockedTools"),
      interruptedTools: metric(right, "interruptedTools") - metric(left, "interruptedTools"),
      failedTools: metric(right, "failedTools") - metric(left, "failedTools"),
      hiddenOutputPipelines: metric(right, "hiddenOutputPipelines") - metric(left, "hiddenOutputPipelines"),
    },
  }
}
