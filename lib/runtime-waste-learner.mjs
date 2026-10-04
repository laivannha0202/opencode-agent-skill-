import { listRunJournals, inspectRun } from "./run-inspector.mjs"
import { readTaskTelemetry, summarizeTaskTelemetryRows } from "./run-telemetry.mjs"
import { summarizeCompactionRecall } from "./compaction-recall.mjs"
import { efficiencySummary } from "./efficiency-ledger.mjs"
import { economyLearnerReport } from "./tool-output-economy-v16-6.mjs"

function measuredNumber(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function learnRuntimeWaste(root = process.cwd(), options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 30)))
  const journals = await listRunJournals(root, { limit })
  const inspections = []
  for (const row of journals) inspections.push(await inspectRun(root, row.runId))
  const telemetryRows = await readTaskTelemetry(root, { limit: Math.max(50, limit * 8) })
  const telemetry = summarizeTaskTelemetryRows(telemetryRows)
  const recall = await summarizeCompactionRecall(root, { limit: 3000 })
  const efficiency = await efficiencySummary(root, { limit: 3000 })
  const toolOutputEconomy = economyLearnerReport({})

  const duplicateSignatures = inspections.reduce((sum, row) => sum + Number(row.duplicateToolSignatures?.length || 0), 0)
  const repeatedReads = inspections.reduce((sum, row) => sum + Number(row.repeatedReadSignatures?.length || 0), 0)
  const repeatedSearches = inspections.reduce((sum, row) => sum + Number(row.repeatedSearchSignatures?.length || 0), 0)
  const repeatedMutations = inspections.reduce((sum, row) => sum + Number(row.repeatedMutationSignatures?.length || 0), 0)
  const repeatedToolCalls = inspections.reduce((sum, row) => sum + Number(row.repeatedToolCalls || 0), 0)
  const repeatedReadCalls = inspections.reduce((sum, row) => sum + Number(row.repeatedReadCalls || 0), 0)
  const repeatedSearchCalls = inspections.reduce((sum, row) => sum + Number(row.repeatedSearchCalls || 0), 0)
  const repeatedMutationCalls = inspections.reduce((sum, row) => sum + Number(row.repeatedMutationCalls || 0), 0)
  const queueMs = inspections.reduce((sum, row) => sum + Number(row.totalToolQueueMs || 0), 0)
  const blockedTools = inspections.reduce((sum, row) => sum + Number(row.blockedTools || 0), 0)
  const interruptedTools = inspections.reduce((sum, row) => sum + Number(row.interruptedTools || 0), 0)
  const failedTools = inspections.reduce((sum, row) => sum + Number(row.failedTools || 0), 0)
  const danglingTools = inspections.reduce((sum, row) => sum + Number(row.summary?.danglingToolCalls?.length || 0), 0)
  const hiddenOutputPipelines = inspections.reduce((sum, row) => sum + Number(row.hiddenOutputPipelines || 0), 0)
  const findings = []
  if (duplicateSignatures > 0) findings.push({ kind: "repeated-tool-work", value: repeatedToolCalls, signatures: duplicateSignatures, evidence: "MEASURED" })
  if (repeatedReads > 0) findings.push({ kind: "repeated-read-work", value: repeatedReadCalls, signatures: repeatedReads, evidence: "MEASURED" })
  if (repeatedSearches > 0) findings.push({ kind: "repeated-search-work", value: repeatedSearchCalls, signatures: repeatedSearches, evidence: "MEASURED" })
  if (repeatedMutations > 0) findings.push({ kind: "repeated-mutation-work", value: repeatedMutationCalls, signatures: repeatedMutations, evidence: "MEASURED" })
  if (queueMs > inspections.length * 1000) findings.push({ kind: "tool-queue-pressure", valueMs: queueMs, evidence: "MEASURED" })
  if (blockedTools > 0) findings.push({ kind: "blocked-tool-pressure", value: blockedTools, evidence: "MEASURED" })
  if (interruptedTools + danglingTools > 0) findings.push({ kind: "interrupted-or-dangling-tools", value: interruptedTools + danglingTools, evidence: "MEASURED" })
  if (failedTools > 0) findings.push({ kind: "failed-tool-pressure", value: failedTools, evidence: "MEASURED" })
  if (hiddenOutputPipelines) findings.push({ kind: "hidden-output-verification-pipeline", value: hiddenOutputPipelines, evidence: "MEASURED" })
  if (Number(recall.recallDemandRate || 0) >= 0.20) findings.push({ kind: "compaction-recall-pressure", value: recall.recallDemandRate, evidence: "MEASURED" })
  if (Number(telemetry.providerRetries || 0) > 0) findings.push({ kind: "provider-recovery-cost", value: telemetry.providerRetries, evidence: "MEASURED" })
  const toolUtilization = measuredNumber(telemetry.averageToolUtilizationRatio)
  const schemaTaxTokens = measuredNumber(telemetry.averageToolSchemaEstimatedTokens)
  if (Number(telemetry.runs || 0) >= 5 && toolUtilization !== null && toolUtilization < 0.35) {
    findings.push({ kind: "low-tool-utilization", value: toolUtilization, evidence: "MEASURED" })
  }
  if (Number(telemetry.runs || 0) >= 5 && schemaTaxTokens !== null && schemaTaxTokens >= 2500 && toolUtilization !== null && toolUtilization < 0.50) {
    findings.push({
      kind: "estimated-tool-schema-tax-pressure",
      estimatedTokens: schemaTaxTokens,
      utilization: toolUtilization,
      evidence: "ESTIMATED_SCHEMA_TAX_PLUS_MEASURED_UTILIZATION",
    })
  }
  const providerWaitMs = measuredNumber(telemetry.averageProviderWaitMs)
  const averageWallTimeMs = measuredNumber(telemetry.averageWallTimeMs)
  const economyMissedEvidence = toolOutputEconomy.rows.reduce((sum, row) => sum + Number(row.missedEvidence || 0), 0)
  const economyRehydrations = toolOutputEconomy.rows.reduce((sum, row) => sum + Number(row.rehydrations || 0), 0)
  if (economyMissedEvidence > 0) {
    findings.push({ kind: "tool-output-economy-missed-evidence", value: economyMissedEvidence, evidence: "MEASURED" })
  } else if (economyRehydrations > 0) {
    findings.push({ kind: "tool-output-economy-rehydration-pressure", value: economyRehydrations, evidence: "MEASURED" })
  }
  if (measuredNumber(efficiency.savedChars) !== null && Number(efficiency.savedChars) > 0) {
    findings.push({ kind: "tool-output-economy-savings", savedChars: Number(efficiency.savedChars), evidence: "MEASURED" })
  }
  if (
    providerWaitMs !== null &&
    averageWallTimeMs !== null &&
    providerWaitMs >= 1000 &&
    providerWaitMs >= averageWallTimeMs * 0.20
  ) {
    findings.push({
      kind: "provider-wait-pressure",
      valueMs: providerWaitMs,
      wallShare: averageWallTimeMs > 0 ? providerWaitMs / averageWallTimeMs : null,
      evidence: "MEASURED",
    })
  }

  const recommendations = findings.map((finding) => {
    if (finding.kind === "repeated-tool-work") return "Tighten task context/tool routing for repeated signatures; do not suppress evidence needed by verification."
    if (finding.kind === "repeated-read-work") return "Prefer the existing anchored/context evidence before reopening the same read signature."
    if (finding.kind === "repeated-search-work") return "Reuse bounded search results or narrow the query before repeating the same search signature."
    if (finding.kind === "repeated-mutation-work") return "Inspect repeated mutation signatures for retries or stale-worker replay; never optimize them away without proving idempotency."
    if (finding.kind === "tool-queue-pressure") return "Review read parallelism and conflicting tool classifications; keep writes/processes serial."
    if (finding.kind === "interrupted-or-dangling-tools") return "Inspect command/process ownership and timeouts before increasing any timeout."
    if (finding.kind === "hidden-output-verification-pipeline") return "Run verification under the supervisor with bounded timeout and preserve raw output; avoid shell pipelines that hide progress."
    if (finding.kind === "compaction-recall-pressure") return "Preserve more visible evidence for the high-recall reducer families."
    if (finding.kind === "provider-recovery-cost") return "Inspect provider/session recovery telemetry; avoid blind replay after tool side effects."
    if (finding.kind === "low-tool-utilization") return "Move persistently unused tools behind the adaptive/deferred surface after the evidence floor; keep correctness-critical tools core."
    if (finding.kind === "estimated-tool-schema-tax-pressure") return "Reduce the stable advertised tool schema only where measured utilization is low; validate pass rate before promoting the smaller surface."
    if (finding.kind === "provider-wait-pressure") return "Provider wait is a measured wall-time contributor; compare model/provider latency before changing context or verifier policy."
    if (finding.kind === "tool-output-economy-missed-evidence") return "Tool-output compression hid a needed signal; raise the minimum collapse run length (relax compression) and keep the exact raw evidence reference visible."
    if (finding.kind === "tool-output-economy-rehydration-pressure") return "The model re-fetched raw output after compression; relax the noise-collapse strength for that family rather than dropping evidence preservation."
    if (finding.kind === "tool-output-economy-savings") return "Measured tool-output savings exist; keep the lossless compressor and validate pass rate before tightening it further."
    if (finding.kind === "blocked-tool-pressure") return "Inspect why tools were blocked (policy, ownership, scheduler or workspace guards) before increasing retries."
    if (finding.kind === "failed-tool-pressure") return "Group failed tool evidence by command/tool family and fix the recurring root cause rather than retrying blindly."
    return null
  }).filter(Boolean)

  return {
    schemaVersion: 1,
    runsInspected: inspections.length,
    telemetry,
    compactionRecall: recall,
    efficiency,
    toolOutputEconomy,
    findings,
    recommendations,
    unavailable: [
      efficiency.measuredProviderTokenRows ? null : "provider-token-economics",
      measuredNumber(telemetry.averageProviderWaitMs) !== null ? null : "provider-stage-latency",
      "exact-tool-schema-token-tax",
      "exact-subagent-prefix-token-tax",
      "counterfactual-quality-gain",
      "provider-tokens-saved-by-tool-output-economy",
    ].filter(Boolean),
  }
}
