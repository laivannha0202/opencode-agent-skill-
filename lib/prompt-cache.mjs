import { createHash } from "node:crypto"

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
function stringify(value) { return typeof value === "string" ? value : JSON.stringify(canonical(value)) }
function digest(value) { return createHash("sha256").update(stringify(value)).digest("hex") }
function chars(value) { return stringify(value ?? "").length }
function finiteTokenCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}
function changedStableKeys(previous, current) {
  const left = previous?.stable || {}
  const right = current?.stable || {}
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => digest(left[key]) !== digest(right[key]))
    .sort()
}

export function buildPromptEnvelope(input = {}) {
  const memorySnapshot = input.memorySnapshot || null
  const stable = {
    invariants: input.invariants || "",
    role: input.role || "",
    skills: input.skills || [],
    projectFacts: input.projectFacts || {},
    toolPolicy: input.toolPolicy || {},
    memorySnapshot,
  }
  const dynamic = {
    task: input.task || {},
    evidence: input.evidence || [],
    memories: memorySnapshot ? [] : (input.memories || []),
    contextHints: input.contextHints || {},
    recentFailure: input.recentFailure || null,
    nextAction: input.nextAction || null,
    recentMessages: input.recentMessages || [],
  }
  const stableChars = chars(stable)
  const dynamicChars = chars(dynamic)
  return {
    schemaVersion: 1,
    stable,
    dynamic,
    stablePrefixHash: digest(stable),
    dynamicHash: digest(dynamic),
    stableChars,
    dynamicChars,
    cacheableChars: stableChars,
    cacheableRatio: stableChars + dynamicChars ? stableChars / (stableChars + dynamicChars) : 0,
    cacheReadTokens: finiteTokenCount(input.cacheReadTokens),
    cacheWriteTokens: finiteTokenCount(input.cacheWriteTokens),
  }
}

export function comparePromptEnvelopes(previous, current, usage = {}) {
  const stableReused = Boolean(previous?.stablePrefixHash && previous.stablePrefixHash === current?.stablePrefixHash)
  const repeatedStableChars = stableReused ? Number(current?.stableChars || 0) : 0
  const mutated = stableReused ? [] : changedStableKeys(previous, current)
  return {
    schemaVersion: 1,
    stableReused,
    repeatedStableChars,
    avoidableRepeatedChars: stableReused ? 0 : Math.min(Number(previous?.stableChars || 0), Number(current?.stableChars || 0)),
    currentCacheableRatio: Number(current?.cacheableRatio || 0),
    cacheableChars: Number(current?.cacheableChars ?? current?.stableChars ?? 0),
    dynamicChars: Number(current?.dynamicChars || 0),
    cacheReadTokens: finiteTokenCount(usage.cacheReadTokens ?? current?.cacheReadTokens),
    cacheWriteTokens: finiteTokenCount(usage.cacheWriteTokens ?? current?.cacheWriteTokens),
    prefixMutationReason: stableReused ? null : (mutated.length ? mutated.join(",") : "stable-prefix-changed"),
    mutatedStableKeys: mutated,
  }
}
