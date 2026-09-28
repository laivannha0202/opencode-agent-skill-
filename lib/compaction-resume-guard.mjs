import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { checkpointWork } from "./task-engine.mjs"

const WORK_DIR = ".ues-work"
const MAX_WORKSPACES = 3
const MAX_TASKS = 28
const MAX_RECEIPTS = 20

function digest(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 20)
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return fallback
    return fallback
  }
}

function inside(base, target) {
  const root = path.resolve(base)
  const resolved = path.resolve(target)
  return resolved === root || resolved.startsWith(root + path.sep)
}

function normalizePhasePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "")
}

async function activeWorkspaces(root, max = MAX_WORKSPACES) {
  const base = path.join(path.resolve(root), WORK_DIR)
  if (!existsSync(base)) return []
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(base, entry.name)
    const state = await readJson(path.join(dir, "STATE.json"), null)
    if (!state || String(state.status || "").toLowerCase() === "completed") continue
    rows.push({
      slug: entry.name,
      dir,
      state,
      updatedAt: Date.parse(state.updatedAt || state.createdAt || "") || 0,
    })
  }
  return rows
    .sort((a, b) => b.updatedAt - a.updatedAt || a.slug.localeCompare(b.slug))
    .slice(0, Math.max(1, Math.min(10, Number(max || MAX_WORKSPACES))))
}

function taskRows(plan, state) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  const rows = tasks.map((task) => {
    const runtime = state?.tasks?.[task.id] || {}
    return {
      id: task.id,
      title: String(task.title || "").slice(0, 240),
      status: runtime.status || "unknown",
      attempts: Number(runtime.attempts || 0),
      runId: runtime.runId || null,
      dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.slice(0, 24) : [],
      evidenceStrength: runtime.evidenceStrength || null,
      report: runtime.report || null,
      lastError: runtime.lastError ? String(runtime.lastError).slice(0, 800) : null,
    }
  })
  rows.sort((a, b) => {
    const rank = (row) => row.status === "running" ? 0 : row.status === "completed" ? 2 : 1
    return rank(a) - rank(b) || String(a.id).localeCompare(String(b.id))
  })
  return rows.slice(0, MAX_TASKS)
}

function receiptRows(evidence) {
  return (Array.isArray(evidence?.receipts) ? evidence.receipts : [])
    .slice(-MAX_RECEIPTS)
    .map((item) => ({
      id: item.id || null,
      kind: item.kind || "verification-receipt",
      task: item.task || null,
      runId: item.runId || null,
      passed: item.passed === true,
      verdict: item.verdict || (item.passed === true ? "PASS" : null),
      command: item.command || null,
      workspaceAfter: item.workspaceAfter || null,
      recordedAt: item.recordedAt || item.finishedAt || null,
    }))
}

function gateRows(evidence) {
  return (Array.isArray(evidence?.gateReceipts) ? evidence.gateReceipts : [])
    .slice(-12)
    .map((item) => ({
      id: item.id || null,
      kind: item.kind || null,
      verdict: item.verdict || null,
      verifier: item.verifier || null,
      planHash: item.planHash || null,
      workspaceFingerprint: item.workspaceFingerprint || null,
      recordedAt: item.recordedAt || null,
    }))
}

async function phaseRows(dir, manifest) {
  const artifacts = Array.isArray(manifest?.artifacts) ? manifest.artifacts : []
  const rows = []
  for (const relative of artifacts.slice(0, 32)) {
    const normalized = normalizePhasePath(relative)
    const target = path.resolve(dir, normalized)
    if (!normalized || !inside(dir, target)) continue
    const phase = await readJson(target, null)
    if (!phase) continue
    rows.push({
      artifact: normalized,
      phase: phase.phase ?? null,
      title: String(phase.title || "").slice(0, 240),
      status: phase.status || "UNKNOWN",
      sourceBodyHash: phase.sourceBodyHash || null,
      evidenceCount: Array.isArray(phase.evidence) ? phase.evidence.length : 0,
      finalVerdicts: phase.finalVerdicts || null,
    })
  }
  return rows
}

function stateSummary(state) {
  return {
    status: state?.status || null,
    goal: state?.goal ? String(state.goal).slice(0, 800) : null,
    updatedAt: state?.updatedAt || null,
    planHash: state?.planHash || null,
    planApproved: state?.planApproved === true,
    nextAction: state?.nextAction || null,
    checkpoint: state?.checkpoint ? {
      id: state.checkpoint.id || null,
      reason: state.checkpoint.reason || null,
      createdAt: state.checkpoint.createdAt || null,
      currentTaskId: state.checkpoint.currentTaskId || null,
      runId: state.checkpoint.runId || null,
      planHash: state.checkpoint.planHash || null,
      workspaceFingerprint: state.checkpoint.workspaceFingerprint || null,
      nextAction: state.checkpoint.nextAction || null,
      evidencePointers: Array.isArray(state.checkpoint.evidencePointers)
        ? state.checkpoint.evidencePointers.slice(-20)
        : [],
    } : null,
  }
}

export async function checkpointDurableWorkBeforeCompaction(root, options = {}) {
  const reason = String(options.reason || "unknown")
  const rows = await activeWorkspaces(root, options.maxWorkspaces || MAX_WORKSPACES)
  const results = []
  for (const row of rows) {
    try {
      const checkpoint = await checkpointWork(root, row.slug, {
        reason: `pi-compaction:${reason}`,
      })
      results.push({ slug: row.slug, checkpoint, ok: true })
    } catch (error) {
      results.push({
        slug: row.slug,
        checkpoint: null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export async function buildCompactionResumeGuard(root, options = {}) {
  const rows = await activeWorkspaces(root, options.maxWorkspaces || MAX_WORKSPACES)
  const workspaces = []
  for (const row of rows) {
    const [plan, evidence, contract, manifest] = await Promise.all([
      readJson(path.join(row.dir, "PLAN.json"), null),
      readJson(path.join(row.dir, "EVIDENCE.json"), {}),
      readJson(path.join(row.dir, "EXECUTION_CONTRACT.json"), null),
      readJson(path.join(row.dir, "phases", "MANIFEST.json"), null),
    ])
    const phases = await phaseRows(row.dir, manifest)
    const sources = {
      state: path.relative(root, path.join(row.dir, "STATE.json")).replaceAll("\\", "/"),
      plan: path.relative(root, path.join(row.dir, "PLAN.json")).replaceAll("\\", "/"),
      evidence: path.relative(root, path.join(row.dir, "EVIDENCE.json")).replaceAll("\\", "/"),
      executionContract: contract
        ? path.relative(root, path.join(row.dir, "EXECUTION_CONTRACT.json")).replaceAll("\\", "/")
        : null,
      phaseManifest: manifest
        ? path.relative(root, path.join(row.dir, "phases", "MANIFEST.json")).replaceAll("\\", "/")
        : null,
    }
    workspaces.push({
      slug: row.slug,
      sources,
      sourceHashes: {
        state: digest(JSON.stringify(row.state)),
        plan: digest(JSON.stringify(plan || {})),
        evidence: digest(JSON.stringify(evidence || {})),
        executionContract: contract ? digest(JSON.stringify(contract)) : null,
        phaseManifest: manifest ? digest(JSON.stringify(manifest)) : null,
      },
      state: stateSummary(row.state),
      tasks: taskRows(plan, row.state),
      receipts: receiptRows(evidence),
      gateReceipts: gateRows(evidence),
      executionContract: contract ? {
        schemaVersion: contract.schemaVersion || null,
        taskHash: contract.taskHash || null,
        gates: contract.gates || null,
        phaseCount: Array.isArray(contract.phases) ? contract.phases.length : 0,
        approvedInheritedDirtyPaths: Array.isArray(contract.approvedInheritedDirtyPaths)
          ? contract.approvedInheritedDirtyPaths.slice(0, 40)
          : [],
      } : null,
      phases,
    })
  }

  return {
    schemaVersion: 1,
    kind: "ues-durable-compaction-resume-guard",
    generatedAt: new Date().toISOString(),
    compactionReason: options.reason || null,
    source: "deterministic-filesystem-artifacts",
    modelSummaryTrustedForDurableState: false,
    workspaceCount: workspaces.length,
    workspaces,
  }
}

export function renderCompactionResumeGuard(packet, options = {}) {
  if (!packet?.workspaces?.length) return ""
  const maxChars = Math.max(8000, Math.min(48000, Number(options.maxChars || 28000)))
  const preface = [
    "## UES Durable Compaction Resume Guard",
    "Authoritative durable state was rebuilt from filesystem artifacts after Pi compaction.",
    "The model-generated compaction summary is advisory only for durable execution state.",
    "If the summary conflicts with STATE.json, PLAN.json, EXECUTION_CONTRACT.json, phase artifacts, or evidence receipts below, the deterministic artifacts win.",
    "Do not mark a task/phase complete unless the rebuilt state and fresh receipts support it.",
    "Follow checkpoint.nextAction/state.nextAction and re-read the referenced artifact when more detail is required.",
    "",
  ].join("\n")
  const encoded = JSON.stringify(packet, null, 2)
  if (preface.length + encoded.length <= maxChars) return preface + encoded
  return preface + encoded.slice(0, Math.max(0, maxChars - preface.length - 120)) +
    "\n...[resume packet bounded; re-read referenced .ues-work artifacts for exact detail]"
}
