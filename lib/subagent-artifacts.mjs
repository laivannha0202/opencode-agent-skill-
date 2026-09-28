import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { putEvidence } from "./evidence-store.mjs"

const ARTIFACT_DIR = path.join(".ues-work", ".subagents")
const HANDLE_PATTERN = /^sa-[a-z0-9]+-[a-f0-9]{8}$/

function now() {
  return new Date().toISOString()
}

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 20)
}

function artifactDir(root) {
  return path.join(path.resolve(root), ARTIFACT_DIR)
}

function artifactPath(root, handle) {
  if (!HANDLE_PATTERN.test(String(handle || ""))) throw new Error("invalid subagent handle")
  return path.join(artifactDir(root), handle + ".json")
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp"
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8")
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

function publicArtifact(root, artifact) {
  return {
    ...artifact,
    file: path.relative(path.resolve(root), artifactPath(root, artifact.handle)).replaceAll("\\", "/"),
  }
}

export async function createSubagentArtifact(root, input = {}) {
  const handle = "sa-" + Date.now().toString(36) + "-" + randomUUID().replaceAll("-", "").slice(0, 8)
  const task = String(input.task || "")
  const taskEvidence = await putEvidence(root, task, {
    kind: "subagent-task",
    source: handle,
    summary: `Exact delegated task for ${input.agent || "UES child"}`,
  })
  const timestamp = now()
  const artifact = {
    schemaVersion: 1,
    handle,
    status: "running",
    agent: input.agent || null,
    role: input.role || null,
    attempt: Math.max(1, Number(input.attempt || 1)),
    traceID: input.traceID || null,
    model: input.model || null,
    modelTier: input.modelTier || null,
    workspaceFingerprint: input.workspaceFingerprint || null,
    taskHash: hash(task),
    taskPreview: task.replace(/\s+/g, " ").trim().slice(0, 1200),
    taskRef: taskEvidence.ref,
    startedAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    result: null,
    resume: {
      state: "running",
      taskRef: taskEvidence.ref,
      outputRef: null,
      instruction: "Inspect this handle for status. Do not infer completion until status and verification evidence say so.",
    },
  }
  await atomicJson(artifactPath(root, handle), artifact)
  return publicArtifact(root, artifact)
}

export async function readSubagentArtifact(root, handle) {
  const file = artifactPath(root, handle)
  const parsed = JSON.parse(await readFile(file, "utf8"))
  return publicArtifact(root, parsed)
}

export async function finalizeSubagentArtifact(root, handle, result = {}) {
  const current = await readSubagentArtifact(root, handle)
  const output = String(result.output || "")
  const outputEvidence = output
    ? await putEvidence(root, output, {
        kind: "subagent-output",
        source: handle,
        summary: `Exact bounded child output for ${current.agent || "UES child"}`,
      })
    : null
  const aborted = Number(result.exitCode) === 130 || String(result.stopReason || "").toLowerCase() === "aborted"
  const status = aborted ? "aborted" : Number(result.exitCode || 0) === 0 ? "completed" : "failed"
  const timestamp = now()
  const artifact = {
    ...current,
    file: undefined,
    status,
    updatedAt: timestamp,
    completedAt: timestamp,
    result: {
      exitCode: Number(result.exitCode ?? 1),
      verdict: result.verdict || null,
      stopReason: result.stopReason || null,
      durationMs: Number(result.durationMs || 0),
      toolCalls: Number(result.toolCalls || 0),
      toolNames: Array.isArray(result.toolNames) ? result.toolNames.slice(0, 40) : [],
      childRuntime: result.childRuntime || null,
      workerReused: result.workerReused === true,
      outputRef: outputEvidence?.ref || null,
      outputPreview: output.replace(/\s+/g, " ").trim().slice(0, 1000),
    },
    resume: {
      state: status,
      taskRef: current.taskRef,
      outputRef: outputEvidence?.ref || null,
      instruction: status === "completed"
        ? "Reuse the output evidence by reference; do not replay the child unless new evidence or a new task requires it."
        : "Inspect task/output evidence and dispatch a fresh bounded child attempt from this handle's exact task context; do not trust partial narrative state.",
    },
  }
  await atomicJson(artifactPath(root, handle), artifact)
  return publicArtifact(root, artifact)
}

export async function failSubagentArtifact(root, handle, error) {
  const current = await readSubagentArtifact(root, handle)
  const timestamp = now()
  const artifact = {
    ...current,
    file: undefined,
    status: "failed",
    updatedAt: timestamp,
    completedAt: timestamp,
    result: {
      exitCode: 1,
      verdict: "FAIL",
      stopReason: "launch-error",
      error: String(error instanceof Error ? error.message : error).slice(0, 2000),
      outputRef: null,
    },
    resume: {
      state: "failed",
      taskRef: current.taskRef,
      outputRef: null,
      instruction: "The child did not complete. Re-dispatch from taskRef after diagnosing the launch/runtime failure.",
    },
  }
  await atomicJson(artifactPath(root, handle), artifact)
  return publicArtifact(root, artifact)
}

export async function listSubagentArtifacts(root, options = {}) {
  const dir = artifactDir(root)
  if (!existsSync(dir)) return { schemaVersion: 1, root: dir, count: 0, artifacts: [] }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, entry.name), "utf8"))
      if (!HANDLE_PATTERN.test(String(parsed.handle || ""))) continue
      rows.push(publicArtifact(root, parsed))
    } catch {}
  }
  rows.sort((a, b) => Date.parse(b.updatedAt || b.startedAt || "") - Date.parse(a.updatedAt || a.startedAt || "") || a.handle.localeCompare(b.handle))
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20)))
  return {
    schemaVersion: 1,
    root: path.relative(path.resolve(root), dir).replaceAll("\\", "/"),
    count: rows.length,
    artifacts: rows.slice(0, limit),
  }
}
