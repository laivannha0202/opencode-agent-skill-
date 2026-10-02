import { createHash } from "node:crypto"
import { DEFERRED_DISPATCHER_TOOL } from "./deferred-tool-hydration.mjs"

const CORE_ORDER = Object.freeze([
  DEFERRED_DISPATCHER_TOOL,
  "read", "grep", "ues_code", "bash", "powershell", "edit", "ues_code_edit", "write",
  "ues_evidence_get", "ues_service", "find", "ls",
])

const SCHEMA_CHAR_ESTIMATES = Object.freeze({
  [DEFERRED_DISPATCHER_TOOL]: 420,
  read: 720,
  grep: 980,
  find: 720,
  ls: 520,
  bash: 1320,
  powershell: 1320,
  edit: 1180,
  write: 920,
  ues_code: 3900,
  ues_code_edit: 2500,
  ues_service: 2300,
  ues_evidence_get: 980,
})

const UTILITY_CACHE = new Map()

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function fixedRank(name) {
  const index = CORE_ORDER.indexOf(name)
  return index >= 0 ? index : CORE_ORDER.length + 1
}

function estimatedSchemaChars(name) {
  if (SCHEMA_CHAR_ESTIMATES[name]) return SCHEMA_CHAR_ESTIMATES[name]
  if (/(?:playwright|browser|mcp)/i.test(name)) return 1900
  return 900 + Math.min(900, String(name).length * 24)
}

export function estimateToolSchemaTax(tools = []) {
  const ordered = unique(tools)
  const rows = ordered.map((name) => ({ name, estimatedChars: estimatedSchemaChars(name) }))
  const estimatedChars = rows.reduce((sum, row) => sum + row.estimatedChars, 0)
  return {
    schemaVersion: 1,
    evidence: "ESTIMATED",
    estimateBasis: "stable-per-tool-schema-character-table",
    toolCount: rows.length,
    estimatedChars,
    estimatedTokens: Math.ceil(estimatedChars / 4),
    rows,
    schemaPrefixHash: "tool-schema:sha256:" + hash(rows),
  }
}

function editStrategyRelevance(tool, editStrategy = "") {
  const strategy = String(editStrategy || "").toLowerCase()
  if (strategy === "search-replace") return tool === "edit" ? 120 : tool === "ues_code_edit" ? 15 : 0
  if (strategy === "symbol-edit" || strategy === "range-edit") return tool === "ues_code_edit" ? 120 : tool === "edit" ? 20 : 0
  if (strategy === "whole-file") return tool === "write" ? 130 : tool === "edit" ? 10 : 0
  if (strategy === "apply-patch") {
    if (tool === "apply_patch") return 140
    if (tool === "edit") return 55
    if (["bash", "powershell"].includes(tool)) return 25
  }
  if (strategy === "architect-editor") {
    if (tool === "ues_code_edit") return 90
    if (tool === "edit") return 80
  }
  return 0
}

function taskRelevance(tool, task = "", options = {}) {
  const text = String(task || "").toLowerCase()
  let score = editStrategyRelevance(tool, options.editStrategy)
  if (tool === "ues_code") score += 60
  if (["read", "grep"].includes(tool)) score += 50
  if (["bash", "powershell"].includes(tool) && /(test|build|lint|typecheck|run|verify|check|npm|pnpm|yarn|pytest|gradle|maven|cargo|go test|chạy|kiem|kiểm)/i.test(text)) score += 35
  if (["find", "ls"].includes(tool) && /(repo|project|architecture|module|inventory|structure|kiến trúc|toàn bộ)/i.test(text)) score += 28
  if (tool === "ues_service" && /(server|service|watch|dev server|listen|port|nestjs|vite|next dev|serve)/i.test(text)) score += 55
  if (tool === "ues_evidence_get" && /(evidence|ref|compact|truncated|verify|verification)/i.test(text)) score += 30
  if (["edit", "ues_code_edit"].includes(tool) && options.writer === true) score += 45
  if (tool === "write" && options.writer === true && /(create|add|new file|generate|tạo|thêm file|file mới)/i.test(text)) score += 48
  if (/(playwright|browser|mcp)/i.test(tool) && /(browser|visual|playwright|e2e|screenshot|web page)/i.test(text)) score += 80
  return score
}

export function coreToolPriorities(candidateTools = [], options = {}) {
  const universe = new Set(unique(candidateTools))
  const task = String(options.task || "")
  const writer = options.writer === true
  const executionProfile = String(options.executionProfile || "standard").toLowerCase()
  // V16.2 same-attempt hydration: the dispatcher is a fixed, tiny discovery
  // interface. It is ranked first so a deferred set is always discoverable
  // in-session; compileToolSurface drops it again when nothing is deferred.
  const output = universe.has(DEFERRED_DISPATCHER_TOOL) ? [DEFERRED_DISPATCHER_TOOL] : []
  output.push("read", "grep", "ues_code")
  const primaryShell = String(options.platform || process.platform).toLowerCase() === "win32" ? "powershell" : "bash"
  const secondaryShell = primaryShell === "powershell" ? "bash" : "powershell"
  output.push(primaryShell)
  if (executionProfile !== "fast" || /(bash|powershell|shell|cmd)/i.test(task)) output.push(secondaryShell)
  if (writer) {
    const editStrategy = String(options.editStrategy || "").toLowerCase()
    const strategyTools =
      editStrategy === "whole-file" ? ["write"] :
      editStrategy === "symbol-edit" || editStrategy === "range-edit" ? ["ues_code_edit"] :
      editStrategy === "apply-patch" ? ["apply_patch", "edit"] :
      editStrategy === "architect-editor" ? ["ues_code_edit", "edit"] :
      ["edit"]
    const availableStrategyTools = strategyTools.filter((name) => universe.has(name))
    output.push(...(availableStrategyTools.length ? availableStrategyTools : ["edit"]))
    if (/(create|add|new file|generate|scaffold|tạo|thêm file|file mới)/i.test(task)) output.push("write")
    if (executionProfile === "deep" && editStrategy === "architect-editor") output.push("ues_code_edit")
  }
  if (options.compactToolOutput === true) output.push("ues_evidence_get")
  if (/(server|service|watch|dev server|listen|port|nestjs|vite|next dev|serve)/i.test(task)) output.push("ues_service")
  output.push(...unique(options.extraTools || []))
  return unique(output)
    .filter((name) => universe.has(name))
    .sort((a, b) => fixedRank(a) - fixedRank(b) || a.localeCompare(b))
}

function learnedScore(tool, utility = {}) {
  const row = utility?.tools?.[tool]
  if (!row || Number(row.exposures || 0) < Number(utility.minToolExposures || 8)) return 0
  const ratio = Number(row.utilizationRatio || 0)
  if (ratio >= 0.65) return 50 + ratio * 20
  if (ratio >= 0.35) return 20 + ratio * 10
  if (ratio <= 0.05) return -50
  if (ratio <= 0.15) return -20
  return 0
}

export function compileToolSurface(tools = [], profile = {}, priorities = [], options = {}) {
  const runtimeOptions = {
    ...options,
    editStrategy: options.editStrategy || profile.editStrategy || "",
  }
  const universe = unique(tools).sort((a, b) => a.localeCompare(b))
  const priority = unique(priorities)
    .filter((tool) => universe.includes(tool))
    .sort((a, b) => fixedRank(a) - fixedRank(b) || a.localeCompare(b))
  const prioritySet = new Set(priority)
  const attempt = Math.max(1, Math.trunc(Number(options.attempt || profile.attempt || 1)))
  const baseLimit = Math.max(1, Math.trunc(Number(profile.maxAdvertisedTools || universe.length || 1)))
  const retryReveal = Math.min(4, Math.max(0, attempt - 1) * 2)
  const effectiveLimit = Math.min(universe.length, Math.max(priority.length, baseLimit + retryReveal))
  const utility = runtimeOptions.utility || null
  const rest = universe.filter((tool) => !prioritySet.has(tool)).sort((a, b) => {
    const learned = learnedScore(b, utility) - learnedScore(a, utility)
    if (learned) return learned
    const relevant = taskRelevance(b, runtimeOptions.task, runtimeOptions) - taskRelevance(a, runtimeOptions.task, runtimeOptions)
    if (relevant) return relevant
    return a.localeCompare(b)
  })
  const advertised = [...priority, ...rest].slice(0, effectiveLimit)
  const advertisedSet = new Set(advertised)
  const deferred = universe.filter((tool) => !advertisedSet.has(tool))
  // No deferred tools: the discovery interface is pointless schema tax, so it
  // is withheld (deterministic: only the dispatcher is ever removed, and only
  // when the deferred set is empty).
  const withheldDispatcher = deferred.length === 0 && advertisedSet.has(DEFERRED_DISPATCHER_TOOL)
  const finalAdvertised = withheldDispatcher
    ? advertised.filter((tool) => tool !== DEFERRED_DISPATCHER_TOOL)
    : advertised
  const tax = estimateToolSchemaTax(finalAdvertised)
  return {
    schemaVersion: 1,
    mode: deferred.length ? "core-plus-deferred" : "all-visible",
    revealPolicy: deferred.length
      ? "retry-demand-plus-task-relevance-plus-same-attempt-hydration"
      : "retry-demand-plus-task-relevance",
    hydrationInterface: deferred.length ? "v16.2-same-attempt/1" : null,
    hydrationDispatcher: deferred.length && finalAdvertised.includes(DEFERRED_DISPATCHER_TOOL)
      ? DEFERRED_DISPATCHER_TOOL
      : null,
    advertised: finalAdvertised,
    deferred,
    advertisedCount: finalAdvertised.length,
    deferredCount: deferred.length,
    universeCount: universe.length,
    baseLimit,
    effectiveLimit,
    attempt,
    stableOrder: true,
    schemaTax: tax,
    schemaPrefixHash: tax.schemaPrefixHash,
    utilityEvidence: utility?.evidence || "NOT_MEASURED",
  }
}

export function summarizeToolUtilizationRows(rows = [], options = {}) {
  const model = String(options.model || "")
  const role = String(options.role || "")
  const minRuns = Math.max(1, Math.trunc(Number(options.minRuns || 8)))
  const minToolExposures = Math.max(1, Math.trunc(Number(options.minToolExposures || 8)))
  const filtered = (rows || []).filter((row) => {
    if (row?.type !== "task.telemetry") return false
    if (model && String(row?.model || "") !== model) return false
    if (role && String(row?.role || "") !== role) return false
    return Array.isArray(row?.metrics?.advertisedToolNames)
  })
  const tools = {}
  for (const row of filtered) {
    const advertised = unique(row?.metrics?.advertisedToolNames || [])
    const used = new Set(unique(row?.metrics?.usedToolNames || row?.metrics?.toolNames || []))
    for (const name of advertised) {
      const current = tools[name] || { exposures: 0, uses: 0 }
      current.exposures += 1
      if (used.has(name)) current.uses += 1
      tools[name] = current
    }
  }
  for (const [name, row] of Object.entries(tools)) {
    row.utilizationRatio = row.exposures ? row.uses / row.exposures : 0
    tools[name] = row
  }
  return {
    schemaVersion: 1,
    model: model || null,
    role: role || null,
    runs: filtered.length,
    minRuns,
    minToolExposures,
    evidence: filtered.length >= minRuns ? "MEASURED" : "NOT_MEASURED",
    tools,
  }
}

export async function learnToolUtilization(root, options = {}) {
  const key = [String(root || process.cwd()), String(options.model || ""), String(options.role || ""), String(options.minRuns || 8), String(options.minToolExposures || 8)].join("\0")
  const ttlMs = Math.max(1000, Math.min(5 * 60_000, Number(options.ttlMs || 30_000)))
  const cached = UTILITY_CACHE.get(key)
  if (cached && Date.now() - cached.at <= ttlMs) return cached.value
  let rows = []
  try {
    const mod = await import("./run-telemetry.mjs")
    rows = await mod.readTaskTelemetry(root, { limit: Math.max(40, Math.min(1000, Number(options.limit || 240))) })
  } catch {}
  const value = summarizeToolUtilizationRows(rows, options)
  UTILITY_CACHE.set(key, { at: Date.now(), value })
  return value
}

export function clearToolUtilizationCache() {
  UTILITY_CACHE.clear()
}
