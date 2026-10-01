import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"

const OWNER_DIR = path.join(".ues-work", "execution-owners")
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 30_000
const DEFAULT_TTL_MS = 45_000
const PROCESS_OWNER_ID = process.pid + ":" + randomUUID()
const LOCAL_REFS = new Map()
const LAST_PRUNE_BY_ROOT = new Map()
const DEFAULT_PRUNE_INTERVAL_MS = 60_000
const DEFAULT_ORPHAN_MAX_AGE_MS = 24 * 60 * 60_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function finiteMs(value, fallback, min = 1_000, max = 10 * 60_000) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function nowMs(options = {}) {
  const parsed = Number(options.nowMs)
  return Number.isFinite(parsed) ? parsed : Date.now()
}

function scopeHash(scope) {
  return createHash("sha256").update(String(scope || "")).digest("hex")
}

function cleanScope(scope) {
  const value = String(scope || "").trim()
  if (!value) throw new Error("UES execution ownership requires a non-empty scope")
  return value
}

function cleanToken(token) {
  const value = String(token || "").trim()
  if (!value) throw new Error("UES execution ownership requires a non-empty owner token")
  return value
}

function processAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  if (value === process.pid) return true
  try {
    process.kill(value, 0)
    return true
  } catch (error) {
    if (error?.code === "EPERM") return true
    return false
  }
}

export function executionOwnershipFile(root = process.cwd(), scope = "default") {
  const safeScope = cleanScope(scope)
  return path.join(path.resolve(root), OWNER_DIR, scopeHash(safeScope).slice(0, 40) + ".json")
}

export function executionOwnerToken(scope = "default") {
  const safeScope = cleanScope(scope)
  return "owner:sha256:" + createHash("sha256")
    .update(PROCESS_OWNER_ID + "\0" + safeScope)
    .digest("hex")
}

async function readLeaseFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = file + "." + process.pid + "." + randomUUID().slice(0, 8) + ".tmp"
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  })
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function withOwnershipLock(file, fn) {
  const lockDir = file + ".lock"
  await mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + LOCK_WAIT_MS
  let delay = 5
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockDir).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        const confirmed = await stat(lockDir).catch(() => null)
        if (
          confirmed &&
          confirmed.mtimeMs === info.mtimeMs &&
          confirmed.size === info.size
        ) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) {
        const lockError = new Error("Timed out waiting for UES execution ownership lock")
        lockError.code = "UES_EXECUTION_OWNERSHIP_LOCK_TIMEOUT"
        throw lockError
      }
      await sleep(delay)
      delay = Math.min(80, delay * 2)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

function conflictError(code, message, lease = null) {
  const error = new Error(message)
  error.code = code
  error.lease = lease
  return error
}

export async function pruneExecutionOwnership(root = process.cwd(), options = {}) {
  const resolvedRoot = path.resolve(root)
  const dir = path.join(resolvedRoot, OWNER_DIR)
  const now = nowMs(options)
  const orphanMaxAgeMs = finiteMs(
    options.orphanMaxAgeMs,
    DEFAULT_ORPHAN_MAX_AGE_MS,
    60_000,
    30 * 24 * 60 * 60_000,
  )
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const removed = []
  let active = 0
  let retained = 0

  for (const entry of entries.slice(0, 2000)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const file = path.join(dir, entry.name)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) continue
    await withOwnershipLock(file, async () => {
      const lease = await readLeaseFile(file).catch(() => null)
      if (!lease) {
        if (now - info.mtimeMs >= orphanMaxAgeMs) {
          await rm(file, { force: true }).catch(() => {})
          removed.push(entry.name)
        } else {
          retained += 1
        }
        return
      }
      const expired = Number(lease.expiresAtMs || 0) <= now
      const alive = processAlive(lease.ownerPid)
      const ancient = now - Number(lease.heartbeatAtMs || info.mtimeMs || 0) >= orphanMaxAgeMs
      if ((expired && !alive) || ancient) {
        await rm(file, { force: true }).catch(() => {})
        removed.push(entry.name)
        return
      }
      if (!expired && alive) active += 1
      else retained += 1
    }).catch(() => {
      retained += 1
    })
  }

  await rm(dir, { recursive: false, force: false }).catch(() => {})
  return {
    schemaVersion: 1,
    scanned: Math.min(entries.length, 2000),
    removed,
    removedCount: removed.length,
    active,
    retained,
    bounded: entries.length <= 2000,
  }
}

async function maybePruneExecutionOwnership(root) {
  const resolvedRoot = path.resolve(root)
  const now = Date.now()
  const previous = Number(LAST_PRUNE_BY_ROOT.get(resolvedRoot) || 0)
  if (now - previous < DEFAULT_PRUNE_INTERVAL_MS) return
  LAST_PRUNE_BY_ROOT.set(resolvedRoot, now)
  await pruneExecutionOwnership(resolvedRoot, { nowMs: now }).catch(() => null)
}

export async function claimExecutionOwnership(root, scope, token, options = {}) {
  const safeScope = cleanScope(scope)
  const safeToken = cleanToken(token)
  const file = executionOwnershipFile(root, safeScope)
  await maybePruneExecutionOwnership(root)
  const now = nowMs(options)
  const ttlMs = finiteMs(options.ttlMs, DEFAULT_TTL_MS, 1_000, 10 * 60_000)
  const ownerPid = Number.isInteger(Number(options.ownerPid))
    ? Number(options.ownerPid)
    : process.pid

  const lease = await withOwnershipLock(file, async () => {
    const current = await readLeaseFile(file)
    const sameOwner = current?.ownerToken === safeToken
    const expired = !current || Number(current.expiresAtMs || 0) <= now
    const abandoned = current && !processAlive(current.ownerPid)

    if (current && !sameOwner && !expired && !abandoned) {
      throw conflictError(
        "UES_EXECUTION_OWNERSHIP_CONFLICT",
        "UES execution scope is already owned by a live runtime",
        current,
      )
    }

    const generation = sameOwner
      ? Math.max(1, Number(current?.generation || 1))
      : Math.max(1, Number(current?.generation || 0) + 1)
    const next = {
      schemaVersion: 1,
      scope: safeScope,
      scopeHash: scopeHash(safeScope),
      ownerToken: safeToken,
      ownerPid,
      generation,
      acquiredAtMs: sameOwner && current?.acquiredAtMs
        ? Number(current.acquiredAtMs)
        : now,
      heartbeatAtMs: now,
      expiresAtMs: now + ttlMs,
      runtimeEpochId: options.runtimeEpochId ? String(options.runtimeEpochId) : safeScope,
      stolenFromExpiredOwner: Boolean(current && !sameOwner && (expired || abandoned)),
    }
    await atomicJson(file, next)
    return next
  })

  const refKey = file + "\0" + safeToken
  LOCAL_REFS.set(refKey, Number(LOCAL_REFS.get(refKey) || 0) + 1)
  return { file, lease }
}

export async function renewExecutionOwnership(root, scope, token, options = {}) {
  const safeScope = cleanScope(scope)
  const safeToken = cleanToken(token)
  const file = executionOwnershipFile(root, safeScope)
  const now = nowMs(options)
  const ttlMs = finiteMs(options.ttlMs, DEFAULT_TTL_MS, 1_000, 10 * 60_000)

  const lease = await withOwnershipLock(file, async () => {
    const current = await readLeaseFile(file)
    if (!current) {
      throw conflictError(
        "UES_EXECUTION_OWNERSHIP_MISSING",
        "UES execution ownership lease is missing",
      )
    }
    if (current.ownerToken !== safeToken) {
      throw conflictError(
        "UES_EXECUTION_OWNERSHIP_STALE",
        "UES execution ownership was replaced by another runtime",
        current,
      )
    }
    const next = {
      ...current,
      heartbeatAtMs: now,
      expiresAtMs: now + ttlMs,
      ownerPid: Number.isInteger(Number(options.ownerPid))
        ? Number(options.ownerPid)
        : process.pid,
    }
    await atomicJson(file, next)
    return next
  })
  return { file, lease }
}

export async function assertExecutionOwnership(root, scope, token, options = {}) {
  const safeScope = cleanScope(scope)
  const safeToken = cleanToken(token)
  const file = executionOwnershipFile(root, safeScope)
  const current = await readLeaseFile(file)
  if (!current) {
    throw conflictError(
      "UES_EXECUTION_OWNERSHIP_MISSING",
      "UES execution ownership lease is missing",
    )
  }
  if (current.scope !== safeScope || current.ownerToken !== safeToken) {
    throw conflictError(
      "UES_EXECUTION_OWNERSHIP_STALE",
      "UES execution ownership no longer belongs to this runtime",
      current,
    )
  }
  if (Number(current.expiresAtMs || 0) <= nowMs(options)) {
    throw conflictError(
      "UES_EXECUTION_OWNERSHIP_EXPIRED",
      "UES execution ownership lease expired",
      current,
    )
  }
  if (
    options.runtimeEpochId &&
    String(current.runtimeEpochId || "") !== String(options.runtimeEpochId)
  ) {
    throw conflictError(
      "UES_EXECUTION_OWNERSHIP_EPOCH_MISMATCH",
      "UES execution ownership runtime epoch changed",
      current,
    )
  }
  return { file, lease: current }
}

export async function releaseExecutionOwnership(root, scope, token) {
  const safeScope = cleanScope(scope)
  const safeToken = cleanToken(token)
  const file = executionOwnershipFile(root, safeScope)
  const refKey = file + "\0" + safeToken
  const refs = Math.max(0, Number(LOCAL_REFS.get(refKey) || 0) - 1)
  if (refs > 0) {
    LOCAL_REFS.set(refKey, refs)
    return { released: false, retainedByLocalRefs: refs }
  }
  LOCAL_REFS.delete(refKey)

  return withOwnershipLock(file, async () => {
    const current = await readLeaseFile(file)
    if (!current) return { released: false, reason: "missing" }
    if (current.ownerToken !== safeToken) {
      return { released: false, reason: "ownership-changed", lease: current }
    }
    await rm(file, { force: true })
    return { released: true }
  })
}
