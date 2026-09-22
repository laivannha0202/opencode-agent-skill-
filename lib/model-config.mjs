import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { defaultModelPolicy, resolveModel } from "./model-policy.mjs"
import { normalizeCapabilityProfile } from "./capability-registry.mjs"
import { normalizePerformanceHistory, recordPerformanceOutcome } from "./model-performance.mjs"

const TIERS = new Set(["light", "standard", "heavy"])

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

export async function writeModelPolicy(configDir, patch = {}) {
  const current = await readModelPolicy(configDir)
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
  await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8")
  return { ...merged, file }
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
  const current = await readModelPolicy(configDir)
  const performance = recordPerformanceOutcome(current.performance || {}, outcome)
  return writeModelPolicy(configDir, { performance })
}
