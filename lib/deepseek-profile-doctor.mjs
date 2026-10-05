// V16.7 DeepSeek profile doctor - READ-ONLY diagnostics.
//
// The doctor inspects the profile registry, per-profile lock state and recorded
// auth classifications and produces findings. It is deliberately READ-ONLY in
// the same sense as the V16.5 Reasoning Doctor:
//
//   * It NEVER launches a browser unless the caller explicitly asks for a probe.
//   * It NEVER reads a cookie, token, storageState or credential.
//   * It NEVER logs in, submits a prompt, or mutates a profile directory.
//   * It NEVER reports a state it did not observe: an unprobed profile stays
//     `unknown`, and an unreachable thing stays `unreachable`.
//
// Findings carry a severity: `ok`, `info`, `warn`, `error`. `error` findings
// make `ues deepseek doctor` exit non-zero, so CI and scripts can rely on it.

import { DEEPSEEK_AUTH_POLICY, AUTH_STATE } from "./deepseek-auth-lifecycle.mjs"
import { inspectProfileLock } from "./deepseek-profile-lock.mjs"
import {
  describeRegistry,
  resolveActiveProfile,
  PROFILE_STATE,
  PROFILE_REGISTRY_REASON,
} from "./deepseek-profile-registry.mjs"
import { getUesConfigDir } from "./runtime-config.mjs"

export const PROFILE_DOCTOR_SCHEMA_VERSION = 1
export const PROFILE_DOCTOR_POLICY = "deepseek-profile-doctor-v16-7"

export const FINDING_SEVERITY = Object.freeze({
  OK: "ok",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
})

const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, error: 3 }

function finding(severity, code, message, detail = null) {
  return { severity, code, message, detail }
}

/**
 * Build the read-only doctor report.
 *
 * @param {{
 *   configDir?: string,
 *   profile?: string,
 *   probe?: {name: string, state: string, reason?: string, at?: number} | null,
 * }} options
 */
export function profileDoctor(options = /** @type {any} */ ({})) {
  const configDir = options.configDir ?? getUesConfigDir()
  const registry = describeRegistry(configDir)
  const findings = []

  // 1. Registry integrity.
  if (registry.corrupt) {
    findings.push(finding(
      FINDING_SEVERITY.ERROR,
      "registry-corrupt",
      `Profile registry is unreadable: ${registry.path}. Run "ues deepseek profiles" to inspect, then repair or remove it.`,
    ))
  } else if (registry.reason === PROFILE_REGISTRY_REASON.NO_REGISTRY) {
    findings.push(finding(
      FINDING_SEVERITY.INFO,
      "registry-absent",
      `No profile registry yet. Add one with "ues deepseek login --profile <name>".`,
    ))
  } else {
    findings.push(finding(FINDING_SEVERITY.OK, "registry-readable", `Profile registry readable at ${registry.path}.`))
  }

  // 2. Active profile.
  const active = resolveActiveProfile({ configDir, profile: options.profile })
  if (active.ok) {
    if (active.source === "argument") {
      findings.push(finding(FINDING_SEVERITY.INFO, "profile-from-argument", `Using profile "${active.name}" from --profile.`))
    } else {
      findings.push(finding(FINDING_SEVERITY.OK, "active-profile", `Active profile is "${active.name}".`))
    }
  } else if (active.reason === PROFILE_REGISTRY_REASON.NO_ACTIVE) {
    findings.push(finding(
      FINDING_SEVERITY.WARN,
      "no-active-profile",
      registry.count > 0
        ? "No active profile selected. Run \"ues deepseek use <name>\" to select one (never auto-selected)."
        : "No profile configured. Run \"ues deepseek login --profile personal\" to create and sign in to one.",
    ))
  } else if (active.reason === PROFILE_REGISTRY_REASON.CORRUPT) {
    findings.push(finding(FINDING_SEVERITY.ERROR, "active-unresolvable", "Cannot resolve active profile: registry is corrupt."))
  }

  // 3. Registry / on-disk divergence, per profile.
  const perProfile = []
  for (const row of registry.profiles) {
    const lock = inspectProfileLock(row.name, { configDir })
    const entry = {
      name: row.name,
      id: row.id,
      state: row.state,
      directoryPresent: row.directoryPresent,
      isActive: row.isActive,
      lock: lock.locked ? { locked: true, owner: lock.owner, stale: false } : { locked: false, stale: Boolean(lock.stale), reason: lock.reason },
    }
    perProfile.push(entry)

    if (!row.directoryPresent) {
      findings.push(finding(
        FINDING_SEVERITY.WARN,
        "profile-directory-missing",
        `Profile "${row.name}" is registered but its browser directory is missing. Run "ues deepseek login --profile ${row.name}" to recreate it, or "ues deepseek remove-profile ${row.name}" to drop the record.`,
        { name: row.name },
      ))
    } else if (row.state === PROFILE_STATE.UNKNOWN) {
      findings.push(finding(
        FINDING_SEVERITY.INFO,
        "profile-unprobed",
        `Profile "${row.name}" has never been probed. Run "ues deepseek status --probe" to classify it.`,
        { name: row.name },
      ))
    } else if (row.state === PROFILE_STATE.NEEDS_AUTH) {
      findings.push(finding(
        FINDING_SEVERITY.WARN,
        "profile-needs-auth",
        `Profile "${row.name}" is not signed in. Run "ues deepseek login --profile ${row.name}".`,
        { name: row.name },
      ))
    } else if (row.state === PROFILE_STATE.READY) {
      findings.push(finding(FINDING_SEVERITY.OK, "profile-ready", `Profile "${row.name}" was last observed signed in.`, { name: row.name }))
    }

    if (entry.lock.locked) {
      findings.push(finding(
        FINDING_SEVERITY.INFO,
        "profile-locked",
        `Profile "${row.name}" is locked by pid ${entry.lock.owner?.pid ?? "?"}. Run "ues deepseek status" to see whether that process is still alive.`,
        { name: row.name },
      ))
    }
    if (entry.lock.stale === true && lock.stale === true && lock.owner) {
      findings.push(finding(
        FINDING_SEVERITY.INFO,
        "profile-lock-stale",
        `Profile "${row.name}" has a stale lock (${lock.reason}); the next run will reclaim it automatically.`,
        { name: row.name },
      ))
    }
  }

  if (registry.activeDangling) {
    findings.push(finding(
      FINDING_SEVERITY.ERROR,
      "active-profile-dangling",
      `Active profile "${registry.activeDangling}" is not in the registry. Run "ues deepseek use <name>" to select a registered profile.`,
    ))
  }

  // 4. Explicit probe result (only when the caller ran one).
  if (options.probe && typeof options.probe === "object") {
    const state = String(options.probe.state || "")
    if (state === AUTH_STATE.READY) {
      findings.push(finding(FINDING_SEVERITY.OK, "probe-ready", `Live probe observed a signed-in session for "${options.probe.name}".`))
    } else if (state === AUTH_STATE.NEEDS_AUTH) {
      findings.push(finding(FINDING_SEVERITY.WARN, "probe-needs-auth", `Live probe observed a login wall for "${options.probe.name}". Sign in with "ues deepseek login --profile ${options.probe.name}".`))
    } else {
      findings.push(finding(FINDING_SEVERITY.INFO, "probe-indeterminate", `Live probe could not classify "${options.probe.name}" (${state}). Re-run once the page settles.`))
    }
  }

  let worstRank = 0
  for (const item of findings) {
    worstRank = Math.max(worstRank, SEVERITY_RANK[item.severity])
  }
  const worst = Object.keys(SEVERITY_RANK).find((key) => SEVERITY_RANK[key] === worstRank) || FINDING_SEVERITY.OK

  return {
    schemaVersion: PROFILE_DOCTOR_SCHEMA_VERSION,
    policy: PROFILE_DOCTOR_POLICY,
    authPolicy: DEEPSEEK_AUTH_POLICY,
    readOnly: true,
    ok: worstRank < SEVERITY_RANK[FINDING_SEVERITY.ERROR],
    worstSeverity: worst,
    activeProfile: active.ok ? active.name : null,
    registry: {
      path: registry.path,
      root: registry.root,
      corrupt: registry.corrupt,
      count: registry.count,
      maxProfiles: registry.maxProfiles,
      active: registry.active,
    },
    profiles: perProfile,
    findings,
    errorCount: findings.filter((f) => f.severity === FINDING_SEVERITY.ERROR).length,
    warnCount: findings.filter((f) => f.severity === FINDING_SEVERITY.WARN).length,
    // Safety contract: the doctor is provably read-only.
    safety: {
      readOnly: true,
      browserLaunched: Boolean(options.probe),
      credentialRead: false,
      cookieOrStorageRead: false,
      profileMutated: false,
      loginPerformed: false,
    },
  }
}

/** Render the doctor report as bounded, secret-free text. */
export function renderProfileDoctor(report) {
  const lines = []
  lines.push(`DeepSeek profile doctor - ${report.worstSeverity.toUpperCase()} (read-only)`)
  lines.push(`  registry: ${report.registry.corrupt ? "CORRUPT" : "ok"}  profiles: ${report.registry.count}/${report.registry.maxProfiles}  active: ${report.activeProfile || "(none)"}`)
  lines.push(`  path: ${report.registry.path}`)
  if (report.profiles.length) {
    lines.push("  profiles:")
    for (const row of report.profiles) {
      const lock = row.lock.locked ? ` locked(pid ${row.lock.owner?.pid ?? "?"})` : (row.lock.stale ? " stale-lock" : "")
      lines.push(`    ${row.isActive ? "*" : "-"} ${row.name}  state=${row.state}  dir=${row.directoryPresent ? "present" : "MISSING"}${lock}`)
    }
  }
  lines.push("  findings:")
  for (const item of report.findings) {
    lines.push(`    [${item.severity}] ${item.code}: ${item.message}`)
  }
  return lines.join("\n")
}

export const DEEPSEEK_PROFILE_DOCTOR_EXPORTS = Object.freeze(["profileDoctor", "renderProfileDoctor"])
