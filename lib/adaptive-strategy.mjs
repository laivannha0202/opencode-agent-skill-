import { createHash } from "node:crypto"

export const EDIT_STRATEGIES = Object.freeze([
  "search-replace",
  "apply-patch",
  "symbol-edit",
  "range-edit",
  "whole-file",
  "architect-editor",
])

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function normalizeStrategy(value, fallback = "search-replace") {
  const strategy = String(value || "").toLowerCase()
  return EDIT_STRATEGIES.includes(strategy) ? strategy : fallback
}

function classifyFailure(text = "") {
  const value = String(text || "").toLowerCase()
  if (!value.trim()) return "none"
  if (/(parse|malformed|invalid patch|patch failed|apply failed|could not apply|mismatch|anchor|stale)/.test(value)) return "edit-application"
  if (/(test|verification|assert|expected|actual|logic|behavior|regression|fail)/.test(value)) return "behavior"
  if (/(not found|missing context|unknown symbol|cannot find|search|definition)/.test(value)) return "context"
  if (/(timeout|hang|stalled|idle)/.test(value)) return "runtime"
  return "unknown"
}

function searchStrategy(task = "") {
  const text = String(task || "")
  if (/(["'`]).{4,120}\1/.test(text) || /(error message|exact text|literal|string|grep|find text)/i.test(text)) return "literal-first"
  if (/(function|method|class|symbol|service|controller|handler|component|hook|interface|type\b|reference|call site)/i.test(text)) return "symbol-first"
  return "hybrid"
}

function heuristicEditStrategy(options = {}) {
  if (options.writer !== true) return "none"
  const task = String(options.task || "")
  const surface = String(options.surface || "balanced")
  const executionProfile = String(options.executionProfile || "standard")
  const attempt = Math.max(1, Math.trunc(Number(options.attempt || 1)))
  const failure = classifyFailure(options.recentFailure)
  if (/(create|new file|generate file|replace entire file|rewrite whole file|tạo file|file mới)/i.test(task)) return "whole-file"
  if (/(apply patch|unified diff|patch file)/i.test(task)) return "apply-patch"
  let base = surface === "compact" ? "search-replace" : searchStrategy(task) === "symbol-first" ? "symbol-edit" : "search-replace"
  if (executionProfile === "deep" && surface === "compact") base = "architect-editor"
  if (attempt <= 1) return base
  if (failure === "edit-application") {
    if (base === "symbol-edit") return "range-edit"
    if (base === "architect-editor") return "symbol-edit"
    return "symbol-edit"
  }
  if (failure === "behavior") return surface === "compact" ? "architect-editor" : "symbol-edit"
  if (failure === "context") return base === "symbol-edit" ? "range-edit" : "symbol-edit"
  if (failure === "runtime") return base
  const cycle = ["search-replace", "symbol-edit", "range-edit", "architect-editor"]
  const index = cycle.indexOf(base)
  return cycle[(Math.max(0, index) + attempt - 1) % cycle.length]
}

function contextStrategy(options = {}) {
  const risk = String(options.risk || "medium").toLowerCase()
  const executionProfile = String(options.executionProfile || "standard").toLowerCase()
  const attempt = Math.max(1, Math.trunc(Number(options.attempt || 1)))
  if (["high", "critical"].includes(risk) && /verifier/.test(String(options.role || ""))) return "stable-full-evidence"
  if (executionProfile === "fast") return "minimal-stable"
  if (attempt > 1) return "delta-tools-expanded-recovery"
  return "delta-tools-stable-prefix"
}

function recordScore(record = {}) {
  const samples = Number(record?.samples || 0)
  if (!samples) return -Infinity
  const passRate = Number(record?.passRate || 0)
  const retries = Number(record?.avgRetries || 0)
  const tokens = Number(record?.avgTokens || 0)
  const latency = Number(record?.avgLatencyMs || 0)
  const tokenPenalty = tokens > 8000 ? Math.min(15, Math.log2(tokens / 8000) * 3) : 0
  const latencyPenalty = latency > 1000 ? Math.min(10, Math.log10(Math.max(1, latency / 1000)) * 3) : 0
  return passRate * 100 - retries * 8 - tokenPenalty - latencyPenalty
}

export function strategyPerformanceKey(profile = {}, taskClass = "general") {
  return [
    "strategy:" + String(taskClass || "general"),
    "edit=" + String(profile.editStrategy || "none"),
    "tool=" + String(profile.toolSurface || "balanced"),
    "context=" + String(profile.contextStrategy || "default"),
    "exec=" + String(profile.executionProfile || "standard"),
    "search=" + String(profile.searchStrategy || "hybrid"),
  ].join("|")
}

function empiricalChoice(history = {}, model = "", candidates = [], options = {}) {
  const records = history?.[model] || {}
  const minSamples = Math.max(2, Math.trunc(Number(options.minSamples || 6)))
  const scored = candidates.map((candidate) => {
    const key = strategyPerformanceKey(candidate, options.taskClass || "general")
    const record = records[key] || null
    return {
      candidate,
      key,
      record,
      score: Number(record?.samples || 0) >= minSamples ? recordScore(record) : -Infinity,
    }
  }).filter((row) => Number.isFinite(row.score))
  scored.sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)))
  return scored[0] || null
}

function profileForEdit(editStrategy, options = {}) {
  return {
    editStrategy: normalizeStrategy(editStrategy),
    toolSurface: String(options.surface || "balanced"),
    contextStrategy: contextStrategy(options),
    executionProfile: String(options.executionProfile || "standard"),
    searchStrategy: searchStrategy(options.task),
  }
}

export function compileAdaptiveStrategy(options = {}) {
  const writer = options.writer === true
  const attempt = Math.max(1, Math.trunc(Number(options.attempt || 1)))
  const failureClass = classifyFailure(options.recentFailure)
  const heuristicEdit = heuristicEditStrategy({ ...options, writer, attempt })
  const baseline = profileForEdit(heuristicEdit === "none" ? "search-replace" : heuristicEdit, options)
  if (!writer) baseline.editStrategy = "none"
  const alternatives = writer
    ? [heuristicEdit, "search-replace", "symbol-edit", "range-edit", ...(String(options.executionProfile) === "deep" ? ["architect-editor"] : [])]
    : ["none"]
  const candidates = [...new Set(alternatives)].map((edit) => {
    if (edit === "none") return { ...baseline, editStrategy: "none" }
    return profileForEdit(edit, options)
  })
  const empirical = writer ? empiricalChoice(options.performanceHistory || {}, String(options.model || ""), candidates, {
    taskClass: options.taskClass || "general",
    minSamples: options.minSamples || 6,
  }) : null
  let selected = empirical?.candidate || baseline
  let reason = empirical ? "measured-model-task-strategy" : "heuristic-model-task-strategy"

  if (writer && attempt > 1 && options.recentFailure) {
    const attemptOne = profileForEdit(heuristicEditStrategy({ ...options, writer: true, attempt: 1, recentFailure: "" }), options)
    if (selected.editStrategy === attemptOne.editStrategy && candidates.length > 1) {
      const shifted = candidates.find((candidate) => candidate.editStrategy !== attemptOne.editStrategy)
      if (shifted) {
        selected = shifted
        reason = "reasoned-retry-dimension-shift"
      }
    }
  }

  const payload = {
    schemaVersion: 1,
    model: String(options.model || ""),
    role: String(options.role || ""),
    taskClass: String(options.taskClass || "general"),
    attempt,
    failureClass,
    editStrategy: selected.editStrategy,
    toolSurface: selected.toolSurface,
    contextStrategy: selected.contextStrategy,
    executionProfile: selected.executionProfile,
    searchStrategy: selected.searchStrategy,
    scaffoldLevel: String(options.scaffoldLevel || "medium"),
    reason,
    evidence: empirical ? "MEASURED" : "HEURISTIC",
    empiricalSamples: Number(empirical?.record?.samples || 0),
    retryPolicy: attempt > 1 ? "change-one-or-more-failed-dimensions" : "first-attempt",
  }
  return Object.freeze({ ...payload, id: "strategy:sha256:" + hash(payload) })
}

export function renderAdaptiveStrategyContract(strategy = {}) {
  if (!strategy || strategy.editStrategy === "none") return ""
  const lines = [
    "## UES V16 Adaptive Editing Contract",
    `Selected edit strategy: ${strategy.editStrategy}; search: ${strategy.searchStrategy}; context: ${strategy.contextStrategy}.`,
    `Selection evidence: ${strategy.evidence || "HEURISTIC"}; reason: ${strategy.reason || "runtime-profile"}; attempt: ${strategy.attempt || 1}.`,
  ]
  if (strategy.searchStrategy === "symbol-first") {
    lines.push("For exact symbol operations, prefer ues_code symbols/definition/references before broad grep; use literal grep for exact strings and large fan-out fallback.")
  } else if (strategy.searchStrategy === "literal-first") {
    lines.push("Start with the exact literal/error/query using grep or bounded search; escalate to semantic symbol tools only when literal evidence is insufficient.")
  } else {
    lines.push("Use the cheapest precise search first: literal search for exact text, semantic symbol lookup for named code entities; avoid broad inventory scans.")
  }
  switch (strategy.editStrategy) {
    case "search-replace":
      lines.push("Prefer a small anchored/search-replace edit after reading the target. Do not rewrite a whole file for a local change.")
      break
    case "apply-patch":
      lines.push("Use an exact patch only when the target context is fresh. On context mismatch, re-read and change strategy instead of replaying the same patch.")
      break
    case "symbol-edit":
      lines.push("Prefer ues_code symbol/reference evidence followed by ues_code_edit for the exact symbol body or anchored semantic region.")
      break
    case "range-edit":
      lines.push("Prefer a bounded anchored range edit. Re-read stale anchors; never fuzzy-apply a range to changed source.")
      break
    case "whole-file":
      lines.push("Whole-file write is allowed only for an explicitly new/replaced scoped file; preserve unrelated content and verify the complete file afterwards.")
      break
    case "architect-editor":
      lines.push("Treat the approved plan/evidence as the architecture contract, then execute the smallest complete edit. Do not reopen broad design unless fresh evidence invalidates the plan.")
      break
  }
  if (Number(strategy.attempt || 1) > 1) {
    lines.push(`Retry intelligence: previous failure class=${strategy.failureClass || "unknown"}; this attempt must not blindly repeat the same failed edit/search/tool pattern.`)
  }
  return lines.join("\n")
}
