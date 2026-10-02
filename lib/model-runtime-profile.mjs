import { createHash } from "node:crypto"
import { roleContextABI } from "./role-context-abi.mjs"
import { diversityVerificationPolicy } from "./diversity-verification.mjs"
import { compileToolSurface } from "./tool-surface-economy.mjs"

export const MODEL_RUNTIME_SURFACE = Object.freeze({
  COMPACT: "compact",
  BALANCED: "balanced",
  EXPANDED: "expanded",
})

const COMPACT_HINT = /(?:flash|mini|small|lite|light|free|step[-_. ]?3|nemotron.*lightning|(?:^|[\/_.-])(?:7b|8b|12b|14b)(?:$|[\/_.-]))/i
const EXPANDED_HINT = /(?:opus|sonnet|codex|gpt[-_. ]?(?:5|6)|gemini.*pro|claude.*(?:opus|sonnet))/i

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function empiricalSurface(record = {}, minSamples = 8) {
  const samples = Math.max(0, Number(record?.samples || 0))
  if (samples < Math.max(1, Number(minSamples || 8))) return null
  const passRate = Math.max(0, Math.min(1, Number(record?.passRate || 0)))
  const retries = Math.max(0, Number(record?.avgRetries || 0))
  if (passRate >= 0.85 && retries <= 0.5) {
    return { surface: MODEL_RUNTIME_SURFACE.EXPANDED, reason: "measured-model-performance" }
  }
  if (passRate <= 0.60 || retries >= 1.5) {
    return { surface: MODEL_RUNTIME_SURFACE.COMPACT, reason: "measured-model-performance" }
  }
  return { surface: MODEL_RUNTIME_SURFACE.BALANCED, reason: "measured-model-performance" }
}

function capabilitySurface(profile = {}) {
  if (!profile || typeof profile !== "object") return null
  const quality = Number(profile.quality)
  if (!Number.isFinite(quality)) return null
  if (quality >= 0.80 && profile.reasoning === true && profile.toolCalling !== false) {
    return { surface: MODEL_RUNTIME_SURFACE.EXPANDED, reason: "configured-model-capabilities" }
  }
  if (quality <= 0.55 || profile.reasoning === false || profile.toolCalling === false) {
    return { surface: MODEL_RUNTIME_SURFACE.COMPACT, reason: "configured-model-capabilities" }
  }
  return { surface: MODEL_RUNTIME_SURFACE.BALANCED, reason: "configured-model-capabilities" }
}

export function classifyModelRuntimeSurface(model, options = {}) {
  const empirical = empiricalSurface(options.performanceRecord, options.performanceMinSamples)
  if (empirical) return empirical
  const capability = capabilitySurface(options.capabilityProfile)
  if (capability) return capability

  const value = String(model || "")
  if (COMPACT_HINT.test(value)) return { surface: MODEL_RUNTIME_SURFACE.COMPACT, reason: "model-name-compact-surface-hint" }
  if (EXPANDED_HINT.test(value)) return { surface: MODEL_RUNTIME_SURFACE.EXPANDED, reason: "model-name-expanded-surface-hint" }
  return { surface: MODEL_RUNTIME_SURFACE.BALANCED, reason: "default-balanced-surface" }
}

function surfaceTable(surface, executionProfile = "standard") {
  const profile = ["fast", "standard", "deep"].includes(String(executionProfile || "").toLowerCase())
    ? String(executionProfile).toLowerCase()
    : "standard"
  const toolLimits = {
    compact: { fast: 7, standard: 9, deep: 10 },
    balanced: { fast: 8, standard: 12, deep: 15 },
    expanded: { fast: 10, standard: 16, deep: 20 },
  }
  const table = {
    compact: {
      maxParallelReads: 3,
      contextBudgetRatio: 1,
      searchResultLimit: 24,
      maxSkillMetadata: 8,
      toolOutputChars: 16 * 1024,
      scaffoldLevel: "high",
      delegationBreadth: 2,
    },
    balanced: {
      maxParallelReads: 4,
      contextBudgetRatio: 1,
      searchResultLimit: 40,
      maxSkillMetadata: 12,
      toolOutputChars: 24 * 1024,
      scaffoldLevel: "medium",
      delegationBreadth: 4,
    },
    expanded: {
      maxParallelReads: 6,
      contextBudgetRatio: 1,
      searchResultLimit: 64,
      maxSkillMetadata: 18,
      toolOutputChars: 40 * 1024,
      scaffoldLevel: "low",
      delegationBreadth: 6,
    },
  }
  const selected = table[surface] || table.balanced
  const limits = toolLimits[surface] || toolLimits.balanced
  return { ...selected, maxAdvertisedTools: limits[profile] }
}

export function modelRuntimeProfile(model, options = {}) {
  const classified = classifyModelRuntimeSurface(model, options)
  const executionProfile = String(options.executionProfile || "standard").toLowerCase()
  const base = surfaceTable(classified.surface, executionProfile)
  const attempt = Math.max(1, Math.trunc(Number(options.attempt || 1)))
  const role = String(options.role || "")
  const normalizedRole = role.replace(/^ues-/, "")
  const architectEditor =
    classified.surface === MODEL_RUNTIME_SURFACE.COMPACT &&
    (executionProfile === "deep" || attempt > 1) &&
    ["executor", "architect", "debugger"].includes(normalizedRole)
  const roleABI = roleContextABI(normalizedRole || "executor", {
    freshContextRequired: options.freshContextRequired === true,
  })
  const verificationDiversity = normalizedRole.includes("verifier")
    ? diversityVerificationPolicy({
        risk: options.risk || "medium",
        executorModel: options.executorModel || model,
        alternateModels: options.alternateModels || [],
        requireCrossModelForCritical: options.requireCrossModelForCritical === true,
      })
    : null
  const payload = {
    schemaVersion: 4,
    model: String(model || ""),
    surface: classified.surface,
    reason: classified.reason,
    evidenceSource: classified.reason.startsWith("measured-")
      ? "MEASURED"
      : classified.reason === "configured-model-capabilities"
        ? "CONFIGURED"
        : "HEURISTIC",
    maxAdvertisedTools: base.maxAdvertisedTools,
    maxParallelReads: base.maxParallelReads,
    contextBudgetRatio: base.contextBudgetRatio,
    contextBudgetPolicy: "measurement-gated",
    searchResultLimit: base.searchResultLimit,
    maxSkillMetadata: base.maxSkillMetadata,
    toolOutputChars: base.toolOutputChars,
    scaffoldLevel: base.scaffoldLevel,
    delegationBreadth: base.delegationBreadth,
    editPipeline: architectEditor ? "architect-editor" : "direct",
    preservesThinkingLevel: true,
    executionProfile,
    attempt,
    role: role || null,
    roleContextABI: roleABI,
    verificationDiversity,
    modelSpecificACI: true,
  }
  return Object.freeze({
    ...payload,
    id: "model-profile:sha256:" + hash(payload),
  })
}

export function compileModelAciProfile(model, options = {}) {
  const profile = modelRuntimeProfile(model, options)
  const payload = {
    schemaVersion: 2,
    model: profile.model,
    profileId: profile.id,
    surface: profile.surface,
    toolSurface: {
      maxAdvertisedTools: profile.maxAdvertisedTools,
      maxParallelReads: profile.maxParallelReads,
      searchResultLimit: profile.searchResultLimit,
      outputChars: profile.toolOutputChars,
      deferredTools: true,
      stableSchemaOrder: true,
    },
    skillSurface: {
      mode: "metadata-first",
      maxMetadataEntries: profile.maxSkillMetadata,
      fullBodiesOnDemand: true,
    },
    contextSurface: {
      budgetRatio: profile.contextBudgetRatio,
      roleContextABI: profile.roleContextABI,
      deterministicRehydration: true,
    },
    delegation: {
      maxBreadth: profile.delegationBreadth,
      scaffoldLevel: profile.scaffoldLevel,
    },
    verification: profile.verificationDiversity,
    policy: {
      compileVisibilityBeforePrompt: true,
      runtimePermissionCheckStillAuthoritative: true,
    },
  }
  return Object.freeze({ ...payload, id: "model-aci:sha256:" + hash(payload) })
}

export function applyModelToolBudget(tools = [], profile = {}, priorities = [], options = {}) {
  return compileToolSurface(tools, profile, priorities, {
    attempt: options.attempt || profile.attempt || 1,
    ...options,
  }).advertised
}
