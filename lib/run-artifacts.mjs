import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

const RUN_DIR = ".ues-work/runs"
const SAFE_NAME = /^[A-Z0-9][A-Z0-9_.-]{0,79}$/i

function cleanRunId(value) {
  const cleaned = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180)
  if (!cleaned) throw new Error("UES run artifacts require runId")
  return cleaned
}

export function runArtifactDir(root, runId) {
  return path.join(path.resolve(root), RUN_DIR, cleanRunId(runId))
}

function artifactPath(root, runId, name) {
  const safe = String(name || "").trim()
  if (!SAFE_NAME.test(safe) || safe.includes("..")) throw new Error("Unsafe UES run artifact name: " + safe)
  return path.join(runArtifactDir(root, runId), safe)
}

async function writeAtomicJson(file, value) {
  const temp = file + ".tmp-" + process.pid
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  await import("node:fs/promises").then(({ rename }) => rename(temp, file))
}

export async function initializeRunArtifacts(root, input = {}) {
  const runId = cleanRunId(input.runId)
  const dir = runArtifactDir(root, runId)
  await mkdir(dir, { recursive: true })
  const run = {
    schemaVersion: 1,
    runId,
    status: "RUNNING",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    taskHash: input.taskHash ? String(input.taskHash) : null,
    workspaceFingerprint: input.workspaceFingerprint ? String(input.workspaceFingerprint) : null,
    policySnapshotId: input.policySnapshotId ? String(input.policySnapshotId) : null,
    runtimeEpochId: input.runtimeEpochId ? String(input.runtimeEpochId) : null,
    executionProfile: input.executionProfile ? String(input.executionProfile) : null,
    risk: input.risk ? String(input.risk) : null,
  }
  await writeAtomicJson(artifactPath(root, runId, "RUN.json"), run)
  return { dir, run }
}

export async function writeRunArtifact(root, runId, name, value, options = {}) {
  const dir = runArtifactDir(root, runId)
  await mkdir(dir, { recursive: true })
  const file = artifactPath(root, runId, name)
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n"
  const maxBytes = Math.max(4 * 1024, Math.min(4 * 1024 * 1024, Number(options.maxBytes || 1024 * 1024)))
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    const error = new Error("UES run artifact exceeds bounded size: " + name)
    error.code = "UES_RUN_ARTIFACT_TOO_LARGE"
    throw error
  }
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 })
  return { file, bytes: Buffer.byteLength(text, "utf8") }
}

export async function finalizeRunArtifacts(root, runId, input = {}) {
  const runFile = artifactPath(root, runId, "RUN.json")
  const current = JSON.parse(await readFile(runFile, "utf8").catch(() => "{}"))
  const run = {
    ...current,
    schemaVersion: 1,
    runId: cleanRunId(runId),
    status: input.passed === true ? "PASS" : input.aborted === true ? "ABORTED" : "FAIL",
    finishedAt: new Date().toISOString(),
    durationMs: Number.isFinite(Number(input.durationMs)) ? Math.max(0, Number(input.durationMs)) : null,
    verdict: input.verdict ? String(input.verdict) : null,
  }
  await writeAtomicJson(runFile, run)
  if (input.verification != null) await writeRunArtifact(root, runId, "VERIFICATION.json", input.verification)
  if (input.telemetry != null) await writeRunArtifact(root, runId, "TELEMETRY.json", input.telemetry)
  if (input.summary != null) await writeRunArtifact(root, runId, "SUMMARY.md", String(input.summary))
  return { dir: runArtifactDir(root, runId), run }
}

export async function listRunArtifacts(root, runId) {
  const dir = runArtifactDir(root, runId)
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
}
