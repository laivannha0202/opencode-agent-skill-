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

export function classifyModelRuntimeSurface(model) {
  const value = String(model || "")
  if (COMPACT_HINT.test(value)) return { surface: MODEL_RUNTIME_SURFACE.COMPACT, reason: "model-name-compact-surface-hint" }
  if (EXPANDED_HINT.test(value)) return { surface: MODEL_RUNTIME_SURFACE.EXPANDED, reason: "model-name-expanded-surface-hint" }
  return { surface: MODEL_RUNTIME_SURFACE.BALANCED, reason: "default-balanced-surface" }
}

export function modelRuntimeProfile(model, options = {}) {
  const classified = classifyModelRuntimeSurface(model)
  const table = {
    compact: { maxAdvertisedTools: 10, maxParallelReads: 3, contextBudgetRatio: 0.78, searchResultLimit: 24 },
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
    schemaVersion: 1,
    model: String(model || ""),
    surface: classified.surface,
    reason: classified.reason,
    maxAdvertisedTools: base.maxAdvertisedTools,
    maxParallelReads: base.maxParallelReads,
    contextBudgetRatio: base.contextBudgetRatio,
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
