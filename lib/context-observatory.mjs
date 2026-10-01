import { createHash } from "node:crypto"

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}
function hash(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex") }
function textSize(value) {
  if (value == null) return 0
  if (typeof value === "string") return value.length
  try { return JSON.stringify(value).length } catch { return 0 }
}
function tokens(chars) { return chars ? Math.ceil(chars / 4) : 0 }

export function decisionPointFingerprint(input = {}) {
  const payload = {
    model: input.model || null,
    provider: input.provider || null,
    thinking: input.thinking || null,
    runtimeProfileId: input.runtimeProfileId || null,
    policySnapshotId: input.policySnapshotId || null,
    toolSurface: [...new Set(input.toolSurface || [])].sort(),
    skillIds: [...new Set(input.skillIds || [])].sort(),
    repoMapIds: [...new Set(input.repoMapIds || [])].sort(),
    evidenceRefs: [...new Set(input.evidenceRefs || [])].sort(),
    compactionEpoch: input.compactionEpoch || null,
    reducer: input.reducer || null,
  }
  return { schemaVersion: 1, payload, id: "decision:sha256:" + hash(payload) }
}

export function buildContextObservatory(input = {}) {
  const sections = {
    systemRuntime: textSize(input.systemRuntime),
    skills: textSize(input.skills),
    repoMap: textSize(input.repoMap),
    selectedFiles: textSize(input.selectedFiles),
    toolHistory: textSize(input.toolHistory),
    planState: textSize(input.planState),
    evidenceViews: textSize(input.evidenceViews),
    recentContext: textSize(input.recentContext),
  }
  const componentChars = Object.values(sections).reduce((sum, value) => sum + value, 0)
  const knownVisibleChars = textSize(input.modelVisibleText)
  const totalChars = knownVisibleChars || componentChars
  const bySection = Object.fromEntries(Object.entries(sections).map(([name, chars]) => [
    name,
    { chars, estimatedTokens: tokens(chars), ratio: totalChars ? chars / totalChars : 0 },
  ]))
  const toolNames = (input.toolNames || []).map(String)
  const uniqueToolCount = new Set(toolNames).size
  const observedToolCalls = Math.max(toolNames.length, Number(input.toolCallCount || 0))
  const repeatedTools = Math.max(toolNames.length - uniqueToolCount, observedToolCalls - uniqueToolCount)
  const repeatedReads = Number(input.repeatedReads || 0)
  const repeatedSearches = Number(input.repeatedSearches || 0)
  const unusedToolSchemas = Number(input.unusedToolSchemas || 0)
  const unusedSkillSchemas = Number(input.unusedSkillSchemas || 0)
  return {
    schemaVersion: 1,
    measured: false,
    estimateBasis: "serialized-character-estimate",
    estimateCoverage: knownVisibleChars ? "ues-known-visible-prompt-only" : "component-sum-fallback",
    componentEstimatesMayOverlap: knownVisibleChars > 0,
    charsPerEstimatedToken: 4,
    totalChars,
    componentChars,
    estimatedTokens: tokens(totalChars),
    bySection,
    waste: { repeatedTools, repeatedReads, repeatedSearches, unusedToolSchemas, unusedSkillSchemas },
  }
}


export function contextReportFromTrajectory(trajectory = {}) {
  const events = Array.isArray(trajectory?.events) ? trajectory.events : []
  const row = [...events].reverse().find((event) => event?.type === "context.observatory")
  return row?.payload || {
    schemaVersion: 1,
    measured: false,
    reason: "no-context-observatory-event",
    traceID: trajectory?.traceID || null,
  }
}

export function buildDecisionReplayPacket(trajectory = {}, decisionPointId) {
  const events = Array.isArray(trajectory?.events) ? trajectory.events : []
  const wanted = String(decisionPointId || "").trim()
  const candidates = events.filter((row) =>
    ["decision.surface-compiled", "decision.profile-compiled"].includes(row?.type) &&
    (!wanted || row?.payload?.decisionPointId === wanted)
  )
  const event = candidates.find((row) => row?.type === "decision.surface-compiled") || candidates[0]
  if (!event) {
    return {
      schemaVersion: 1,
      found: false,
      decisionPointId: wanted || null,
      sideEffectsAllowed: false,
      toolExecutionAllowed: false,
    }
  }
  return {
    schemaVersion: 1,
    found: true,
    traceID: trajectory?.traceID || event.traceID || null,
    eventId: event.id || null,
    decisionPointId: event.payload?.decisionPointId || null,
    capturedAt: event.at || null,
    modelRuntimeProfile: event.payload?.modelRuntimeProfile || null,
    modelAciProfile: event.payload?.modelAciProfile || null,
    policySnapshotId: event.payload?.policySnapshotId || null,
    runtimeEpochId: event.payload?.runtimeEpochId || null,
    allowedTools: Array.isArray(event.payload?.allowedTools) ? event.payload.allowedTools : [],
    selectedSkills: Array.isArray(event.payload?.selectedSkills) ? event.payload.selectedSkills : [],
    toolExposure: event.payload?.toolExposure || null,
    surfaceExact: event?.type === "decision.surface-compiled",
    sideEffectsAllowed: false,
    toolExecutionAllowed: false,
    purpose: "side-effect-free decision replay/eval packet",
  }
}
