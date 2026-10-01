import { createHash } from "node:crypto"

function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function bounded(values, limit) { return Array.isArray(values) ? values.slice(0, limit) : [] }

export function buildRehydrationManifest(packet = {}, options = {}) {
  const workspace = packet?.workspaces?.[0] || {}
  const state = workspace?.state || {}
  const payload = {
    schemaVersion: 1,
    kind: "ues-deterministic-rehydration-manifest",
    source: packet?.source || "deterministic-artifacts",
    modelSummaryTrustedForDurableState: false,
    runtimeEpoch: options.runtimeEpoch || null,
    taskContract: options.taskContract || workspace.executionContract || null,
    acceptanceCriteria: bounded(options.acceptanceCriteria, 40),
    currentTask: state.currentTaskId || state.currentTask || null,
    changedFiles: bounded(options.changedFiles, 120),
    unresolvedFailures: bounded(options.unresolvedFailures, 40),
    activeSandbox: options.activeSandbox || null,
    evidenceRefs: bounded(options.evidenceRefs || workspace.instructionEpoch?.evidencePointers || state.checkpoint?.evidencePointers, 64),
    verificationState: options.verificationState || {
      receipts: bounded(workspace.receipts, 24),
      gates: bounded(workspace.gateReceipts, 16),
    },
    selectedSkills: bounded(options.selectedSkills, 48),
    modelProfileId: options.modelProfileId || null,
    policySnapshotId: options.policySnapshotId || null,
    workspaceFingerprint: options.workspaceFingerprint || state.checkpoint?.workspaceFingerprint || null,
    nextAction: state.nextAction || state.checkpoint?.nextAction || workspace.instructionEpoch?.nextAction || null,
  }
  return Object.freeze({ ...payload, id: "rehydration:sha256:" + hash(payload) })
}

export function renderRehydrationManifest(manifest, options = {}) {
  const maxChars = Math.max(4000, Math.min(32000, Number(options.maxChars || 16000)))
  const preface = [
    "## UES V15.9 Deterministic Rehydration Manifest",
    "Durable execution state below is authoritative over any model-generated compaction summary.",
    "Re-read referenced evidence/artifacts when detail is missing; never infer completion from the summary alone.",
    "",
  ].join("\n")
  const body = JSON.stringify(manifest, null, 2)
  return preface + (body.length <= maxChars - preface.length ? body : body.slice(0, maxChars - preface.length - 100) + "\n...[bounded]")
}
