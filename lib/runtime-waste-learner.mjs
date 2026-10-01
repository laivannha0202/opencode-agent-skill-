import { listRunJournals, inspectRun } from "./run-inspector.mjs"
import { readTaskTelemetry, summarizeTaskTelemetryRows } from "./run-telemetry.mjs"
import { summarizeCompactionRecall } from "./compaction-recall.mjs"
import { efficiencySummary } from "./efficiency-ledger.mjs"

export async function learnRuntimeWaste(root = process.cwd(), options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 30)))
  const journals = await listRunJournals(root, { limit })
  const inspections = []
  for (const row of journals) inspections.push(await inspectRun(root, row.runId))
  const telemetryRows = await readTaskTelemetry(root, { limit: Math.max(50, limit * 8) })
  const telemetry = summarizeTaskTelemetryRows(telemetryRows)
  const recall = await summarizeCompactionRecall(root, { limit: 3000 })
  const efficiency = await efficiencySummary(root, { limit: 3000 })

  const duplicateSignatures = inspections.reduce((sum, row) => sum + Number(row.duplicateToolSignatures?.length || 0), 0)
  const queueMs = inspections.reduce((sum, row) => sum + Number(row.totalToolQueueMs || 0), 0)
  const danglingTools = inspections.reduce((sum, row) => sum + Number(row.summary?.danglingToolCalls?.length || 0), 0)
  const findings = []
  if (duplicateSignatures > 0) findings.push({ kind: "repeated-tool-work", value: duplicateSignatures, evidence: "MEASURED" })
  if (queueMs > inspections.length * 1000) findings.push({ kind: "tool-queue-pressure", valueMs: queueMs, evidence: "MEASURED" })
  if (danglingTools) findings.push({ kind: "interrupted-or-dangling-tools", value: danglingTools, evidence: "MEASURED" })
  if (Number(recall.recallDemandRate || 0) >= 0.20) findings.push({ kind: "compaction-recall-pressure", value: recall.recallDemandRate, evidence: "MEASURED" })
  if (Number(telemetry.providerRetries || 0) > 0) findings.push({ kind: "provider-recovery-cost", value: telemetry.providerRetries, evidence: "MEASURED" })

  const recommendations = findings.map((finding) => {
    if (finding.kind === "repeated-tool-work") return "Tighten task context/tool routing for repeated read/search signatures; do not suppress evidence needed by verification."
    if (finding.kind === "tool-queue-pressure") return "Review read parallelism and conflicting tool classifications; keep writes/processes serial."
    if (finding.kind === "interrupted-or-dangling-tools") return "Inspect command/process ownership and timeouts before increasing any timeout."
    if (finding.kind === "compaction-recall-pressure") return "Preserve more visible evidence for the high-recall reducer families."
    if (finding.kind === "provider-recovery-cost") return "Inspect provider/session recovery telemetry; avoid blind replay after tool side effects."
    return null
  }).filter(Boolean)

  return {
    schemaVersion: 1,
    runsInspected: inspections.length,
    telemetry,
    compactionRecall: recall,
    efficiency,
    findings,
    recommendations,
    unavailable: [
      efficiency.measuredProviderTokenRows ? null : "provider-token-economics",
      "exact-tool-schema-token-tax",
      "counterfactual-quality-gain",
    ].filter(Boolean),
  }
}
