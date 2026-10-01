import { createHash } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { readRunJournal, runJournalFile, summarizeRunJournalRows } from "./run-journal.mjs"
import { listRunArtifacts } from "./run-artifacts.mjs"

function hashInput(value) {
  return createHash("sha256").update(JSON.stringify(value || {})).digest("hex").slice(0, 16)
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
  for (const row of rows) {
    counts[row.type] = Number(counts[row.type] || 0) + 1
    if (row.type === "tool.started") {
      const signature = String(row.tool || "unknown") + ":" + String(row.inputHash || hashInput(row.input))
      repeated.set(signature, Number(repeated.get(signature) || 0) + 1)
      const queuedMs = Number(row.queuedMs || 0)
      totalToolQueueMs += queuedMs
      maxToolQueueMs = Math.max(maxToolQueueMs, queuedMs)
    }
  }
  const duplicateToolSignatures = [...repeated.entries()]
    .filter(([, count]) => count > 1)
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
  const findings = []
  if (duplicateToolSignatures.length) findings.push({ kind: "repeated-tool-signature", count: duplicateToolSignatures.length })
  if (maxToolQueueMs >= 1000) findings.push({ kind: "tool-queue-delay", maxToolQueueMs })
  if (summary.danglingToolCalls.length) findings.push({ kind: "dangling-tool-call", count: summary.danglingToolCalls.length })

  return {
    schemaVersion: 1,
    summary,
    eventCounts: counts,
    totalToolQueueMs,
    maxToolQueueMs,
    duplicateToolSignatures,
    findings,
  }
}

export async function inspectRun(root, runId) {
  const rows = await readRunJournal(root, runId, { limit: 5000 })
  const artifacts = await listRunArtifacts(root, runId)
  return {
    schemaVersion: 1,
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
    },
  }
}
