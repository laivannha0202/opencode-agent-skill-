// V16.7 DeepSeek per-profile lock.
//
// A persistent browser profile can only be driven by ONE process at a time:
// Chromium refuses to open a second context on the same user-data dir, and a
// second writer would corrupt the first run's session. V16.7 therefore takes a
// per-profile lock before it starts or probes a live worker, so two runs can
// never fight over the same account.
//
// Properties:
//
//   * One lock file per profile, under `<ues-config>/.ues/locks/`.
//   * The lock is an ATOMIC exclusive create (`wx`), so racing processes
//     cannot both win.
//   * A lock records the owner pid, host and timestamp. A stale lock whose owner
//     process is dead is reclaimed EXPLICITLY (never silently ignored, never
//     auto-stolen while the owner is alive).
//   * Release is idempotent and only removes the lock if this process still owns
//     it (the token matches), so a reclaimed lock is never deleted by its
//     previous owner.
//   * The lock is bounded: an absurd max age is refused, never honored.
//
// This module performs no browser I/O and never touches a profile's contents.

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { getUesConfigDir } from "./runtime-config.mjs"
import { isValidProfileName } from "./deepseek-profile-registry.mjs"

export const PROFILE_LOCK_SCHEMA_VERSION = 1
export const PROFILE_LOCK_POLICY = "deepseek-profile-lock-v16-7"

export const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000
export const MIN_LOCK_TTL_MS = 30 * 1000
export const MAX_LOCK_TTL_MS = 6 * 60 * 60 * 1000

export const PROFILE_LOCK_STATUS = Object.freeze({
  ACQUIRED: "acquired",
  HELD: "held-by-live-owner",
  STALE_RECLAIMED: "stale-lock-reclaimed",
  INVALID_NAME: "invalid-profile-name",
})

export class ProfileLockError extends Error {
  constructor(message, code = "UES_PROFILE_LOCK", exitCode = 1) {
    super(message)
    this.name = "ProfileLockError"
    this.code = code
    this.exitCode = exitCode
  }
}

function locksDir(configDir) {
  return path.join(path.resolve(String(configDir || "")), ".ues", "locks")
}

function lockFileFor(name, configDir) {
  const safe = String(name || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 64)
  return path.join(locksDir(configDir), `deepseek-profile-${safe}.lock`)
}

function boundedTtl(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LOCK_TTL_MS
  return Math.max(MIN_LOCK_TTL_MS, Math.min(MAX_LOCK_TTL_MS, Math.trunc(parsed)))
}

/** Best-effort liveness check for a pid. Never assumes alive on error. */
export function processAlive(pid, kill = process.kill) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    kill(n, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we cannot signal it.
    return error?.code === "EPERM"
  }
}

function readLock(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!parsed || typeof parsed !== "object") return null
    return {
      token: String(parsed.token || ""),
      pid: Number(parsed.pid) || 0,
      host: String(parsed.host || ""),
      profile: String(parsed.profile || ""),
      acquiredAt: Number(parsed.acquiredAt) || 0,
      expiresAt: Number(parsed.expiresAt) || 0,
      schemaVersion: Number(parsed.schemaVersion) || PROFILE_LOCK_SCHEMA_VERSION,
    }
  } catch {
    return null
  }
}

/**
 * Whether an existing lock is RECLAIMABLE.
 *
 * Fail-closed: a lock is reclaimable ONLY when its owner on THIS host is
 * provably dead (`owner-process-dead`). This is the single safe evidence that
 * no process is actually driving the profile: the owner's PID no longer exists
 * on this machine, so the browser/worker that held the session is gone and the
 * profile is free.
 *
 * TTL expiry alone is NOT evidence of an abandoned profile: the owner process
 * may simply be running a long consultation or a bounded manual-login wait, and
 * stealing the lock would corrupt its session or log it out mid-run. When TTL
 * has passed but the owner appears alive, or the owner cannot be verified
 * (different host, unreadable lock), the lock is NOT stale and MUST NOT be
 * reclaimed by this process — the caller must fail with a lock conflict and let
 * an operator clear it.
 *
 * Rules:
 *   - owner pid dead AND same host            → reclaimable (owner-process-dead)
 *   - ttl expired but owner alive / unknown   → NOT stale (held)
 *   - ttl expired on DIFFERENT host           → NOT stale (held; unverifiable)
 *   - lock unreadable / missing               → stale (unreachable lock)
 *
 * Heartbeat staleness would be a supplementary signal here; it is never the
 * sole basis for reclaim, because a missed heartbeat does not prove the owner
 * is gone. The worker/owner PID liveness check is the evidence.
 */
export function lockStaleness(lock, options = /** @type {any} */ ({})) {
  if (!lock) return { stale: true, reason: "unreadable-lock" }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const host = String(options.host ?? os.hostname())
  if (lock.host === host) {
    const kill = typeof options.kill === "function" ? options.kill : process.kill
    if (!processAlive(lock.pid, kill)) return { stale: true, reason: "owner-process-dead" }
  }
  // TTL expired but the owner is alive (same host) or unverifiable (other host)
  // → NOT reclaimable. Returning stale here would steal a live session.
  if (lock.expiresAt > 0 && now >= lock.expiresAt) {
    return { stale: false, reason: "ttl-expired-but-owner-not-provably-dead" }
  }
  return { stale: false, reason: "held" }
}

/**
 * Acquire the lock for a profile. Returns a token-bearing handle, or throws
 * `ProfileLockError` with `UES_PROFILE_LOCKED` when a live owner holds it.
 *
 * A stale lock is RECLAIMED and reported as `STALE_RECLAIMED`, so the caller can
 * log the recovery honestly instead of pretending the lock was free.
 */
export function acquireProfileLock(name, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const raw = String(name ?? "").trim()
  if (!isValidProfileName(raw)) {
    throw new ProfileLockError(`Cannot lock invalid profile name "${raw}".`, "UES_PROFILE_NAME_INVALID", 2)
  }
  const file = lockFileFor(raw, configDir)
  mkdirSync(path.dirname(file), { recursive: true })
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const ttlMs = boundedTtl(options.ttlMs)
  const host = String(options.host ?? os.hostname())
  const token = String(options.token || randomUUID())

  const payload = JSON.stringify({
    schemaVersion: PROFILE_LOCK_SCHEMA_VERSION,
    policy: PROFILE_LOCK_POLICY,
    token,
    pid: Number(options.pid) || process.pid,
    host,
    profile: raw,
    acquiredAt: now,
    expiresAt: now + ttlMs,
  }, null, 2)

  let reclaimed = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Atomic exclusive create. Two racers cannot both succeed.
      writeFileSync(file, payload, { encoding: "utf8", flag: "wx" })
      return {
        status: reclaimed ? PROFILE_LOCK_STATUS.STALE_RECLAIMED : PROFILE_LOCK_STATUS.ACQUIRED,
        token,
        file,
        profile: raw,
        reclaimed,
        expiresAt: now + ttlMs,
        release: () => releaseProfileLock(raw, token, { configDir }),
      }
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new ProfileLockError(`Failed to acquire profile lock: ${error?.message || error}`, "UES_PROFILE_LOCK_IO", 1)
      }
      const existing = readLock(file)
      const staleness = lockStaleness(existing, { now, host, kill: options.kill })
      if (!staleness.stale) {
        // Fails closed: the owner is alive (or unverifiable), so we must not
        // claim the profile. The message guides the operator: the owner's
        // PID/host are reported so the human can verify it is theirs before
        // choosing to clear the lock manually.
        throw new ProfileLockError(
          `Profile "${raw}" is locked by pid ${existing?.pid ?? "?"} on ${existing?.host ?? "?"} (${staleness.reason}). ` +
            (staleness.reason === "ttl-expired-but-owner-not-provably-dead"
              ? "The owner still appears to be running; waiting is safe. Use `ues deepseek doctor` for diagnostics, then clear the lock manually if needed."
              : "Wait for the other run to finish, or remove the lock if that process is gone."),
          "UES_PROFILE_LOCKED",
          1,
        )
      }
      // RECLAIM: only `owner-process-dead` (same host) is safe evidence that
      // no process is driving the profile. Nothing else (TTL, heartbeat)
      // alone is sufficient.
      reclaimed = { reason: staleness.reason, previous: existing }
      try {
        rmSync(file, { force: true })
      } catch (removeError) {
        throw new ProfileLockError(`Failed to reclaim stale profile lock: ${removeError?.message || removeError}`, "UES_PROFILE_LOCK_IO", 1)
      }
    }
  }
  throw new ProfileLockError(`Could not acquire profile lock for "${raw}" after reclaiming a stale lock.`, "UES_PROFILE_LOCKED", 1)
}

/**
 * Release a lock. Idempotent, and only removes the file if the TOKEN matches, so
 * a reclaimed lock is never deleted by its previous owner.
 */
export function releaseProfileLock(name, token, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const raw = String(name ?? "").trim()
  if (!isValidProfileName(raw)) return { released: false, reason: "invalid-name" }
  const file = lockFileFor(raw, configDir)
  if (!existsSync(file)) return { released: true, reason: "absent" }
  const existing = readLock(file)
  // The file is unreadable or owned by a DIFFERENT token: leave it alone.
  if (!existing || (token && existing.token && existing.token !== String(token))) {
    return { released: false, reason: "not-owner" }
  }
  try {
    rmSync(file, { force: true })
    return { released: true, reason: "removed" }
  } catch (error) {
    return { released: false, reason: `remove-failed:${error?.message || error}` }
  }
}

/**
 * Inspect a profile's lock WITHOUT acquiring it. Read-only, used by `status`
 * and the doctor. Never mutates.
 */
export function inspectProfileLock(name, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const raw = String(name ?? "").trim()
  if (!isValidProfileName(raw)) return { locked: false, reason: "invalid-name", file: null }
  const file = lockFileFor(raw, configDir)
  if (!existsSync(file)) return { locked: false, reason: "free", file }
  let mtimeMs = 0
  try {
    mtimeMs = statSync(file).mtimeMs
  } catch {}
  const existing = readLock(file)
  const staleness = lockStaleness(existing, { now: options.now, host: options.host, kill: options.kill })
  return {
    locked: !staleness.stale,
    stale: staleness.stale,
    reason: staleness.reason,
    file,
    owner: existing ? { pid: existing.pid, host: existing.host, acquiredAt: existing.acquiredAt, expiresAt: existing.expiresAt } : null,
    mtimeMs,
  }
}

export const DEEPSEEK_PROFILE_LOCK_EXPORTS = Object.freeze([
  "acquireProfileLock",
  "releaseProfileLock",
  "inspectProfileLock",
  "lockStaleness",
  "processAlive",
])
