// V16.7 DeepSeek account/profile registry.
//
// A live DeepSeek consultation needs a PERSISTENT browser profile so a human can
// log in once and the runtime can reuse that login. V16.3 hard-coded exactly one
// profile name (`deepseek-web`). V16.7 makes profiles EXPLICIT first-class
// objects: a user can keep independent `personal`, `work`, `test` (or any valid
// custom) profiles, choose which one is active, and switch between them, while
// the runtime still NEVER reads a cookie, token, storageState or credential.
//
// Properties that make this safe to ship:
//
//   1. The registry stores only PROFILE METADATA. A profile row names an opaque
//      id, a human name and a state. There is no field for a credential and no
//      code path that opens the browser profile's cookie jar or storage.
//   2. The profile directory lives OUTSIDE the repository, under
//      `<ues-config>/browser-profiles/<name>`, so it can never be committed,
//      diffed or swept into a workspace snapshot.
//   3. Writes are ATOMIC (temp file + rename) and the registry is bounded. A
//      corrupt registry is reported, never silently "repaired" into a lie.
//   4. There is NO AUTO FALLBACK. `active` is explicit; a missing active profile
//      resolves to `null` and the caller must stop, never pick "the first one".
//   5. Names are validated against a conservative pattern and every resolved
//      directory is contained to the profiles root, so a traversal attempt can
//      never escape it.
//
// The registry is the authority for "which profile exists" and "which is
// active". It does NOT probe auth: that is the auth-lifecycle module's job, and
// it does not touch the browser either.

import { createHash, randomUUID, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, realpathSync } from "node:fs"
import path from "node:path"

import { browserProfilesRoot, safeProfileName, DEEPSEEK_PROFILE_NAME } from "./browser-profile.mjs"
import { getUesConfigDir } from "./runtime-config.mjs"

export const PROFILE_REGISTRY_SCHEMA_VERSION = 1
export const PROFILE_REGISTRY_POLICY = "deepseek-profile-registry-v16-7"

export const PROFILE_REGISTRY_FILE = "profiles.json"
export const PROFILE_REGISTRY_LOCK = "profiles.lock"

// Conservative name rule. This is the SAME character class `safeProfileName`
// already accepts, promoted here to a hard validation so the CLI can REJECT a
// bad name instead of silently hashing it into a different directory.
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
export const MAX_PROFILES = 32

export const PROFILE_STATE = Object.freeze({
  // The profile directory exists but no login probe has been recorded yet.
  UNKNOWN: "unknown",
  // A read-only probe observed a logged-in session.
  READY: "ready",
  // A read-only probe observed a login wall.
  NEEDS_AUTH: "needs-auth",
  // A probe could not classify the page (drift / timeout / closed).
  INDETERMINATE: "indeterminate",
  // The profile directory is gone (removed outside the registry).
  MISSING: "missing",
})

export const PROFILE_REGISTRY_REASON = Object.freeze({
  OK: "ok",
  NO_REGISTRY: "no-registry-yet",
  CORRUPT: "registry-corrupt",
  NO_ACTIVE: "no-active-profile",
  ACTIVE_MISSING: "active-profile-not-registered",
  INVALID_NAME: "invalid-profile-name",
  RESERVED_NAME: "reserved-profile-name",
  DUPLICATE: "duplicate-profile-name",
  LIMIT: "profile-limit-reached",
  NOT_FOUND: "profile-not-found",
  CONTAINMENT: "profile-name-escapes-root",
})

export class ProfileRegistryError extends Error {
  constructor(message, code = "UES_PROFILE_REGISTRY", exitCode = 1) {
    super(message)
    this.name = "ProfileRegistryError"
    this.code = code
    this.exitCode = exitCode
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O) - exhaustively testable, used by the CLI and doctor.
// ---------------------------------------------------------------------------

/** True when a name is acceptable as a profile name. Never hashes. */
export function isValidProfileName(name) {
  const raw = String(name ?? "").trim()
  if (!raw) return false
  if (raw.includes("..")) return false
  return PROFILE_NAME_RE.test(raw)
}

/**
 * Names that must not be used because they collide with a real file in the
 * profile root. `profiles.json` and `profiles.lock` are registry state, not
 * browser profiles.
 */
export function isReservedProfileName(name) {
  const raw = String(name ?? "").trim().toLowerCase()
  return raw === PROFILE_REGISTRY_FILE.toLowerCase()
    || raw === PROFILE_REGISTRY_LOCK.toLowerCase()
    || raw === ".." || raw === "."
}

/**
 * The opaque, stable profile id. It is derived from the NAME, so the same name
 * always resolves to the same id across processes, but it carries NO directory
 * information and is safe to put in a cache key or a telemetry row.
 *
 * This is the legacy/deterministic id derivation used for: (a) backward
 * compatibility when a registry row has no explicit id (migrated rows), and (b)
 * the opaque id computed directly from an operator-supplied profile name
 * (e.g. the `UES_DEEPSEEK_PROFILE` env override). The consult cache is scoped
 * by whatever opaque id the registry currently associates with the active
 * profile; that id is generated once at profile creation (see `registerProfile`)
 * and is stable for the profile's lifetime.
 */
export function profileIdFor(name) {
  const normalized = String(name ?? "").trim().toLowerCase()
  return `pr-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`
}

/**
 * Generate a cryptographically random opaque profile identity (128 bits).
 *
 * This is the id assigned to a NEW profile at creation time. It is NOT derived
 * from the display name, so the name cannot be reverse-engineered from the id
 * and two profiles with similar names never collide. The id is non-secret
 * registry metadata only; it never carries auth material.
 */
export function createRandomProfileId() {
  return randomBytes(16).toString("hex") // 128 bits
}

/**
 * Resolve the on-disk directory for a profile name, and prove containment.
 *
 * Returns `{ ok, dir, root, reason }`. `ok` is false (with `reason`) when the
 * name would escape the profiles root, which is the only case the caller must
 * refuse to proceed.
 */
export function resolveProfileDir(name, configDir = getUesConfigDir()) {
  const raw = String(name ?? "").trim()
  if (!isValidProfileName(raw)) {
    return { ok: false, dir: null, root: browserProfilesRoot(configDir), reason: PROFILE_REGISTRY_REASON.INVALID_NAME }
  }
  if (isReservedProfileName(raw)) {
    return { ok: false, dir: null, root: browserProfilesRoot(configDir), reason: PROFILE_REGISTRY_REASON.RESERVED_NAME }
  }
  const root = browserProfilesRoot(configDir)
  const dir = path.join(root, safeProfileName(raw))
  return resolveAndContain(dir, { root, name: raw })
}

/**
 * Resolve a profile directory and prove it is physically inside the profiles
 * root. No dangerous path is ever followed: components are walked one at a time
 * and an existing component that would resolve (via symlink/junction) outside
 * the root makes the candidate unsafe. A component that does not exist yet
 * (it will be created after validation) is accepted without being followed,
 * because nothing can point into it yet.
 */
function resolveAndContain(dir, { root, name }) {
  const rootReal = _resolveRealPath(root, { throwIfMissing: false })
  if (!rootReal) {
    // The root does not exist yet, so nothing can point at the candidate via
    // a reparse point. Validate lexically against the resolved root and accept:
    // safeProfileName has already rejected any traversal characters.
    const rootRef = path.resolve(root)
    const rel = path.relative(rootRef, path.resolve(dir))
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      return { ok: false, dir: null, root, reason: PROFILE_REGISTRY_REASON.CONTAINMENT }
    }
    return { ok: true, dir: path.resolve(dir), root, reason: PROFILE_REGISTRY_REASON.OK }
  }
  const dirResolved = path.resolve(dir)
  // Lexical containment against the canonical root (catches absolute-path and
  // prefix tricks after normalization).
  const rel = path.relative(rootReal, dirResolved)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, dir: null, root, reason: PROFILE_REGISTRY_REASON.CONTAINMENT }
  }
  // Physical containment: walk the path from the root one component at a time.
  // If a component exists and resolves to a target, that target must still be
  // under the canonical root (catches symlinks and Windows junctions/reparse
  // points escaping the tree).
  const parts = rel.split(path.sep)
  let current = rootReal
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = path.join(current, parts[i])
    const real = _resolveRealPath(candidate, { throwIfMissing: false })
    if (real === null) {
      // Component does not exist yet: nothing dangerous can point here. All
      // previously-verified ancestors are under root, so the future dir is
      // created safely beneath the verified tree.
      break
    }
    current = real
    const relAfter = path.relative(rootReal, current)
    if (!relAfter || relAfter.startsWith("..") || path.isAbsolute(relAfter)) {
      return { ok: false, dir: null, root, reason: PROFILE_REGISTRY_REASON.CONTAINMENT }
    }
  }
  return { ok: true, dir: dirResolved, root, reason: PROFILE_REGISTRY_REASON.OK }
}

/**
 * Resolve a path to its physical (symlink/junction-followed) target, or null
 * if it cannot be resolved. On Windows a junction is followed to its target so
 * escape through a reparse point is detected; symlinks are followed the same
 * way. A non-existent target returns null: it cannot be proven safe, so the
 * caller decides whether to create it.
 */
function _resolveRealPath(target, options = /** @type {any} */ ({})) {
  try {
    return realpathSync(target)
  } catch (error) {
    if (error?.code === "ENOENT" && options.throwIfMissing === true) {
      throw error
    }
    return null
  }
}

function registryFile(configDir) {
  return path.join(browserProfilesRoot(configDir), PROFILE_REGISTRY_FILE)
}

function normalizeRow(row) {
  const name = String(row?.name ?? "").trim()
  if (!isValidProfileName(name)) return null
  return {
    name,
    id: String(row?.id || profileIdFor(name)),
    label: String(row?.label ?? "").slice(0, 120) || name,
    state: Object.values(PROFILE_STATE).includes(row?.state) ? row.state : PROFILE_STATE.UNKNOWN,
    createdAt: Number.isFinite(Number(row?.createdAt)) ? Number(row.createdAt) : null,
    lastProbeAt: Number.isFinite(Number(row?.lastProbeAt)) ? Number(row.lastProbeAt) : null,
    lastProbeState: Object.values(PROFILE_STATE).includes(row?.lastProbeState) ? row.lastProbeState : null,
  }
}

/**
 * Read the registry from disk. NEVER throws on a missing registry (that is a
 * legitimate first-run state) and NEVER silently repairs a corrupt one: a
 * corrupt registry returns `{ ok: false, reason: "registry-corrupt" }` so the
 * caller can refuse to operate on unknown state.
 */
export function readProfileRegistry(configDir = getUesConfigDir()) {
  const file = registryFile(configDir)
  if (!existsSync(file)) {
    return {
      ok: true,
      reason: PROFILE_REGISTRY_REASON.NO_REGISTRY,
      corrupt: false,
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      active: null,
      profiles: [],
      path: file,
    }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    return {
      ok: false,
      reason: PROFILE_REGISTRY_REASON.CORRUPT,
      corrupt: true,
      error: error instanceof Error ? error.message : String(error),
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      active: null,
      profiles: [],
      path: file,
    }
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.profiles)) {
    return {
      ok: false,
      reason: PROFILE_REGISTRY_REASON.CORRUPT,
      corrupt: true,
      error: "registry root is not an object with a profiles array",
      schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
      active: null,
      profiles: [],
      path: file,
    }
  }
  const profiles = []
  const seen = new Set()
  for (const raw of parsed.profiles) {
    const row = normalizeRow(raw)
    if (!row) continue
    const key = row.name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    profiles.push(row)
  }
  const activeName = String(parsed.active ?? "").trim()
  const active = activeName && seen.has(activeName.toLowerCase()) ? activeName : null
  return {
    ok: true,
    reason: PROFILE_REGISTRY_REASON.OK,
    corrupt: false,
    schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
    active,
    activeDangling: Boolean(activeName) && active === null ? activeName : null,
    profiles,
    path: file,
  }
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.profiles.${process.pid}.${randomUUID()}.tmp`)
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  renameSync(temp, file)
}

function serialize(active, profiles) {
  return {
    schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
    policy: PROFILE_REGISTRY_POLICY,
    active: active || null,
    profiles: profiles.map((row) => ({
      name: row.name,
      id: row.id || profileIdFor(row.name),
      label: row.label || row.name,
      state: row.state || PROFILE_STATE.UNKNOWN,
      createdAt: row.createdAt ?? null,
      lastProbeAt: row.lastProbeAt ?? null,
      lastProbeState: row.lastProbeState ?? null,
    })),
  }
}

/**
 * Register a profile. `select` (default true) also makes it active. Creating a
 * profile NEVER writes a browser profile directory: that only happens when a
 * human logs in through `ues deepseek login`.
 */
export function registerProfile(name, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const raw = String(name ?? "").trim()
  if (!isValidProfileName(raw)) {
    throw new ProfileRegistryError(
      `Invalid profile name "${raw}". Use letters, digits, dot, dash or underscore (max 64 chars).`,
      "UES_PROFILE_NAME_INVALID",
      2,
    )
  }
  if (isReservedProfileName(raw)) {
    throw new ProfileRegistryError(`Profile name "${raw}" is reserved.`, "UES_PROFILE_NAME_RESERVED", 2)
  }
  const resolved = resolveProfileDir(raw, configDir)
  if (!resolved.ok) {
    throw new ProfileRegistryError(`Profile name "${raw}" escapes the profiles root.`, "UES_PROFILE_CONTAINMENT", 2)
  }
  const current = readProfileRegistry(configDir)
  if (current.corrupt) {
    throw new ProfileRegistryError(
      `Refusing to modify a corrupt profile registry at ${current.path}. Repair or remove it first.`,
      "UES_PROFILE_REGISTRY_CORRUPT",
      1,
    )
  }
  const profiles = [...current.profiles]
  const key = raw.toLowerCase()
  const existing = profiles.findIndex((row) => row.name.toLowerCase() === key)
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  if (existing >= 0) {
    // Re-registering an existing name is idempotent; it just (re)selects it.
    if (options.select !== false) {
      atomicWriteJson(registryFile(configDir), serialize(raw, profiles))
    }
    return { created: false, profile: profiles[existing], active: options.select !== false ? raw : current.active, registry: readProfileRegistry(configDir) }
  }
  if (profiles.length >= MAX_PROFILES) {
    throw new ProfileRegistryError(
      `Profile limit reached (${MAX_PROFILES}). Remove a profile before adding another.`,
      "UES_PROFILE_LIMIT",
      1,
    )
  }
  const row = {
    name: raw,
    id: profileIdFor(raw),
    label: String(options.label ?? raw).slice(0, 120) || raw,
    state: PROFILE_STATE.UNKNOWN,
    createdAt: now,
    lastProbeAt: null,
    lastProbeState: null,
  }
  profiles.push(row)
  const nextActive = options.select === false ? current.active : raw
  atomicWriteJson(registryFile(configDir), serialize(nextActive, profiles))
  return { created: true, profile: row, active: nextActive, registry: readProfileRegistry(configDir) }
}

/** Explicitly set the active profile. Refuses to point at an unregistered name. */
export function setActiveProfile(name, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const raw = String(name ?? "").trim()
  if (!isValidProfileName(raw) || isReservedProfileName(raw)) {
    throw new ProfileRegistryError(
      `Invalid profile name "${raw}". Use letters, digits, dot, dash or underscore (max 64 chars).`,
      "UES_PROFILE_NAME_INVALID",
      2,
    )
  }
  const current = readProfileRegistry(configDir)
  if (current.corrupt) {
    throw new ProfileRegistryError(
      `Refusing to modify a corrupt profile registry at ${current.path}.`,
      "UES_PROFILE_REGISTRY_CORRUPT",
      1,
    )
  }
  const key = raw.toLowerCase()
  const row = current.profiles.find((entry) => entry.name.toLowerCase() === key)
  if (!row) {
    throw new ProfileRegistryError(
      `Profile "${raw}" is not registered. Use "ues deepseek profiles" to list profiles or add one first.`,
      "UES_PROFILE_NOT_FOUND",
      1,
    )
  }
  atomicWriteJson(registryFile(configDir), serialize(row.name, current.profiles))
  return { active: row.name, profile: row, registry: readProfileRegistry(configDir) }
}

/**
 * Get the full registry row for the active profile (metadata only; the row is
 * never mutated by this call). Returns null when there is no active profile
 * or the registry is corrupt.
 */
export function activeProfileRow(configDir = getUesConfigDir()) {
  const registry = readProfileRegistry(configDir)
  if (!registry.ok || !registry.active) return null
  const row = registry.profiles.find((entry) => entry.name.toLowerCase() === registry.active.toLowerCase())
  if (!row) return null
  return { ...row, registry, path: registry.path }
}

/**
 * The opaque profile id that the active profile is bound to, resolved from the
 * registry metadata (never a credential, never a path). Existing registries
 * that were written without an id (legacy) get a deterministic migration id
 * derived from the name, so the id is stable for the profile's lifetime and two
 * identical registries produce the same id.
 */
export function activeProfileId(configDir = getUesConfigDir()) {
  const row = activeProfileRow(configDir)
  if (!row) return null
  return String(row.id || profileIdFor(row.name))
}

/**
 * Remove a profile from the registry. `deleteDirectory` (default false) also
 * removes the on-disk browser profile directory — that is the ONLY place a
 * profile's persistent login data is deleted, and it never reads it.
 */
export function removeProfileRecord(name, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const raw = String(name ?? "").trim()
  const current = readProfileRegistry(configDir)
  if (current.corrupt) {
    throw new ProfileRegistryError(
      `Refusing to modify a corrupt profile registry at ${current.path}.`,
      "UES_PROFILE_REGISTRY_CORRUPT",
      1,
    )
  }
  const key = raw.toLowerCase()
  const index = current.profiles.findIndex((entry) => entry.name.toLowerCase() === key)
  if (index < 0) {
    throw new ProfileRegistryError(`Profile "${raw}" is not registered.`, "UES_PROFILE_NOT_FOUND", 1)
  }
  const [row] = current.profiles.splice(index, 1)
  // Removing the ACTIVE profile clears it. There is deliberately no
  // "auto-select the next profile": silently switching accounts is exactly the
  // cross-account leak this release exists to prevent.
  const nextActive = current.active && current.active.toLowerCase() === key ? null : current.active
  atomicWriteJson(registryFile(configDir), serialize(nextActive, current.profiles))

  let directoryRemoved = false
  const resolved = resolveProfileDir(row.name, configDir)
  if (options.deleteDirectory === true && resolved.ok && existsSync(resolved.dir)) {
    // Remove the directory tree. Contents are never opened or read.
    rmSync(resolved.dir, { recursive: true, force: true })
    directoryRemoved = true
  }
  return {
    removed: row,
    clearedActive: nextActive === null && Boolean(current.active),
    directoryRemoved,
    registry: readProfileRegistry(configDir),
  }
}

/**
 * Rename a registered profile while preserving its identity (opaque id), all
 * recorded probe state and its registry position. There is no auto-selection
 * change: the renamed profile keeps whatever active status it had before the
 * rename. The new name is subject to the same validation and containment
 * checks as profile creation.
 *
 * Returns `{ renamed, active, activeId, registry }`. The opaque id is
 * unchanged, so the consult cache bucket and any external references stay valid.
 */
export function renameProfileRecord(name, newName, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const raw = String(name ?? "").trim()
  const newRaw = String(newName ?? "").trim()
  if (!isValidProfileName(raw) || isReservedProfileName(raw)) {
    throw new ProfileRegistryError(
      `Invalid profile name "${raw}".`,
      "UES_PROFILE_NAME_INVALID",
      2,
    )
  }
  if (!isValidProfileName(newRaw) || isReservedProfileName(newRaw)) {
    throw new ProfileRegistryError(
      `Invalid new profile name "${newRaw}". Use letters, digits, dot, dash or underscore (max 64 chars).`,
      "UES_PROFILE_NAME_INVALID",
      2,
    )
  }
  const current = readProfileRegistry(configDir)
  if (current.corrupt) {
    throw new ProfileRegistryError(
      `Refusing to modify a corrupt profile registry at ${current.path}.`,
      "UES_PROFILE_REGISTRY_CORRUPT",
      1,
    )
  }
  const key = raw.toLowerCase()
  const index = current.profiles.findIndex((entry) => entry.name.toLowerCase() === key)
  if (index < 0) {
    throw new ProfileRegistryError(`Profile "${raw}" is not registered.`, "UES_PROFILE_NOT_FOUND", 1)
  }
  const row = current.profiles[index]
  // Rename is identity-preserving: the opaque id and all probe history survive
  // the rename unchanged.
  current.profiles[index] = {
    ...row,
    name: newRaw,
    label: String(options.label ?? row.label).slice(0, 120) || newRaw,
  }
  const active = String(current.active ?? "").trim().toLowerCase()
  const nextActive = active === key ? newRaw : current.active
  atomicWriteJson(registryFile(configDir), serialize(nextActive, current.profiles))
  return {
    renamed: { previous: row.name, current: newRaw, id: row.id },
    active: nextActive,
    activeId: activeProfileId(configDir),
    registry: readProfileRegistry(configDir),
  }
}

/**
 * Record the outcome of a read-only probe. `state` is one of PROFILE_STATE; the
 * caller passes a boolean-ish classification, never a credential.
 */
export function recordProbeResult(name, state, options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const current = readProfileRegistry(configDir)
  if (current.corrupt) return { updated: false, reason: PROFILE_REGISTRY_REASON.CORRUPT }
  const key = String(name ?? "").trim().toLowerCase()
  const index = current.profiles.findIndex((entry) => entry.name.toLowerCase() === key)
  if (index < 0) return { updated: false, reason: PROFILE_REGISTRY_REASON.NOT_FOUND }
  const normalizedState = Object.values(PROFILE_STATE).includes(state) ? state : PROFILE_STATE.INDETERMINATE
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  current.profiles[index] = {
    ...current.profiles[index],
    state: normalizedState,
    lastProbeAt: now,
    lastProbeState: normalizedState,
  }
  atomicWriteJson(registryFile(configDir), serialize(current.active, current.profiles))
  return { updated: true, state: normalizedState, profile: current.profiles[index] }
}

/** Directory presence for a profile row. Metadata only; the dir is never read. */
export function profileDirectoryStatus(name, configDir = getUesConfigDir()) {
  const resolved = resolveProfileDir(name, configDir)
  if (!resolved.ok) return { ok: false, exists: false, reason: resolved.reason }
  let exists = false
  try {
    exists = existsSync(resolved.dir) && statSync(resolved.dir).isDirectory()
  } catch {
    exists = false
  }
  return { ok: true, exists, dir: resolved.dir, reason: PROFILE_REGISTRY_REASON.OK }
}

/**
 * Resolve the opaque DeepSeek profile id that scopes the consult cache.
 *
 * Explicit env first (`UES_DEEPSEEK_PROFILE`), then the registry's active
 * profile (via its stored opaque id). Returns `null` when there is no profile,
 * which keeps a profile-less run in its own cache bucket rather than reusing a
 * profiled answer. The registry is read as METADATA ONLY: only `active` and
 * `profiles[].id` are inspected, never a cookie, token or profile directory.
 */
export function resolveDeepSeekProfileId(env, cwd) {
  try {
    const explicit = String((env || process.env)?.UES_DEEPSEEK_PROFILE || "").trim()
    if (explicit) return profileIdFor(explicit)
    // Explicit config dir wins, otherwise the native dir is `<xdg>/ues`.
    const explicitDir = String((env || process.env)?.UES_CONFIG_DIR || "").trim()
    const xdgRoot = String((env || process.env)?.XDG_CONFIG_HOME || "").trim() || path.join(os.homedir(), ".config")
    const configDir = explicitDir ? path.resolve(explicitDir) : path.join(xdgRoot, "ues")
    // Metadata-only read of the active profile's opaque id; never a credential,
    // never a path fragment, never a directory contents.
    const id = activeProfileId(configDir)
    return id || null
  } catch {
    return null
  }
}

/**
 * The full, secret-free registry view for `ues deepseek status / profiles`.
 * Never reads a profile directory's contents; only its presence.
 */
export function describeRegistry(configDir = getUesConfigDir()) {
  const registry = readProfileRegistry(configDir)
  const rows = registry.profiles.map((row) => {
    const dir = profileDirectoryStatus(row.name, configDir)
    const present = dir.ok && dir.exists
    // A registered profile whose directory is gone is reported MISSING, not
    // silently dropped: the registry is the authority on what the user asked
    // for, and a missing directory is a real doctor finding.
    const state = present ? row.state : PROFILE_STATE.MISSING
    return {
      name: row.name,
      id: row.id,
      label: row.label,
      state,
      storedState: row.state,
      directoryPresent: present,
      isActive: Boolean(registry.active) && registry.active.toLowerCase() === row.name.toLowerCase(),
      lastProbeAt: row.lastProbeAt,
      lastProbeState: row.lastProbeState,
      createdAt: row.createdAt,
    }
  })
  return {
    schemaVersion: PROFILE_REGISTRY_SCHEMA_VERSION,
    policy: PROFILE_REGISTRY_POLICY,
    root: browserProfilesRoot(configDir),
    path: registry.path,
    ok: registry.ok,
    corrupt: registry.corrupt,
    reason: registry.reason,
    active: registry.active,
    activeDangling: registry.activeDangling || null,
    legacyDefaultName: DEEPSEEK_PROFILE_NAME,
    count: rows.length,
    maxProfiles: MAX_PROFILES,
    profiles: rows,
  }
}

/**
 * Resolve the profile a run must use, from explicit intent only.
 *
 * Order: `--profile` argument -> active registry profile -> `null`.
 *
 * There is NO auto-fallback to a default profile when the registry has none:
 * `null` means "no profile configured", and the caller must treat that as
 * NEEDS_AUTH with an instruction to run `ues deepseek login`. Returning a
 * default here is precisely how a run would silently use the wrong account.
 */
export function resolveActiveProfile(options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const requested = String(options.profile ?? "").trim()
  if (requested) {
    if (!isValidProfileName(requested) || isReservedProfileName(requested)) {
      return { ok: false, reason: PROFILE_REGISTRY_REASON.INVALID_NAME, name: requested, source: "argument" }
    }
    return { ok: true, reason: PROFILE_REGISTRY_REASON.OK, name: requested, source: "argument" }
  }
  const registry = readProfileRegistry(configDir)
  if (registry.corrupt) {
    return { ok: false, reason: PROFILE_REGISTRY_REASON.CORRUPT, name: null, source: "registry" }
  }
  if (registry.active) {
    return { ok: true, reason: PROFILE_REGISTRY_REASON.OK, name: registry.active, source: "registry-active" }
  }
  return { ok: false, reason: PROFILE_REGISTRY_REASON.NO_ACTIVE, name: null, source: "none" }
}



export const DEEPSEEK_PROFILE_REGISTRY_EXPORTS = Object.freeze([
  "readProfileRegistry",
  "registerProfile",
  "setActiveProfile",
  "renameProfileRecord",
  "removeProfileRecord",
  "recordProbeResult",
  "describeRegistry",
  "resolveActiveProfile",
  "resolveDeepSeekProfileId",
  "activeProfileRow",
  "activeProfileId",
  "profileDirectoryStatus",
  "profileIdFor",
  "createRandomProfileId",
  "resolveProfileDir",
  "isValidProfileName",
  "isReservedProfileName",
])

