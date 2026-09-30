// Model-facing payload reduction for Parent Code Intelligence Lite.
//
// The runtime keeps the exact LSP/semantic payload; this module produces the
// smaller, clearer payload a weak model has to read. Two rules govern it:
//
//   1. Nothing verifiable is removed. Names, positions, severities, codes,
//      messages, provider identity, pool state, completion and reason survive.
//   2. Positions are reported 1-based, matching the tool parameters, so a model
//      that reads a line and then calls ues_code read cannot drift by one line.
//
// The caller keeps the raw payload retrievable (reversible context) whenever a
// reduction was applied to a payload big enough to be worth preserving.

const SEVERITY = Object.freeze({ 1: "error", 2: "warning", 3: "information", 4: "hint" })

const POOL_FIELDS = Object.freeze([
  "persistent",
  "poolHit",
  "warm",
  "sessionId",
  "state",
  "coldStartMs",
  "operationDurationMs",
  "totalDurationMs",
])

export const CODE_PAYLOAD_REDUCERS = Object.freeze([
  "pool-summary",
  "symbol-rows",
  "diagnostic-rows",
  "location-rows",
  "provider-summary",
])

function oneBasedPosition(range) {
  if (!range || typeof range !== "object") return null
  const start = range.start && typeof range.start === "object" ? range.start : range
  if (!Number.isFinite(Number(start.line))) return null
  return {
    line: Number(start.line) + 1,
    column: Number(start.character || 0) + 1,
  }
}

function severityName(value) {
  const severity = Number(value)
  if (!Number.isFinite(severity)) return null
  return SEVERITY[severity] || `severity-${severity}`
}

function compactSymbol(symbol, requestFile) {
  if (!symbol || typeof symbol !== "object") return symbol
  const out = { name: symbol.name, kind: symbol.kind ?? null }
  if (symbol.detail) out.detail = symbol.detail
  if (symbol.containerName) out.containerName = symbol.containerName
  const position = oneBasedPosition(symbol.selectionRange || symbol.range)
  if (position) {
    out.line = position.line
    out.column = position.column
  }
  if (symbol.file && symbol.file !== requestFile) out.file = symbol.file
  return out
}

function compactDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") return diagnostic
  const out = {}
  const position = oneBasedPosition(diagnostic.range)
  if (position) {
    out.line = position.line
    out.column = position.column
  }
  const severity = severityName(diagnostic.severity)
  if (severity) out.severity = severity
  if (diagnostic.code != null) out.code = diagnostic.code
  if (diagnostic.source != null) out.source = diagnostic.source
  out.message = diagnostic.message
  return out
}

function compactLocation(location) {
  if (!location || typeof location !== "object") return location
  const out = { file: location.file ?? null }
  const position = oneBasedPosition(location.range || location.targetRange || location.targetSelectionRange)
  if (position) {
    out.line = position.line
    out.column = position.column
  }
  if (location.newText != null) out.newText = location.newText
  return out
}

function compactPool(pool) {
  if (!pool || typeof pool !== "object") return pool
  if (!("sessionId" in pool || "poolHit" in pool || "operationDurationMs" in pool)) return pool
  const out = {}
  for (const key of POOL_FIELDS) if (pool[key] != null) out[key] = pool[key]
  if (pool.policy) out.policy = pool.policy
  return out
}

function compactProviderSummary(providers) {
  if (!providers || typeof providers !== "object") return providers
  const lsp = providers.lsp && typeof providers.lsp === "object" ? providers.lsp : {}
  const pool = lsp.persistentPool && typeof lsp.persistentPool === "object" ? lsp.persistentPool : {}
  return {
    astProvider: providers.astProvider ?? null,
    lspAvailable: lsp.available === true,
    lspProviders: Array.isArray(lsp.providers)
      ? lsp.providers.filter((item) => item?.available === true).map((item) => item.id)
      : [],
    pool: {
      enabled: pool.enabled ?? null,
      active: pool.active ?? null,
      busy: pool.busy ?? null,
      policy: pool.policy || null,
    },
  }
}

function reduceSymbols(payload) {
  const symbols = payload?.result?.symbols
  if (!Array.isArray(symbols) || !symbols.length) return payload
  const requestFile = payload.file ?? null
  return {
    ...payload,
    positionBase: 1,
    result: {
      ...payload.result,
      symbolCount: symbols.length,
      symbols: symbols.map((symbol) => compactSymbol(symbol, requestFile)),
    },
  }
}

function reduceDiagnostics(payload) {
  const diagnostics = payload?.diagnostics
  if (!Array.isArray(diagnostics) || !diagnostics.length) return payload
  return {
    ...payload,
    positionBase: 1,
    diagnosticCount: diagnostics.length,
    diagnostics: diagnostics.map(compactDiagnostic),
  }
}

function reduceLocations(payload) {
  const locations = payload?.result?.locations
  if (!Array.isArray(locations) || !locations.length) return payload
  return {
    ...payload,
    positionBase: 1,
    result: {
      ...payload.result,
      locationCount: locations.length,
      locations: locations.map(compactLocation),
    },
  }
}

const ACTIONS = Object.freeze({
  symbols: { reduce: reduceSymbols, strategy: "symbol-rows" },
  diagnostics: { reduce: reduceDiagnostics, strategy: "diagnostic-rows" },
  definition: { reduce: reduceLocations, strategy: "location-rows" },
  references: { reduce: reduceLocations, strategy: "location-rows" },
})

/**
 * Reduce a Parent Code Intelligence Lite payload for model consumption.
 * Returns the payload unchanged (and `applied: false`) for unknown actions.
 */
export function reduceCodePayload(action, payload, options = {}) {
  const originalChars = JSON.stringify(payload ?? null).length
  if (!payload || typeof payload !== "object") {
    return { payload, reduction: { applied: false, strategies: [], originalChars, reducedChars: originalChars, savedChars: 0 } }
  }

  const strategies = []
  let next = { ...payload }
  if (next.pool) {
    next = { ...next, pool: compactPool(next.pool) }
    strategies.push("pool-summary")
  }

  const specialized0 = ACTIONS[String(action || "")]
  if (specialized0) {
    const specialized = specialized0.reduce(next, options)
    if (specialized !== next) strategies.push(specialized0.strategy)
    next = specialized
  }

  if (String(action) === "search" && next.providers) {
    next = { ...next, providers: compactProviderSummary(next.providers) }
    strategies.push("provider-summary")
  }

  const reducedChars = JSON.stringify(next).length
  const applied = strategies.length > 0 && reducedChars < originalChars
  return {
    payload: applied ? next : payload,
    reduction: {
      applied,
      strategies,
      originalChars,
      reducedChars: applied ? reducedChars : originalChars,
      savedChars: applied ? originalChars - reducedChars : 0,
      positionBase: applied && next.positionBase === 1 ? 1 : null,
    },
  }
}
