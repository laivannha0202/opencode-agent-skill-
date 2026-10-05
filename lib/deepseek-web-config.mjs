// V16.7.1 DeepSeek web-reasoning ENABLEMENT metadata.
//
// Daily UX is `cd <project>; pi`. The user must not have to export
// `UES_WEB_REASONING_LIVE=1` and `UES_WEB_REASONING_MODE=auto` in every shell
// before a consultation can happen. This module persists the SMALL, SAFE
// enablement decision so a one-time `ues deepseek on` is enough, while keeping
// the runtime precedence explicit and auditable:
//
//     env override  >  persisted config  >  built-in default
//
// What is stored is metadata ONLY: whether web reasoning is enabled, the mode
// (off|auto|force) and the profile NAME. There is deliberately no field for a
// cookie, token, password, OTP, storageState or any other credential, and this
// module never opens a browser profile directory. The profile name is validated
// with the same conservative rule the registry uses, so a persisted value can
// never smuggle a path or a traversal sequence into the runtime.
//
// The persisted file lives under `<ues-config>/.ues/web-reasoning.json`, outside
// any repository, so it can never be committed, diffed or swept into a packet.
// Writes are ATOMIC (temp file + rename). A corrupt file is reported, never
// silently "repaired" into a lie: `readWebConfig` returns `{ invalid: true }`
// and the caller falls back to the DEFAULT (never to a half-parsed value).

import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { getUesConfigDir } from "./runtime-config.mjs"

export const WEB_CONFIG_SCHEMA_VERSION = 1
export const WEB_CONFIG_POLICY = "deepseek-web-config-v16-7-1"

export const WEB_CONFIG_FILE = "web-reasoning.json"

export const WEB_CONFIG_MODE = Object.freeze({
  OFF: "off",
  AUTO: "auto",
  FORCE: "force",
})

export const DEFAULT_WEB_MODE = WEB_CONFIG_MODE.AUTO
// The global default when NOTHING is persisted and no env override exists.
// UES keeps its historical posture: web reasoning is OPTIONAL and OFF by
// default. A one-time `ues deepseek login` / `ues deepseek on` persists
// `enabled: true`, after which the daily flow is just `cd <project>; pi`.
// AUTO is the intelligent, proactive posture once enabled; FORCE is never a
// default (V16.7.1 Part 18).
export const DEFAULT_WEB_ENABLED = false

// The SAME conservative name rule the profile registry enforces. Duplicated
// here (not imported) so this module has no import cycle with the registry and
// so the rule is auditable in one place next to the field it guards.
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function isValidWebProfileName(name) {
  const value = String(name ?? "").trim()
  if (!value) return false
  return PROFILE_NAME_RE.test(value)
}

export function normalizeWebMode(value, fallback = DEFAULT_WEB_MODE) {
  const raw = String(value ?? "").trim().toLowerCase()
  if (raw === WEB_CONFIG_MODE.OFF || raw === WEB_CONFIG_MODE.AUTO || raw === WEB_CONFIG_MODE.FORCE) return raw
  return fallback
}

export function normalizeWebConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {}
  const profile = isValidWebProfileName(input.profile) ? String(input.profile).trim() : null
  return {
    schemaVersion: WEB_CONFIG_SCHEMA_VERSION,
    enabled: input.enabled === true ? true : input.enabled === false ? false : DEFAULT_WEB_ENABLED,
    mode: normalizeWebMode(input.mode, DEFAULT_WEB_MODE),
    profile,
  }
}

export function webConfigFile(configDir = getUesConfigDir()) {
  return path.join(path.resolve(configDir), ".ues", WEB_CONFIG_FILE)
}

/**
 * Read the persisted enablement metadata.
 *
 * Returns `{ ...normalizeWebConfig(parsed), file, exists, invalid? }`. A missing
 * file is NOT an error: it means "no persisted decision", and the caller then
 * applies the built-in default. A corrupt file is reported as `invalid: true`
 * AND still normalized to the default so a caller can never act on a partially
 * parsed value.
 */
export async function readWebConfig(configDir = getUesConfigDir()) {
  const file = webConfigFile(configDir)
  if (!existsSync(file)) {
    return { ...normalizeWebConfig({}), file, exists: false }
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return { ...normalizeWebConfig(parsed), file, exists: true }
  } catch {
    return { ...normalizeWebConfig({}), file, exists: true, invalid: true }
  }
}

// In-process serialization of writes, plus a cross-process mkdir lock, mirroring
// the model-policy store. A lost race must never produce a torn JSON file.
const WEB_CONFIG_WRITE_TAILS = new Map()
const WEB_CONFIG_LOCK_STALE_MS = 15_000
const WEB_CONFIG_LOCK_WAIT_MS = 20_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function webConfigLockDir(configDir) {
  return webConfigFile(configDir) + ".lock"
}

async function withCrossProcessLock(configDir, fn) {
  const lockDir = webConfigLockDir(configDir)
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + WEB_CONFIG_LOCK_WAIT_MS
  let delayMs = 8
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      // A stale lock (holder died mid-write) is reclaimed ONLY after the lock
      // directory's own mtime is old AND it has not moved between two stats.
      const first = await stat(lockDir)
      if (first && Date.now() - first.mtimeMs > WEB_CONFIG_LOCK_STALE_MS) {
        const second = await stat(lockDir)
        if (second && second.ino === first.ino && second.mtimeMs === first.mtimeMs) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => {})
          continue
        }
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for web-config write lock")
      await sleep(delayMs)
      delayMs = Math.min(100, delayMs * 2)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function withWriteLock(configDir, fn) {
  const key = path.resolve(configDir)
  const previous = WEB_CONFIG_WRITE_TAILS.get(key) || Promise.resolve()
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => barrier)
  WEB_CONFIG_WRITE_TAILS.set(key, tail)
  await previous.catch(() => {})
  try {
    return await withCrossProcessLock(configDir, fn)
  } finally {
    release()
    if (WEB_CONFIG_WRITE_TAILS.get(key) === tail) WEB_CONFIG_WRITE_TAILS.delete(key)
  }
}

/**
 * Persist a bounded patch of enablement metadata.
 *
 * Only `enabled`, `mode` and `profile` are honored; an unknown key is ignored
 * (there is no field to smuggle anything else into). `profile: null` explicitly
 * clears the persisted profile.
 */
export async function writeWebConfig(configDir = getUesConfigDir(), patch = {}) {
  return withWriteLock(configDir, async () => {
    const current = await readWebConfig(configDir)
    const next = normalizeWebConfig({
      enabled: Object.hasOwn(patch, "enabled") ? patch.enabled : current.enabled,
      mode: Object.hasOwn(patch, "mode") ? patch.mode : current.mode,
      profile: Object.hasOwn(patch, "profile") ? patch.profile : current.profile,
    })
    const file = webConfigFile(configDir)
    await mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(next, null, 2) + "\n", "utf8")
    try {
      await rename(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
    return { ...next, file, exists: true }
  })
}

/**
 * Resolve the EFFECTIVE web enablement with the documented precedence:
 *
 *     env override  >  persisted config  >  built-in default
 *
 * Each field is resolved independently, and the chosen source is reported per
 * field so a runtime can journal exactly WHY it consulted or stayed local.
 *
 * `env` accepts already-read values so the caller (the Pi extension) controls
 * which environment variables it is willing to honor:
 *   - `enabled`  boolean | undefined
 *   - `mode`     string  | undefined
 *   - `profile`  string  | undefined
 *
 * A malformed env value is treated as ABSENT (it falls through to persisted /
 * default) rather than silently coercing to a surprising mode.
 */
export function resolveWebEnablement(options = {}) {
  const persisted = normalizeWebConfig(options.persisted || {})
  const hasPersisted = options.persisted != null && options.persisted.exists !== false

  const env = options.env && typeof options.env === "object" ? options.env : {}
  const defaultMode = normalizeWebMode(options.defaultMode, DEFAULT_WEB_MODE)
  const defaultEnabled = typeof options.defaultEnabled === "boolean" ? options.defaultEnabled : DEFAULT_WEB_ENABLED
  const defaultProfile = isValidWebProfileName(options.defaultProfile) ? String(options.defaultProfile).trim() : null

  let enabled
  let enabledSource
  if (typeof env.enabled === "boolean") {
    enabled = env.enabled
    enabledSource = "env"
  } else if (hasPersisted) {
    enabled = persisted.enabled
    enabledSource = "persisted"
  } else {
    enabled = defaultEnabled
    enabledSource = "default"
  }

  let mode
  let modeSource
  const envMode = String(env.mode ?? "").trim().toLowerCase()
  if (envMode === WEB_CONFIG_MODE.OFF || envMode === WEB_CONFIG_MODE.AUTO || envMode === WEB_CONFIG_MODE.FORCE) {
    mode = envMode
    modeSource = "env"
  } else if (hasPersisted) {
    mode = persisted.mode
    modeSource = "persisted"
  } else {
    mode = defaultMode
    modeSource = "default"
  }

  let profile
  let profileSource
  if (isValidWebProfileName(env.profile)) {
    profile = String(env.profile).trim()
    profileSource = "env"
  } else if (hasPersisted && persisted.profile) {
    profile = persisted.profile
    profileSource = "persisted"
  } else if (defaultProfile) {
    profile = defaultProfile
    profileSource = "default"
  } else {
    profile = null
    profileSource = "none"
  }

  return {
    schemaVersion: WEB_CONFIG_SCHEMA_VERSION,
    policy: WEB_CONFIG_POLICY,
    enabled,
    mode,
    profile,
    // `live` is the derived switch the runtime uses to decide whether a real
    // browser worker may be spawned. Enabled + a non-OFF mode is the ONLY way to
    // get `live: true`; a disabled config can never launch a browser.
    live: enabled === true && mode !== WEB_CONFIG_MODE.OFF,
    sources: {
      enabled: enabledSource,
      mode: modeSource,
      profile: profileSource,
    },
    persisted: {
      exists: hasPersisted,
      invalid: options.persisted?.invalid === true,
    },
  }
}
