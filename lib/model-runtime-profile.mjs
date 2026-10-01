import { createHash } from "node:crypto"

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

export function modelRuntimeProfile(model, options = {}) {
  const classified = classifyModelRuntimeSurface(model, options)
  const table = {
    compact: { maxAdvertisedTools: 10, maxParallelReads: 3, contextBudgetRatio: 1, searchResultLimit: 24 },
    balanced: { maxAdvertisedTools: 16, maxParallelReads: 4, contextBudgetRatio: 1, searchResultLimit: 40 },
    expanded: { maxAdvertisedTools: 24, maxParallelReads: 6, contextBudgetRatio: 1, searchResultLimit: 64 },
  }
  const base = table[classified.surface]
  const executionProfile = String(options.executionProfile || "standard").toLowerCase()
  const attempt = Math.max(1, Math.trunc(Number(options.attempt || 1)))
  const role = String(options.role || "")
  const architectEditor =
    classified.surface === MODEL_RUNTIME_SURFACE.COMPACT &&
    (executionProfile === "deep" || attempt > 1) &&
    ["executor", "architect", "debugger"].includes(role.replace(/^ues-/, ""))
  const payload = {
    schemaVersion: 2,
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
    editPipeline: architectEditor ? "architect-editor" : "direct",
    preservesThinkingLevel: true,
    executionProfile,
    role: role || null,
  }
  return Object.freeze({
    ...payload,
    id: "model-profile:sha256:" + hash(payload),
  })
}

export function applyModelToolBudget(tools = [], profile = {}, priorities = []) {
  const unique = [...new Set((tools || []).map((value) => String(value || "").trim()).filter(Boolean))]
  const limit = Math.max(1, Math.trunc(Number(profile.maxAdvertisedTools || unique.length || 1)))
  if (unique.length <= limit) return unique
  const uniqueSet = new Set(unique)
  const first = [...new Set((priorities || []).map((tool) => String(tool || "").trim()).filter(Boolean))]
    .filter((tool) => uniqueSet.has(tool))
  const prioritySet = new Set(first)
  const rest = unique.filter((tool) => !prioritySet.has(tool))
  const effectiveLimit = Math.max(limit, first.length)
  return [...first, ...rest].slice(0, effectiveLimit)
}
