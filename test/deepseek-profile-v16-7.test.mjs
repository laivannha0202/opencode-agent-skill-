// Sections A-F: the V16.7 DeepSeek account, profile and auth lifecycle.
//
//   A  profile registry (name validation, containment, atomic writes, active
//      authority, no auto-fallback)
//   B  per-profile lock (exclusive, stale reclaim, token-safe release)
//   C  auth lifecycle (fail-closed classification, bounded manual wait, expiry
//      resume request, secret-free report)
//   D  cache isolation by opaque profile id (no cross-account replay)
//   E  profile doctor (read-only, no browser, honest severities)
//   F  privacy contract (no credential/cookie/storage path anywhere)
//
// The invariants asserted here are what makes multiple DeepSeek accounts safe:
// explicit active profile, no cross-account fallback, and credential-free state.

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  MAX_PROFILES,
  PROFILE_REGISTRY_FILE,
  PROFILE_STATE,
  ProfileRegistryError,
  describeRegistry,
  isValidProfileName,
  isReservedProfileName,
  profileDirectoryStatus,
  profileIdFor,
  readProfileRegistry,
  recordProbeResult,
  registerProfile,
  removeProfileRecord,
  resolveActiveProfile,
  resolveProfileDir,
  setActiveProfile,
} from "../lib/deepseek-profile-registry.mjs"
import {
  acquireProfileLock,
  inspectProfileLock,
  lockStaleness,
  processAlive,
  releaseProfileLock,
} from "../lib/deepseek-profile-lock.mjs"
import {
  AUTH_STATE,
  DEEPSEEK_AUTH_POLICY,
  authRecoveryPlan,
  buildAuthReport,
  canContinueWithState,
  classifyLifecycleAuthState,
  expiryResumeRequest,
  manualAuthProgressLabel,
  nextManualAuthWait,
} from "../lib/deepseek-auth-lifecycle.mjs"
import { classifyAuthState as classifyProbeState } from "../lib/browser-profile.mjs"
import { profileDoctor, renderProfileDoctor } from "../lib/deepseek-profile-doctor.mjs"
import { consultCacheKey, createConsultCache } from "../lib/deepseek-consult-cache.mjs"

function tempConfig() {
  return mkdtempSync(path.join(os.tmpdir(), "ues-v167-"))
}

// ---------------------------------------------------------------------------
// A. Profile registry
// ---------------------------------------------------------------------------

test("A1: name validation rejects traversal and reserved names", () => {
  assert.equal(isValidProfileName("personal"), true)
  assert.equal(isValidProfileName("work-2"), true)
  assert.equal(isValidProfileName("a.b_c"), true)
  assert.equal(isValidProfileName(""), false)
  assert.equal(isValidProfileName(".."), false)
  assert.equal(isValidProfileName("../evil"), false)
  assert.equal(isValidProfileName("a/b"), false)
  assert.equal(isValidProfileName("bad name"), false)
  assert.equal(isValidProfileName("x".repeat(65)), false)
  assert.equal(isReservedProfileName(PROFILE_REGISTRY_FILE), true)
  assert.equal(isReservedProfileName("profiles.json"), true)
  assert.equal(isReservedProfileName("personal"), false)
})

test("A2: profile directory is contained to the profiles root", () => {
  const configDir = tempConfig()
  const ok = resolveProfileDir("work", configDir)
  assert.equal(ok.ok, true)
  assert.equal(path.dirname(ok.dir), ok.root)
  const bad = resolveProfileDir("../evil", configDir)
  assert.equal(bad.ok, false)
  assert.equal(bad.dir, null)
})

test("A3: profile id is opaque, stable and name-derived", () => {
  const a = profileIdFor("Work")
  const b = profileIdFor("work")
  const c = profileIdFor("personal")
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^pr-[0-9a-f]{24}$/)
  // Opaque: no directory, path or name fragment leaks into the id.
  assert.equal(a.includes("work"), false)
})

test("A4: registry round-trips and never reports an unregistered active profile", () => {
  const configDir = tempConfig()
  const empty = readProfileRegistry(configDir)
  assert.equal(empty.ok, true)
  assert.equal(empty.reason, "no-registry-yet")
  assert.equal(empty.active, null)

  registerProfile("work", { configDir })
  registerProfile("personal", { configDir })
  const d = describeRegistry(configDir)
  assert.equal(d.count, 2)
  // Second registration becomes active by default.
  assert.equal(d.active, "personal")
  // Every registered profile reports a MISSING directory (never read).
  assert.equal(d.profiles.every((row) => row.state === PROFILE_STATE.MISSING), true)
  assert.equal(d.profiles.every((row) => row.directoryPresent === false), true)
  rmSync(configDir, { recursive: true, force: true })
})

test("A5: registry write is atomic (no partial file observed)", () => {
  const configDir = tempConfig()
  registerProfile("work", { configDir })
  const file = path.join(resolveProfileDir("work", configDir).root, PROFILE_REGISTRY_FILE)
  const parsed = JSON.parse(readFileSync(file, "utf8"))
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.active, "work")
  assert.equal(Array.isArray(parsed.profiles), true)
  // No temp files left behind.
  const dir = path.dirname(file)
  const leftovers = readdirSync(dir).filter((n) => n.includes(".tmp"))
  assert.deepEqual(leftovers, [])
  rmSync(configDir, { recursive: true, force: true })
})

test("A6: a corrupt registry is reported, never silently repaired", () => {
  const configDir = tempConfig()
  const root = resolveProfileDir("work", configDir).root
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, PROFILE_REGISTRY_FILE), "{ not json")
  const read = readProfileRegistry(configDir)
  assert.equal(read.ok, false)
  assert.equal(read.corrupt, true)
  assert.equal(read.reason, "registry-corrupt")
  // Mutating operations refuse rather than clobber unknown state.
  assert.throws(() => registerProfile("personal", { configDir }), (error) => error.code === "UES_PROFILE_REGISTRY_CORRUPT")
  assert.throws(() => setActiveProfile("personal", { configDir }), (error) => error.code === "UES_PROFILE_REGISTRY_CORRUPT")
  rmSync(configDir, { recursive: true, force: true })
})

test("A7: there is NO auto-fallback to a default profile", () => {
  const configDir = tempConfig()
  const none = resolveActiveProfile({ configDir })
  assert.equal(none.ok, false)
  assert.equal(none.reason, "no-active-profile")
  assert.equal(none.name, null)
  // Even after registering profiles, active is only what was explicitly set.
  registerProfile("work", { configDir, select: false })
  assert.equal(resolveActiveProfile({ configDir }).ok, false)
  setActiveProfile("work", { configDir })
  assert.equal(resolveActiveProfile({ configDir }).name, "work")
  rmSync(configDir, { recursive: true, force: true })
})

test("A8: removing the active profile clears it without picking another", () => {
  const configDir = tempConfig()
  registerProfile("work", { configDir })
  registerProfile("personal", { configDir })
  const removed = removeProfileRecord("personal", { configDir })
  assert.equal(removed.clearedActive, true)
  const after = describeRegistry(configDir)
  assert.equal(after.active, null)
  assert.equal(after.count, 1)
  // `work` survives but is NOT silently promoted to active.
  assert.equal(after.profiles[0].name, "work")
  assert.equal(after.profiles[0].isActive, false)
  rmSync(configDir, { recursive: true, force: true })
})

test("A9: duplicate names are idempotent, not duplicated", () => {
  const configDir = tempConfig()
  const first = registerProfile("work", { configDir })
  const second = registerProfile("WORK", { configDir })
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(describeRegistry(configDir).count, 1)
  rmSync(configDir, { recursive: true, force: true })
})

test("A10: profile limit is enforced and reported", () => {
  const configDir = tempConfig()
  for (let i = 0; i < MAX_PROFILES; i += 1) registerProfile(`p${i}`, { configDir, select: false })
  assert.throws(() => registerProfile("overflow", { configDir }), (error) => error.code === "UES_PROFILE_LIMIT")
  rmSync(configDir, { recursive: true, force: true })
})

test("A11: invalid names throw a typed usage error, not a mismatch", () => {
  const configDir = tempConfig()
  for (const bad of ["bad name", "..", "a/b", ""]) {
    assert.throws(
      () => registerProfile(bad, { configDir }),
      (error) => error instanceof ProfileRegistryError && error.exitCode === 2,
      `expected ${JSON.stringify(bad)} to be rejected`,
    )
  }
  rmSync(configDir, { recursive: true, force: true })
})

test("A12: probe results are recorded per profile and never guessed", () => {
  const configDir = tempConfig()
  registerProfile("work", { configDir })
  const none = recordProbeResult("missing", PROFILE_STATE.READY, { configDir })
  assert.equal(none.updated, false)
  const ok = recordProbeResult("work", PROFILE_STATE.READY, { configDir })
  assert.equal(ok.updated, true)
  assert.equal(ok.state, PROFILE_STATE.READY)
  const row = describeRegistry(configDir).profiles[0]
  // Directory still absent, so state is honestly reported MISSING even though a
  // probe was once recorded: presence and probe are tracked separately.
  assert.equal(row.directoryPresent, false)
  assert.equal(row.state, PROFILE_STATE.MISSING)
  assert.equal(row.storedState, PROFILE_STATE.READY)
  rmSync(configDir, { recursive: true, force: true })
})

test("A13: profile directory status is metadata-only", () => {
  const configDir = tempConfig()
  registerProfile("work", { configDir })
  const before = profileDirectoryStatus("work", configDir)
  assert.equal(before.exists, false)
  mkdirSync(resolveProfileDir("work", configDir).dir, { recursive: true })
  const after = profileDirectoryStatus("work", configDir)
  assert.equal(after.exists, true)
  assert.equal(after.ok, true)
  rmSync(configDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// B. Per-profile lock
// ---------------------------------------------------------------------------

test("B1: a lock is exclusive within a live owner", () => {
  const configDir = tempConfig()
  const handle = acquireProfileLock("work", { configDir })
  assert.equal(handle.status, "acquired")
  assert.throws(() => acquireProfileLock("work", { configDir }), (error) => error.code === "UES_PROFILE_LOCKED")
  const released = handle.release()
  assert.equal(released.released, true)
  rmSync(configDir, { recursive: true, force: true })
})

test("B2: a stale lock (dead owner) is reclaimed, and the reclaim is reported", () => {
  const configDir = tempConfig()
  // Owner pid is provably dead on this host.
  acquireProfileLock("work", { configDir, pid: 999_999 })
  const reclaimed = acquireProfileLock("work", { configDir })
  assert.equal(reclaimed.status, "stale-lock-reclaimed")
  assert.equal(reclaimed.reclaimed.reason, "owner-process-dead")
  rmSync(configDir, { recursive: true, force: true })
})

test("B3: an expired TTL lock is NOT reclaimed while the owner is still alive (fail-closed)", () => {
  const configDir = tempConfig()
  acquireProfileLock("work", { configDir, ttlMs: 30_000 }) // owner = this process
  // Simulate 60s later: TTL has expired, but the owner is provably alive, so
  // TTL alone must NOT reclaim the lock. Reclaim is reserved for dead owners.
  assert.throws(
    () => acquireProfileLock("work", { configDir, now: Date.now() + 60_000 }),
    (error) => error.code === "UES_PROFILE_LOCKED"
  )
  rmSync(configDir, { recursive: true, force: true })
})

test("B4: release is token-safe (a non-owner cannot remove a live lock)", () => {
  const configDir = tempConfig()
  const handle = acquireProfileLock("work", { configDir })
  const wrong = releaseProfileLock("work", "not-the-token", { configDir })
  assert.equal(wrong.released, false)
  assert.equal(wrong.reason, "not-owner")
  // The original owner can still release.
  assert.equal(releaseProfileLock("work", handle.token, { configDir }).released, true)
  rmSync(configDir, { recursive: true, force: true })
})

test("B5: lock inspection is read-only and never acquires", () => {
  const configDir = tempConfig()
  const free = inspectProfileLock("work", { configDir })
  assert.equal(free.locked, false)
  assert.equal(free.reason, "free")
  const handle = acquireProfileLock("work", { configDir })
  const held = inspectProfileLock("work", { configDir })
  assert.equal(held.locked, true)
  assert.equal(held.owner.pid > 0, true)
  handle.release()
  rmSync(configDir, { recursive: true, force: true })
})

test("B6: staleness never steals a lock from another host on liveness", () => {
  const lock = { token: "t", pid: 999_999, host: "some-other-host", expiresAt: Date.now() + 600_000 }
  const staleness = lockStaleness(lock, { host: "this-host" })
  assert.equal(staleness.stale, false)
})

test("B7: processAlive is conservative", () => {
  assert.equal(processAlive(0), false)
  assert.equal(processAlive(-1), false)
  assert.equal(processAlive(process.pid), true)
  assert.equal(processAlive(999_999), false)
})

// ---------------------------------------------------------------------------
// C. Auth lifecycle
// ---------------------------------------------------------------------------

test("C1: only a positive READY observation classifies as ready", () => {
  const ready = classifyProbeState({ url: "https://chat.deepseek.com/a/chat/s/1", composerVisible: true, answerRegions: 2 })
  assert.equal(classifyLifecycleAuthState(ready).state, AUTH_STATE.READY)
  // Composer but no session signal is NOT ready.
  const bare = classifyProbeState({ url: "https://chat.deepseek.com/", composerVisible: true, historyCount: 0 })
  assert.equal(classifyLifecycleAuthState(bare).state, AUTH_STATE.INDETERMINATE)
  // Login wall is NEEDS_AUTH.
  const wall = classifyProbeState({ url: "https://chat.deepseek.com/login", text: "sign in" })
  assert.equal(classifyLifecycleAuthState(wall).state, AUTH_STATE.NEEDS_AUTH)
})

test("C2: a prior READY plus a login wall is EXPIRED (mid-task expiry)", () => {
  const wall = classifyProbeState({ url: "https://chat.deepseek.com/login", text: "please log in" })
  const expired = classifyLifecycleAuthState(wall, { previousState: AUTH_STATE.READY })
  assert.equal(expired.state, AUTH_STATE.EXPIRED)
  assert.equal(expired.humanActionRequired, true)
})

test("C3: unknown probe states never become READY", () => {
  for (const raw of ["", "WEIRD", "TIMEOUT", "UI_CHANGED", "UNKNOWN", undefined]) {
    const state = classifyLifecycleAuthState({ state: raw }).state
    assert.notEqual(state, AUTH_STATE.READY)
    assert.equal(state, AUTH_STATE.INDETERMINATE)
  }
})

test("C4: continue gate only passes READY", () => {
  assert.equal(canContinueWithState(AUTH_STATE.READY).continue, true)
  for (const state of [AUTH_STATE.NEEDS_AUTH, AUTH_STATE.EXPIRED, AUTH_STATE.INDETERMINATE, AUTH_STATE.NOT_PROBED]) {
    assert.equal(canContinueWithState(state).continue, false, state)
  }
  assert.equal(canContinueWithState(AUTH_STATE.EXPIRED).resumeRequired, true)
})

test("C5: recovery plan never substitutes an account", () => {
  for (const state of [AUTH_STATE.NEEDS_AUTH, AUTH_STATE.EXPIRED, AUTH_STATE.INDETERMINATE, AUTH_STATE.NOT_PROBED]) {
    const plan = authRecoveryPlan({ state, midTask: true, profile: "work" })
    assert.equal(plan.substituteAccount, false, state)
    assert.equal(plan.profile, "work")
  }
  const midExpiry = authRecoveryPlan({ state: AUTH_STATE.EXPIRED, midTask: true })
  assert.equal(midExpiry.needsResumeCapsule, true)
  assert.equal(midExpiry.humanActionRequired, true)
})

test("C6: bounded manual wait honours probes, wall clock and infra failures", () => {
  const wall = classifyProbeState({ url: "https://chat.deepseek.com/login", text: "sign in" })
  const ready = classifyProbeState({ url: "https://chat.deepseek.com/a/chat/s/1", composerVisible: true, answerRegions: 1 })
  const waiting = nextManualAuthWait({ attempt: 1, observation: wall })
  assert.equal(waiting.terminal, false)
  assert.equal(waiting.humanActionRequired, true)
  assert.equal(nextManualAuthWait({ attempt: 1, observation: ready }).terminal, true)
  assert.equal(nextManualAuthWait({ attempt: 90, observation: wall }).reason, "max-probes-reached")
  assert.equal(nextManualAuthWait({ attempt: 5, observation: wall, elapsedMs: 999_999 }).reason, "wall-clock-bound-reached")
  // Infra failures are terminal immediately and never reported as READY.
  assert.equal(nextManualAuthWait({ attempt: 2, navigationOk: false }).state, AUTH_STATE.INDETERMINATE)
  assert.equal(nextManualAuthWait({ attempt: 2, closed: true }).terminal, true)
  assert.match(manualAuthProgressLabel(AUTH_STATE.READY, 3, 90), /READY/)
})

test("C7: expiry resume request is credential-free and bounded", () => {
  const request = expiryResumeRequest({ state: AUTH_STATE.EXPIRED, profile: "work", taskFingerprint: "abc" })
  assert.equal(request.credentialFree, true)
  assert.equal(request.resumeRequired, true)
  assert.equal(request.humanActionRequired, true)
  assert.equal(request.policy, DEEPSEEK_AUTH_POLICY)
  // No secret-shaped keys.
  for (const key of ["credential", "password", "cookie", "token", "storageState"]) {
    assert.equal(Object.hasOwn(request, key), false)
  }
})

test("C8: auth report asserts the full safety contract", () => {
  const report = buildAuthReport({ state: AUTH_STATE.READY, profile: "work" })
  assert.equal(report.readOnly, true)
  assert.equal(report.safety.credentialRead, false)
  assert.equal(report.safety.cookieOrStorageRead, false)
  assert.equal(report.safety.credentialOutput, false)
  assert.equal(report.safety.autofilledCredentials, false)
  assert.equal(report.safety.solvedCaptcha, false)
  assert.equal(report.safety.injectedOtp, false)
  assert.equal(report.safety.substitutedAccount, false)
  assert.equal(report.safety.promptSubmitted, false)
  // NOT_PROBED never claims readiness.
  assert.equal(buildAuthReport({}).canContinue, false)
})

// ---------------------------------------------------------------------------
// D. Cache isolation by opaque profile id
// ---------------------------------------------------------------------------

test("D1: two profiles never share a consult cache entry", () => {
  const base = { workspaceId: "w", head: "h", question: "q", role: "root-cause", provider: "deepseek-web", model: "m" }
  const a = consultCacheKey({ ...base, profileId: profileIdFor("personal") })
  const b = consultCacheKey({ ...base, profileId: profileIdFor("work") })
  assert.notEqual(a, b)
  // Same profile is stable.
  assert.equal(a, consultCacheKey({ ...base, profileId: profileIdFor("personal") }))
})

test("D2: a profile-less run does not reuse a profiled answer", () => {
  const base = { question: "q", provider: "deepseek-web" }
  const none = consultCacheKey({ ...base })
  const profiled = consultCacheKey({ ...base, profileId: profileIdFor("work") })
  assert.notEqual(none, profiled)
})

test("D3: the profile id is opaque in the cache key input", () => {
  const id = profileIdFor("work")
  assert.match(id, /^pr-[0-9a-f]{24}$/)
  const cache = createConsultCache({ maxEntries: 4, ttlMs: 60_000 })
  const base = { question: "q", provider: "deepseek-web", model: "m" }
  const keyA = consultCacheKey({ ...base, profileId: profileIdFor("personal") })
  const keyB = consultCacheKey({ ...base, profileId: profileIdFor("work") })
  cache.put(keyA, { answer: "for-personal" })
  assert.equal(cache.get(keyB), null)
  assert.equal(cache.get(keyA).answer, "for-personal")
})

// ---------------------------------------------------------------------------
// E. Profile doctor (read-only)
// ---------------------------------------------------------------------------

test("E1: doctor on an empty registry is informative and read-only", () => {
  const configDir = tempConfig()
  const report = profileDoctor({ configDir })
  assert.equal(report.readOnly, true)
  assert.equal(report.safety.browserLaunched, false)
  assert.equal(report.safety.profileMutated, false)
  assert.equal(report.safety.credentialRead, false)
  assert.equal(report.safety.loginPerformed, false)
  assert.equal(report.findings.some((f) => f.code === "registry-absent"), true)
  assert.match(renderProfileDoctor(report), /read-only/)
  rmSync(configDir, { recursive: true, force: true })
})

test("E2: a corrupt registry is an ERROR finding and fails the doctor", () => {
  const configDir = tempConfig()
  const root = resolveProfileDir("work", configDir).root
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, PROFILE_REGISTRY_FILE), "garbage")
  const report = profileDoctor({ configDir })
  assert.equal(report.ok, false)
  assert.equal(report.worstSeverity, "error")
  assert.equal(report.findings.some((f) => f.code === "registry-corrupt"), true)
  rmSync(configDir, { recursive: true, force: true })
})

test("E3: doctor flags a registered-but-missing directory without reading it", () => {
  const configDir = tempConfig()
  registerProfile("work", { configDir })
  const report = profileDoctor({ configDir })
  assert.equal(report.findings.some((f) => f.code === "profile-directory-missing"), true)
  // It never converts an unprobed profile into READY.
  assert.equal(report.profiles[0].state, PROFILE_STATE.MISSING)
  rmSync(configDir, { recursive: true, force: true })
})

test("E4: doctor reflects an explicit probe result honestly", () => {
  const configDir = tempConfig()
  registerProfile("work", { configDir })
  const ready = profileDoctor({ configDir, probe: { name: "work", state: AUTH_STATE.READY } })
  assert.equal(ready.findings.some((f) => f.code === "probe-ready"), true)
  assert.equal(ready.safety.browserLaunched, true)
  const needs = profileDoctor({ configDir, probe: { name: "work", state: AUTH_STATE.NEEDS_AUTH } })
  assert.equal(needs.findings.some((f) => f.code === "probe-needs-auth"), true)
  rmSync(configDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// F. Privacy contract
// ---------------------------------------------------------------------------

test("F1: no module exposes a credential/cookie/storage read path", async () => {
  const modules = [
    "../lib/deepseek-profile-registry.mjs",
    "../lib/deepseek-profile-lock.mjs",
    "../lib/deepseek-auth-lifecycle.mjs",
    "../lib/deepseek-profile-doctor.mjs",
  ]
  const forbidden = /(readCookies?\s*\(|getCookie\s*\(|readStorageState\s*\(|storageState\s*:|readToken\s*\(|readCredential\s*\(|readPassword\s*\(|autofill\s*\(|solveCaptcha\s*\(|injectOtp\s*\()/i
  const { readFileSync: rf } = await import("node:fs")
  for (const rel of modules) {
    const url = new URL(rel, import.meta.url)
    const text = rf(url, "utf8")
    assert.equal(forbidden.test(text), false, `${rel} must not expose a credential read path`)
  }
})

test("F2: the registry file never contains a credential-shaped field", () => {
  const configDir = tempConfig()
  registerProfile("work", { configDir })
  const file = path.join(resolveProfileDir("work", configDir).root, PROFILE_REGISTRY_FILE)
  const text = readFileSync(file, "utf8")
  for (const key of ["password", "cookie", "token", "storageState", "secret", "credential"]) {
    assert.equal(new RegExp(`"${key}"`, "i").test(text), false)
  }
  rmSync(configDir, { recursive: true, force: true })
})

test("F3: describeRegistry output is credential-free", () => {
  const configDir = tempConfig()
  registerProfile("personal", { configDir })
  const json = JSON.stringify(describeRegistry(configDir))
  assert.equal(/(password|cookie|token|storageState|credential)/i.test(json), false)
  rmSync(configDir, { recursive: true, force: true })
})
