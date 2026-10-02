import {
  normalizePlanForValidation,
  validatePlan,
} from "./task-graph.mjs"

const MAX_REPAIRS = 4

function balancedRawObject(source, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return { raw: source.slice(start, index + 1), end: index + 1 }
      if (depth < 0) return null
    }
  }
  return null
}

function replaceBounded(text, regex, replacement, kind, state) {
  return text.replace(regex, (...args) => {
    state.count += 1
    state.repairs.push(kind)
    if (state.count > state.maxRepairs) return args[0]
    return typeof replacement === "function" ? replacement(...args) : replacement
  })
}

export function repairPlannerJson(raw, options = {}) {
  const maxRepairs = Math.max(0, Math.min(8, Number(options.maxRepairs ?? MAX_REPAIRS)))
  let text = String(raw || "").trim()
  const state = { count: 0, maxRepairs, repairs: [] }
  if (!text) return { ok: false, text, repairs: [], repairCount: 0, value: null, error: "empty-json" }

  try {
    return { ok: true, text, repairs: [], repairCount: 0, value: JSON.parse(text), error: null }
  } catch {}

  // Cosmetic quote repair only. This does not synthesize semantic fields.
  text = replaceBounded(text, /[“”]/g, '"', "smart-quote", state)

  // Concrete production failure: verificationCommands emitted
  // {"command":"git","status","--short"]} instead of
  // {"command":"git","args":["status","--short"]}.
  // Repair only this narrowly recognizable command-object shape.
  text = replaceBounded(
    text,
    /(\{\s*"command"\s*:\s*"(?:\\.|[^"\\])*"\s*),\s*((?:"(?:\\.|[^"\\])*"\s*,\s*)*"(?:\\.|[^"\\])*")\s*\]/g,
    (_match, commandPrefix, argsList) => commandPrefix + ',"args":[' + argsList + ']',
    "verification-command-args-key",
    state,
  )

  // Harmless JSON formatting drift. Count every removed comma so repair work
  // cannot grow unbounded on a badly malformed payload.
  text = replaceBounded(text, /,\s*([}\]])/g, (_match, closer) => closer, "trailing-comma", state)

  if (state.count > maxRepairs) {
    return {
      ok: false,
      text: String(raw || ""),
      repairs: state.repairs.slice(0, maxRepairs + 1),
      repairCount: state.count,
      value: null,
      error: "repair-budget-exceeded",
    }
  }

  try {
    return {
      ok: true,
      text,
      repairs: state.repairs,
      repairCount: state.count,
      value: JSON.parse(text),
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      text,
      repairs: state.repairs,
      repairCount: state.count,
      value: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function candidateFromRaw(raw, source) {
  const parsed = repairPlannerJson(raw)
  if (!parsed.ok) {
    return {
      value: null,
      raw,
      source,
      parseError: parsed.error,
      repairs: parsed.repairs,
      repairCount: parsed.repairCount,
    }
  }
  return {
    value: parsed.value,
    raw,
    source,
    repairedRaw: parsed.text,
    repairs: parsed.repairs,
    repairCount: parsed.repairCount,
    repaired: parsed.repairCount > 0,
    parseError: null,
  }
}

function markedCandidate(source, marker) {
  const markerIndex = source.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const start = source.indexOf("{", markerIndex + marker.length)
  if (start < 0) return null
  const raw = balancedRawObject(source, start)
  return raw ? { ...candidateFromRaw(raw.raw, "marked"), end: raw.end } : null
}

function fencedCandidates(source) {
  const results = []
  const fence = String.fromCharCode(96, 96, 96)
  let offset = 0
  while (offset < source.length) {
    const open = source.indexOf(fence, offset)
    if (open < 0) break
    const bodyStart = source.indexOf("\n", open + fence.length)
    if (bodyStart < 0) break
    const close = source.indexOf(fence, bodyStart + 1)
    if (close < 0) break
    const body = source.slice(bodyStart + 1, close).trim()
    if (body.startsWith("{")) results.push(candidateFromRaw(body, "fenced"))
    offset = close + fence.length
  }
  return results
}

function balancedCandidates(source, limit = 24) {
  const starts = []
  for (let i = source.length - 1; i >= 0 && starts.length < limit; i--) {
    if (source[i] === "{") starts.push(i)
  }
  const results = []
  for (const start of starts) {
    const raw = balancedRawObject(source, start)
    if (raw) results.push({ ...candidateFromRaw(raw.raw, "unmarked-balanced"), end: raw.end })
  }
  return results
}

function planLike(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Array.isArray(value.tasks) &&
    (typeof value.goal === "string" || value.schemaVersion === 1)
  )
}

export function extractValidatedPlan(output, options = {}) {
  const source = String(output || "")
  const marker = String(options.marker || "UES_PLAN_JSON:")
  const candidates = []
  const marked = markedCandidate(source, marker)
  if (marked) candidates.push(marked)
  candidates.push(...fencedCandidates(source))
  candidates.push(...balancedCandidates(source))

  const seen = new Set()
  let bestInvalid = null
  let bestParseFailure = null
  for (const candidate of candidates) {
    if (!candidate.value) {
      if (!bestParseFailure && candidate.parseError) bestParseFailure = candidate
      continue
    }
    if (!planLike(candidate.value)) continue
    let normalized
    try { normalized = normalizePlanForValidation(candidate.value) } catch { continue }
    const key = JSON.stringify(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    const validation = validatePlan(normalized)
    const result = {
      plan: normalized,
      validation,
      source: candidate.source,
      salvaged: candidate.source !== "marked" || candidate.repaired === true,
      repaired: candidate.repaired === true,
      repairs: candidate.repairs || [],
      repairCount: Number(candidate.repairCount || 0),
      parseError: null,
    }
    if (validation && validation.valid === true) return result
    if (!bestInvalid) bestInvalid = result
  }

  if (bestInvalid) return bestInvalid
  return {
    plan: null,
    validation: null,
    source: bestParseFailure?.source || null,
    salvaged: false,
    repaired: false,
    repairs: bestParseFailure?.repairs || [],
    repairCount: Number(bestParseFailure?.repairCount || 0),
    parseError: bestParseFailure?.parseError || null,
  }
}
