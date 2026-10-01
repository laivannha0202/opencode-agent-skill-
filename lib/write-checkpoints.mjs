import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const BASE_DIR = ".ues-work/checkpoints"

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function cleanRunId(value) {
  return String(value || "run").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160) || "run"
}

function ensureInside(root, candidate) {
  const base = path.resolve(root)
  const full = path.resolve(base, String(candidate || ""))
  const relative = path.relative(base, full)
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return { base, full, relative: relative.replaceAll("\\", "/") || "." }
  }
  const error = new Error("UES checkpoint path escapes workspace: " + candidate)
  error.code = "UES_CHECKPOINT_OUTSIDE_WORKSPACE"
  throw error
}

async function hasSymlinkTraversal(root, full) {
  const base = path.resolve(root)
  const relative = path.relative(base, full)
  if (!relative) return false
  let current = base
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const info = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null
      throw error
    })
    if (!info) return false
    if (info.isSymbolicLink()) return true
  }
  return false
}

function checkpointDir(root, runId) {
  return path.join(path.resolve(root), BASE_DIR, cleanRunId(runId))
}

function checkpointFile(root, runId, checkpointId) {
  return path.join(checkpointDir(root, runId), String(checkpointId) + ".json")
}

async function captureFile(root, relative, maxFileBytes) {
  const target = ensureInside(root, relative)
  if (await hasSymlinkTraversal(root, target.full)) {
    return { path: target.relative, existed: true, captured: false, reason: "symlink-traversal", beforeHash: null, beforeBase64: null, size: 0 }
  }
  const info = await lstat(target.full).catch((error) => {
    if (error?.code === "ENOENT") return null
    throw error
  })
  if (!info) {
    return { path: target.relative, existed: false, captured: true, beforeHash: null, beforeBase64: null, size: 0 }
  }
  if (!info.isFile()) {
    return { path: target.relative, existed: true, captured: false, reason: "not-regular-file", beforeHash: null, beforeBase64: null, size: info.size || 0 }
  }
  if (info.size > maxFileBytes) {
    return { path: target.relative, existed: true, captured: false, reason: "file-too-large", beforeHash: null, beforeBase64: null, size: info.size }
  }
  const buffer = await readFile(target.full)
  return {
    path: target.relative,
    existed: true,
    captured: true,
    beforeHash: hashBuffer(buffer),
    beforeBase64: buffer.toString("base64"),
    size: buffer.length,
  }
}

async function currentState(root, row, maxFileBytes) {
  const target = ensureInside(root, row.path)
  if (await hasSymlinkTraversal(root, target.full)) {
    return { exists: true, hash: null, size: 0, unsafe: true }
  }
  const info = await lstat(target.full).catch((error) => {
    if (error?.code === "ENOENT") return null
    throw error
  })
  if (!info) return { exists: false, hash: null, size: 0 }
  if (!info.isFile() || info.size > maxFileBytes) return { exists: true, hash: null, size: info.size || 0 }
  const buffer = await readFile(target.full)
  return { exists: true, hash: hashBuffer(buffer), size: buffer.length }
}

export async function listWriteCheckpoints(root, options = {}) {
  const selectedRunId = options.runId ? cleanRunId(options.runId) : null
  const base = path.join(path.resolve(root), BASE_DIR)
  const runDirs = selectedRunId
    ? [selectedRunId]
    : (await readdir(base, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
  const rows = []
  for (const runId of runDirs.slice(0, 200)) {
    const dir = checkpointDir(root, runId)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      const file = path.join(dir, entry.name)
      try {
        const payload = JSON.parse(await readFile(file, "utf8"))
        rows.push({
          schemaVersion: 1,
          checkpointId: payload.checkpointId || entry.name.slice(0, -5),
          runId: payload.runId || runId,
          toolCallId: payload.toolCallId || null,
          tool: payload.tool || null,
          createdAt: payload.createdAt || null,
          finalizedAt: payload.finalizedAt || null,
          rolledBackAt: payload.rolledBackAt || null,
          files: (payload.files || []).map((row) => ({
            path: row.path,
            existed: row.existed === true,
            captured: row.captured === true,
            restorable: row.restorable === true,
            size: Number(row.size || 0),
          })),
        })
      } catch {
        // Corrupt checkpoint metadata is ignored rather than treated as restorable.
      }
    }
  }
  rows.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
  const limit = Math.max(1, Math.min(500, Number(options.limit || 50)))
  return rows.slice(0, limit)
}

export async function pruneWriteCheckpoints(root, runId, options = {}) {
  const dir = checkpointDir(root, runId)
  const maxCheckpoints = Math.max(1, Math.min(100, Number(options.maxCheckpoints || 30)))
  const maxTotalBytes = Math.max(512 * 1024, Math.min(64 * 1024 * 1024, Number(options.maxTotalBytes || 8 * 1024 * 1024)))
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const file = path.join(dir, entry.name)
    const info = await stat(file).catch(() => null)
    if (info) rows.push({ file, mtimeMs: info.mtimeMs, size: info.size })
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let kept = 0
  let bytes = 0
  let removed = 0
  for (const row of rows) {
    if (kept < maxCheckpoints && bytes + row.size <= maxTotalBytes) {
      kept += 1
      bytes += row.size
      continue
    }
    await rm(row.file, { force: true }).catch(() => {})
    removed += 1
  }
  return { schemaVersion: 1, kept, bytes, removed }
}

export async function createWriteCheckpoint(root, input = {}) {
  const runId = cleanRunId(input.runId)
  const checkpointId = "cp-" + Date.now().toString(36) + "-" + randomUUID().slice(0, 8)
  const maxFileBytes = Math.max(8 * 1024, Math.min(2 * 1024 * 1024, Number(input.maxFileBytes || 256 * 1024)))
  const files = [...new Set((input.files || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 32)
  const snapshots = []
  for (const file of files) snapshots.push(await captureFile(root, file, maxFileBytes))
  const payload = {
    schemaVersion: 1,
    checkpointId,
    runId,
    toolCallId: input.toolCallId ? String(input.toolCallId) : null,
    tool: input.tool ? String(input.tool) : null,
    createdAt: new Date().toISOString(),
    finalizedAt: null,
    maxFileBytes,
    files: snapshots,
  }
  const file = checkpointFile(root, runId, checkpointId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  await pruneWriteCheckpoints(root, runId, input).catch(() => null)
  return { ...payload, file }
}

export async function finalizeWriteCheckpoint(root, runId, checkpointId) {
  const file = checkpointFile(root, runId, checkpointId)
  const payload = JSON.parse(await readFile(file, "utf8"))
  for (const row of payload.files || []) {
    if (row.captured !== true) {
      row.afterHash = null
      row.restorable = false
      continue
    }
    const state = await currentState(root, row, Number(payload.maxFileBytes || 256 * 1024))
    row.afterExists = state.exists
    row.afterHash = state.hash
    row.afterSize = state.size
    row.restorable = state.hash !== null || (!state.exists && row.existed === true)
  }
  payload.finalizedAt = new Date().toISOString()
  await writeFile(file, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  return { ...payload, file }
}

export async function rollbackWriteCheckpoint(root, runId, checkpointId) {
  const file = checkpointFile(root, runId, checkpointId)
  const payload = JSON.parse(await readFile(file, "utf8"))
  if (!payload.finalizedAt) return { schemaVersion: 1, restored: false, reason: "checkpoint-not-finalized", checkpointId }
  const preflight = []
  for (const row of payload.files || []) {
    if (row.restorable !== true) continue
    const state = await currentState(root, row, Number(payload.maxFileBytes || 256 * 1024))
    const expectedExists = row.afterExists === true
    if (state.exists !== expectedExists || state.hash !== (row.afterHash ?? null)) {
      return {
        schemaVersion: 1,
        restored: false,
        reason: "workspace-diverged",
        checkpointId,
        path: row.path,
      }
    }
    preflight.push(row)
  }
  for (const row of preflight) {
    const target = ensureInside(root, row.path)
    if (row.existed === false) {
      await rm(target.full, { force: true })
      continue
    }
    const buffer = Buffer.from(String(row.beforeBase64 || ""), "base64")
    await mkdir(path.dirname(target.full), { recursive: true })
    await writeFile(target.full, buffer)
  }
  payload.rolledBackAt = new Date().toISOString()
  await writeFile(file, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  return { schemaVersion: 1, restored: true, checkpointId, files: preflight.map((row) => row.path) }
}
