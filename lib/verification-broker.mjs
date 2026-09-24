import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { createVerificationReceipt } from "./evidence-receipt.mjs"
import { getEvidence, putEvidence } from "./evidence-store.mjs"
import { runtimeWorkspaceFingerprint } from "./workspace-fingerprint.mjs"

const CACHE_VERSION = 1
const CACHE_FILE = "verification-broker-v1.json"

function cachePath(root) {
  return path.join(path.resolve(root), ".ues-cache", CACHE_FILE)
}

function keyFor(command, args = []) {
  return createHash("sha256")
    .update(JSON.stringify([String(command || ""), (args || []).map(String)]))
    .digest("hex")
}

async function readCache(root) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(root), "utf8"))
    if (parsed?.schemaVersion !== CACHE_VERSION || typeof parsed.entries !== "object") return { schemaVersion: CACHE_VERSION, entries: {} }
    return parsed
  } catch {
    return { schemaVersion: CACHE_VERSION, entries: {} }
  }
}

async function writeCache(root, value) {
  const file = cachePath(root)
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

export async function findReusableVerification(root, command, args = [], options = {}) {
  root = path.resolve(root)
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? 20 * 60_000))
  const cache = await readCache(root)
  const entry = cache.entries[keyFor(command, args)]
  if (!entry) return null
  if (maxAgeMs && Date.now() - Date.parse(entry.finishedAt || 0) > maxAgeMs) return null

  const currentFingerprint = runtimeWorkspaceFingerprint(root)
  if (!entry.receipt?.passed || entry.receipt.workspaceAfter !== currentFingerprint) return null

  const stdout = entry.stdoutRef
    ? await getEvidence(root, entry.stdoutRef, { maxBytes: options.maxBytes || 16_000 }).catch(() => null)
    : null
  const stderr = entry.stderrRef
    ? await getEvidence(root, entry.stderrRef, { maxBytes: options.maxBytes || 8_000 }).catch(() => null)
    : null

  return {
    schemaVersion: 1,
    reused: true,
    key: keyFor(command, args),
    receipt: entry.receipt,
    stdoutRef: entry.stdoutRef || null,
    stderrRef: entry.stderrRef || null,
    stdout: stdout?.content || "",
    stderr: stderr?.content || "",
    ageMs: Math.max(0, Date.now() - Date.parse(entry.finishedAt || 0)),
  }
}

export async function recordVerification(root, input = {}) {
  root = path.resolve(root)
  const stdout = String(input.stdout || "")
  const stderr = String(input.stderr || "")
  const stdoutEvidence = await putEvidence(root, stdout, {
    kind: "verification-stdout",
    source: input.command || "verification-broker",
    summary: "Exact stdout captured for reusable verification receipt",
  })
  const stderrEvidence = await putEvidence(root, stderr, {
    kind: "verification-stderr",
    source: input.command || "verification-broker",
    summary: "Exact stderr captured for reusable verification receipt",
  })

  const receipt = createVerificationReceipt({
    task: input.task || null,
    runId: input.runId || null,
    command: input.command,
    args: input.args || [],
    cwd: root,
    exitCode: input.exitCode,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    stdout,
    stderr,
    workspaceBefore: input.workspaceBefore || null,
    workspaceAfter: input.workspaceAfter || runtimeWorkspaceFingerprint(root),
  })

  const cache = await readCache(root)
  const key = keyFor(input.command, input.args || [])
  cache.entries[key] = {
    receipt,
    stdoutRef: stdoutEvidence.ref,
    stderrRef: stderrEvidence.ref,
    finishedAt: receipt.finishedAt,
  }

  // Keep cache small and deterministic.
  const rows = Object.entries(cache.entries)
    .sort((a, b) => Date.parse(b[1]?.finishedAt || 0) - Date.parse(a[1]?.finishedAt || 0))
    .slice(0, 200)
  cache.entries = Object.fromEntries(rows)
  await writeCache(root, cache)

  return {
    schemaVersion: 1,
    reused: false,
    key,
    receipt,
    stdoutRef: stdoutEvidence.ref,
    stderrRef: stderrEvidence.ref,
  }
}

export async function listReusableVerification(root, options = {}) {
  root = path.resolve(root)
  const currentFingerprint = runtimeWorkspaceFingerprint(root)
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? 30 * 60_000))
  const limit = Math.max(1, Math.min(50, Number(options.limit || 12)))
  const now = Date.now()
  const cache = await readCache(root)
  const rows = []

  for (const [key, entry] of Object.entries(cache.entries || {})) {
    const receipt = entry?.receipt
    if (!receipt?.passed || receipt.workspaceAfter !== currentFingerprint) continue
    const finished = Date.parse(entry.finishedAt || receipt.finishedAt || 0)
    if (maxAgeMs && finished && now - finished > maxAgeMs) continue
    rows.push({
      key,
      receipt,
      stdoutRef: entry.stdoutRef || null,
      stderrRef: entry.stderrRef || null,
      finishedAt: entry.finishedAt || receipt.finishedAt || null,
    })
  }

  rows.sort((a, b) => Date.parse(b.finishedAt || 0) - Date.parse(a.finishedAt || 0))
  const selected = rows.slice(0, limit)
  const output = []
  for (const row of selected) {
    const stdout = row.stdoutRef
      ? await getEvidence(root, row.stdoutRef, { maxBytes: options.previewBytes || 2400 }).catch(() => null)
      : null
    const stderr = row.stderrRef
      ? await getEvidence(root, row.stderrRef, { maxBytes: options.previewBytes || 1200 }).catch(() => null)
      : null
    output.push({
      ...row,
      stdoutPreview: stdout?.content || "",
      stderrPreview: stderr?.content || "",
    })
  }
  return {
    schemaVersion: 1,
    workspaceFingerprint: currentFingerprint,
    count: output.length,
    results: output,
  }
}
