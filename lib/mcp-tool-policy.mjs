function firstObject(...values) { return values.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {} }
function explicitBoolean(value) { return typeof value === "boolean" ? value : null }
export function normalizeMcpAnnotations(tool = {}) {
  const raw = firstObject(tool.annotations, tool.metadata?.annotations, tool._meta?.annotations, tool._meta?.mcp?.annotations)
  const annotations = { readOnlyHint: explicitBoolean(raw.readOnlyHint), destructiveHint: explicitBoolean(raw.destructiveHint), idempotentHint: explicitBoolean(raw.idempotentHint), openWorldHint: explicitBoolean(raw.openWorldHint) }
  return { schemaVersion: 1, explicit: Object.values(annotations).some((value) => value !== null), ...annotations }
}
export function mcpExecutionPolicy(tool = {}) {
  const annotations = normalizeMcpAnnotations(tool)
  const destructive = annotations.destructiveHint === true
  const readOnly = annotations.readOnlyHint === true && !destructive
  const idempotent = annotations.idempotentHint === true && !destructive
  return { schemaVersion: 1, tool: String(tool?.name || ""), annotations, fastAllowed: readOnly, confirmationRequired: destructive, retryAllowed: idempotent, externalEvidenceBoundary: annotations.openWorldHint === true, trust: "hint-only" }
}
export function mcpPolicyMap(tools = []) {
  const map = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) { const name = String(tool?.name || "").trim(); if (name) map.set(name, mcpExecutionPolicy(tool)) }
  return map
}
