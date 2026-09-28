import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { defaultModelPolicy, resolveModel } from "./model-policy.mjs"
import { normalizeCapabilityProfile } from "./capability-registry.mjs"
import { normalizePerformanceHistory, recordPerformanceOutcome } from "./model-performance.mjs"

const TIERS = new Set(["light", "standard", "heavy"])

const MODEL_POLICY_WRITE_TAILS = new Map()
const MODEL_POLICY_LOCK_STALE_MS = 15_000
const MODEL_POLICY_LOCK_WAIT_MS = 20_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function modelPolicyLockDir(configDir) {
  return modelPolicyFile(configDir) + ".lock"
}

async function withCrossProcessModelPolicyLock(configDir, fn) {
  const lockDir = modelPolicyLockDir(configDir)
  await mkdir(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + MODEL_POLICY_LOCK_WAIT_MS
  let delayMs = 8
  while (true) {
    try {
      await mkdir(lockDir)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(lockDir).catch(() => null)
      if (info && Date.now() - info.mtimeMs > MODEL_POLICY_LOCK_STALE_MS) {
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
      if (Date.now() >= deadline) throw new Error("Timed out waiting for model-policy write lock")
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

async function withModelPolicyWriteLock(configDir, fn) {
  const key = path.resolve(configDir)
  const previous = MODEL_POLICY_WRITE_TAILS.get(key) || Promise.resolve()
  let release
  const barrier = new Promise((resolve) => { release = resolve })
  const tail = previous.catch(() => {}).then(() => barrier)
  MODEL_POLICY_WRITE_TAILS.set(key, tail)

  await previous.catch(() => {})
  try {
    return await withCrossProcessModelPolicyLock(configDir, fn)
  } finally {
    release()
    if (MODEL_POLICY_WRITE_TAILS.get(key) === tail) MODEL_POLICY_WRITE_TAILS.delete(key)
  }
}

function validModelID(value) {
  return typeof value === "string" && /^[^\s/]+\/[^\s#]+(?:#[^\s]+)?$/.test(value)
}

function normalize(policy) {
  const base = defaultModelPolicy()
  const input = policy && typeof policy === "object" ? policy : {}
  const tiers = { ...base.tiers }
  for (const tier of TIERS) {
    const value = input.tiers?.[tier]
    if (value === null || validModelID(value)) tiers[tier] = value
  }

  const roleTiers = { ...base.roleTiers }
  for (const [role, tier] of Object.entries(input.roleTiers || {})) {
    if (TIERS.has(tier)) roleTiers[role] = tier
  }

  const capabilities = {}
  for (const [model, profile] of Object.entries(input.capabilities || {})) {
    if (validModelID(model)) capabilities[model] = normalizeCapabilityProfile(profile)
  }

  const performance = normalizePerformanceHistory(input.performance || {})

  return {
    schemaVersion: 3,
    enabled: input.enabled === true,
    maxEscalations: Number.isInteger(input.maxEscalations)
      ? Math.max(0, Math.min(input.maxEscalations, 2))
      : base.maxEscalations,
    tiers,
    roleTiers,
    capabilities,
    performance,
    performanceMinSamples: Number.isInteger(input.performanceMinSamples) ? Math.max(1, Math.min(input.performanceMinSamples, 20)) : base.performanceMinSamples,
  }
}

export function modelPolicyFile(configDir) {
  return path.join(path.resolve(configDir), ".ues", "model-policy.json")
}

export async function readModelPolicy(configDir) {
  const file = modelPolicyFile(configDir)
  if (!existsSync(file)) return { ...defaultModelPolicy(), file }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return { ...normalize(parsed), file }
  } catch {
    return { ...defaultModelPolicy(), file, invalid: true }
  }
}

async function persistModelPolicy(configDir, current, patch = {}) {
  const merged = normalize({
    ...current,
    ...patch,
    tiers: { ...current.tiers, ...(patch.tiers || {}) },
    roleTiers: { ...current.roleTiers, ...(patch.roleTiers || {}) },
    capabilities: { ...(current.capabilities || {}), ...(patch.capabilities || {}) },
    performance: patch.performance || current.performance || {},
  })
  const file = modelPolicyFile(configDir)
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp"
  await writeFile(temp, JSON.stringify(merged, null, 2) + "\n", "utf8")
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  return { ...merged, file }
}

export async function writeModelPolicy(configDir, patch = {}) {
  return withModelPolicyWriteLock(configDir, async () => {
    const current = await readModelPolicy(configDir)
    return persistModelPolicy(configDir, current, patch)
  })
}

export function validateModelID(value) {
  return validModelID(value)
}

export function applyConfiguredModel(source, role, policy) {
  if (!policy?.enabled) return source
  const resolved = resolveModel(role, 1, policy)
  if (!resolved.model) return source

  const lines = String(source).split(/\r?\n/)
  const start = lines.indexOf("---")
  const end = lines.indexOf("---", start + 1)
  if (start < 0 || end < 0) return source

  const existing = lines.findIndex((line, index) => index > start && index < end && /^model:\s*/.test(line))
  if (existing >= 0) {
    lines[existing] = "model: " + resolved.model
  } else {
    const mode = lines.findIndex((line, index) => index > start && index < end && /^mode:\s*/.test(line))
    lines.splice(mode >= 0 ? mode + 1 : start + 1, 0, "model: " + resolved.model)
  }
  return lines.join("\n")
}

export async function recordModelPerformance(configDir, outcome = {}) {
  return withModelPolicyWriteLock(configDir, async () => {
    const current = await readModelPolicy(configDir)
    const performance = recordPerformanceOutcome(current.performance || {}, outcome)
    return persistModelPolicy(configDir, current, { performance })
  })
}
