import {
  normalizePlanForValidation,
  validatePlan,
} from "./task-graph.mjs"

function balancedObject(source, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") inString = false
      continue
    }
    if (char === "\"") {
      inString = true
      continue
    }
    if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) {
        const raw = source.slice(start, index + 1)
        try {
          return { value: JSON.parse(raw), raw, end: index + 1 }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function markedCandidate(source, marker) {
  const markerIndex = source.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const start = source.indexOf("{", markerIndex + marker.length)
  if (start < 0) return null
  const parsed = balancedObject(source, start)
  return parsed ? { ...parsed, source: "marked" } : null
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
    if (body.startsWith("{")) {
      try { results.push({ value: JSON.parse(body), raw: body, source: "fenced" }) } catch {}
    }
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
    const parsed = balancedObject(source, start)
    if (parsed) results.push({ ...parsed, source: "unmarked-balanced" })
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
  for (const candidate of candidates) {
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
      salvaged: candidate.source !== "marked",
    }
    if (validation && validation.valid === true) return result
    if (!bestInvalid) bestInvalid = result
  }

  return bestInvalid || {
    plan: null,
    validation: null,
    source: null,
    salvaged: false,
  }
}
