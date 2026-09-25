import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createVerificationReceipt, validateVerificationReceipt } from "./evidence-receipt.mjs"
import { getEvidence, putEvidence } from "./evidence-store.mjs"
import { runtimeWorkspaceFingerprint } from "./workspace-fingerprint.mjs"

const CACHE_VERSION = 1
const CACHE_FILE = "verification-broker-v1.json"

const CACHE_WRITE_TAILS = new Map()
const CACHE_LOCK_SUFFIX = ".lock"
const CACHE_LOCK_STALE_MS = 5_000
const CACHE_LOCK_WAIT_MS = 8_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cacheLockPath(root) {
  return cachePath(root) + CACHE_LOCK_SUFFIX
}

async function withCrossProcessCacheLock(root, fn) {
  const lockDir = cacheLockPath(root)
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + CACHE_LOCK_WAIT_MS
  let delayMs = 8

  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error

      const info = await stat(lockDir).catch(() => null)
      if (info && Date.now() - info.mtimeMs > CACHE_LOCK_STALE_MS) {
        const confirmed = await stat(lockDir).catch(() => null)
        if (
          confirmed &&
          confirmed.ino === info.ino &&
          confirmed.mtimeMs === info.mtimeMs
        ) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for verification broker cache lock")
      }
      await sleep(delayMs)
      delayMs = Math.min(80, delayMs * 2)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function withCacheWriteLock(root, fn) {
  const key = path.resolve(root)
  const previous = CACHE_WRITE_TAILS.get(key) || Promise.resolve()
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => barrier)
  CACHE_WRITE_TAILS.set(key, tail)

  await previous.catch(() => {})
  try {
    return await withCrossProcessCacheLock(root, fn)
  } finally {
    release()
    if (CACHE_WRITE_TAILS.get(key) === tail) CACHE_WRITE_TAILS.delete(key)
  }
}

function cachePath(root) {
  return path.join(path.resolve(root), ".ues-cache", CACHE_FILE)
}

function keyFor(command, args = []) {
  return createHash("sha256")
    .update(JSON.stringify([String(command || ""), (args || []).map(String)]))
    .digest("hex")
}

function receiptReusableAtFingerprint(receipt, fingerprint) {
  if (!validateVerificationReceipt(receipt).valid) return false
  if (receipt.exitCode !== 0 || receipt.passed !== true) return false
  if (!Number.isFinite(Date.parse(receipt.startedAt || ""))) return false
  if (!Number.isFinite(Date.parse(receipt.finishedAt || ""))) return false
  return Boolean(
    receipt.workspaceBefore &&
    receipt.workspaceAfter &&
    receipt.workspaceBefore === receipt.workspaceAfter &&
    receipt.workspaceAfter === fingerprint
  )
}

function entryMatchesKey(key, entry) {
  const receipt = entry?.receipt
  if (!receipt || !String(receipt.command || "").trim()) return false
  if (!Array.isArray(receipt.args)) return false
  return keyFor(receipt.command, receipt.args) === key
}

function finishedAtMs(entry) {
  const value = Date.parse(entry?.finishedAt || entry?.receipt?.finishedAt || "")
  return Number.isFinite(value) ? value : null
}

function freshEnough(entry, maxAgeMs, now = Date.now()) {
  const finished = finishedAtMs(entry)
  if (finished == null) return false
  if (finished > now + 60_000) return false
  if (!maxAgeMs) return true
  return now - finished <= maxAgeMs
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
  const temp = file + "." + process.pid + "." + Date.now() + "." + randomUUID() + ".tmp"
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
  const key = keyFor(command, args)
  const entry = cache.entries[key]
  if (!entry || !entryMatchesKey(key, entry)) return null
  if (!freshEnough(entry, maxAgeMs)) return null

  const currentFingerprint = String(options.workspaceFingerprint || runtimeWorkspaceFingerprint(root))
  if (!receiptReusableAtFingerprint(entry.receipt, currentFingerprint)) return null

  const stdout = entry.stdoutRef
    ? await getEvidence(root, entry.stdoutRef, { maxBytes: options.maxBytes || 16_000 }).catch(() => null)
    : null
  const stderr = entry.stderrRef
    ? await getEvidence(root, entry.stderrRef, { maxBytes: options.maxBytes || 8_000 }).catch(() => null)
    : null

  return {
    schemaVersion: 1,
    reused: true,
    key,
    receipt: entry.receipt,
    stdoutRef: entry.stdoutRef || null,
    stderrRef: entry.stderrRef || null,
    stdout: stdout?.content || "",
    stderr: stderr?.content || "",
    ageMs: Math.max(0, Date.now() - finishedAtMs(entry)),
  }
}

export async function recordVerification(root, input = {}) {
  root = path.resolve(root)
  const stdout = String(input.stdout || "")
  const stderr = String(input.stderr || "")
  const stdoutEvidence = await putEvidence(root, stdout, {
    kind: "verification-stdout",
    source: input.command || "verification-broker",
    summary: "Captured stdout preserved for reusable verification receipt",
  })
  const stderrEvidence = await putEvidence(root, stderr, {
    kind: "verification-stderr",
    source: input.command || "verification-broker",
    summary: "Captured stderr preserved for reusable verification receipt",
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

  const key = keyFor(input.command, input.args || [])
  await withCacheWriteLock(root, async () => {
    const cache = await readCache(root)
    cache.entries[key] = {
      receipt,
      stdoutRef: stdoutEvidence.ref,
      stderrRef: stderrEvidence.ref,
      finishedAt: receipt.finishedAt,
    }

    // Keep cache small and deterministic.
    const rows = Object.entries(cache.entries)
      .sort((a, b) => (finishedAtMs(b[1]) || 0) - (finishedAtMs(a[1]) || 0))
      .slice(0, 200)
    cache.entries = Object.fromEntries(rows)
    await writeCache(root, cache)
  })

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
  const currentFingerprint = String(options.workspaceFingerprint || runtimeWorkspaceFingerprint(root))
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? 30 * 60_000))
  const limit = Math.max(1, Math.min(50, Number(options.limit || 12)))
  const now = Date.now()
  const cache = await readCache(root)
  const rows = []

  for (const [key, entry] of Object.entries(cache.entries || {})) {
    const receipt = entry?.receipt
    if (!entryMatchesKey(key, entry)) continue
    if (!receiptReusableAtFingerprint(receipt, currentFingerprint)) continue
    const finished = finishedAtMs(entry)
    if (!freshEnough(entry, maxAgeMs, now)) continue
    rows.push({
      key,
      receipt,
      stdoutRef: entry.stdoutRef || null,
      stderrRef: entry.stderrRef || null,
      finishedAt: entry.finishedAt || receipt.finishedAt || null,
    })
  }

  rows.sort((a, b) => (Date.parse(b.finishedAt || "") || 0) - (Date.parse(a.finishedAt || "") || 0))
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