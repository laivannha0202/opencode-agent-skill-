import { createHash } from "node:crypto"

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function stringify(value) {
  return typeof value === "string" ? value : JSON.stringify(canonical(value))
}

function digest(value) {
  return createHash("sha256").update(stringify(value)).digest("hex")
}

function chars(value) {
  return stringify(value ?? "").length
}

export function buildPromptEnvelope(input = {}) {
  const stable = {
    invariants: input.invariants || "",
    role: input.role || "",
    skills: input.skills || [],
    projectFacts: input.projectFacts || {},
    toolPolicy: input.toolPolicy || {},
  }
  const dynamic = {
    task: input.task || {},
    evidence: input.evidence || [],
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
    cacheableRatio: stableChars + dynamicChars ? stableChars / (stableChars + dynamicChars) : 0,
  }
}

export function comparePromptEnvelopes(previous, current) {
  const stableReused = Boolean(previous?.stablePrefixHash && previous.stablePrefixHash === current?.stablePrefixHash)
  const repeatedStableChars = stableReused ? Number(current?.stableChars || 0) : 0
  return {
    schemaVersion: 1,
    stableReused,
    repeatedStableChars,
    avoidableRepeatedChars: stableReused ? 0 : Math.min(Number(previous?.stableChars || 0), Number(current?.stableChars || 0)),
    currentCacheableRatio: Number(current?.cacheableRatio || 0),
  }
}
