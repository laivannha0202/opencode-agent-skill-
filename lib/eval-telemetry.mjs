function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function normalizedToolName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function visit(value, callback, path = []) {
  if (!value || typeof value !== "object") return
  callback(value, path)
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, callback, [...path, index]))
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object") visit(child, callback, [...path, key])
  }
}

function usageFromObject(object) {
  const usage =
    object?.usage && typeof object.usage === "object" ? object.usage :
    object?.tokens && typeof object.tokens === "object" ? object.tokens :
    null
  if (!usage) return null

  const input =
    asNumber(usage.inputTokens) ||
    asNumber(usage.input_tokens) ||
    asNumber(usage.promptTokens) ||
    asNumber(usage.prompt_tokens) ||
    asNumber(usage.input)

  const output =
    asNumber(usage.outputTokens) ||
    asNumber(usage.output_tokens) ||
    asNumber(usage.completionTokens) ||
    asNumber(usage.completion_tokens) ||
    asNumber(usage.output)

  const total =
    asNumber(usage.totalTokens) ||
    asNumber(usage.total_tokens) ||
    asNumber(usage.total) ||
    input + output

  if (input === 0 && output === 0 && total === 0) return null
  return { input, output, total }
}

function toolCandidate(object) {
  const type = String(object.type || object.kind || object.event || "").toLowerCase()
  let name = normalizedToolName(object.tool || object.toolName || object.tool_name)

  if (!name && type.includes("tool")) {
    name = normalizedToolName(object.name)
  }
  if (!name) return null

  const input =
    object.input && typeof object.input === "object" ? object.input :
    object.args && typeof object.args === "object" ? object.args :
    object.arguments && typeof object.arguments === "object" ? object.arguments :
    {}

  const id =
    object.callID || object.callId || object.toolCallID || object.toolCallId ||
    object.id || null

  return { name, input, id: id == null ? null : String(id) }
}

export function parseOpenCodeTelemetry(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).filter((line) => line.trim())
  const parsed = []
  let parseErrors = 0

  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line))
    } catch {
      parseErrors += 1
    }
  }

  const toolKeys = new Set()
  const tools = new Map()
  const skills = new Set()
  const subagents = new Set()
  const tokens = { input: 0, output: 0, total: 0 }
  let cost = 0
  let usageSamples = 0
  let costSamples = 0
  let firstUsage = null
  const v11 = {
    promptCacheSamples: 0,
    cacheableRatioSum: 0,
    stableChars: 0,
    dynamicChars: 0,
    repeatedStableChars: 0,
    evidenceRefs: new Set(),
    evidenceRefOccurrences: 0,
    visualRepairAttempts: 0,
    contextExpansions: 0,
    modelEscalations: 0,
  }

  parsed.forEach((event, eventIndex) => {
    let eventUsage = null
    let eventCost = null

    visit(event, (object, objectPath) => {
      const tool = toolCandidate(object)
      if (tool) {
        const fallbackKey = `${eventIndex}:${objectPath.join(".")}:${tool.name}`
        const key = tool.id ? `${tool.name}:${tool.id}` : fallbackKey
        if (!toolKeys.has(key)) {
          toolKeys.add(key)
          tools.set(tool.name, (tools.get(tool.name) || 0) + 1)

          if (tool.name === "skill") {
            const id = tool.input.id || tool.input.skill || tool.input.name
            if (typeof id === "string" && id) skills.add(id)
          }

          if (tool.name === "task" || tool.name === "subagent") {
            const id = tool.input.agent || tool.input.agentID || tool.input.agentId || tool.input.id
            if (typeof id === "string" && id) subagents.add(id)
          }
        }
      }

      if (!eventUsage) eventUsage = usageFromObject(object)

      const promptCache = object.promptCache && typeof object.promptCache === "object" ? object.promptCache : null
      if (promptCache) {
        const ratio = Number(promptCache.cacheableRatio)
        if (Number.isFinite(ratio)) {
          v11.promptCacheSamples += 1
          v11.cacheableRatioSum += ratio
        }
        const stableChars = Number(promptCache.stableChars)
        if (Number.isFinite(stableChars) && stableChars >= 0) v11.stableChars += stableChars
        const dynamicChars = Number(promptCache.dynamicChars)
        if (Number.isFinite(dynamicChars) && dynamicChars >= 0) v11.dynamicChars += dynamicChars
        const repeated = Number(promptCache.repeatedStableChars)
        if (Number.isFinite(repeated) && repeated >= 0) v11.repeatedStableChars += repeated
      }

      const scanRefs = (value) => {
        if (typeof value === "string" && /^evidence:sha256:[a-f0-9]{64}$/i.test(value)) {
          v11.evidenceRefOccurrences += 1
          v11.evidenceRefs.add(value.toLowerCase())
        } else if (Array.isArray(value)) {
          for (const item of value) scanRefs(item)
        } else if (value && typeof value === "object") {
          for (const child of Object.values(value)) scanRefs(child)
        }
      }
      scanRefs(object.evidencePointers)
      scanRefs(object.evidence)

      const eventName = String(object.type || object.event || object.kind || "").toLowerCase()
      if (eventName.includes("visual") && eventName.includes("repair")) v11.visualRepairAttempts += 1
      if (eventName.includes("context") && (eventName.includes("expand") || eventName.includes("recovery"))) v11.contextExpansions += 1
      if (eventName.includes("model") && eventName.includes("escalat")) v11.modelEscalations += 1
      if (eventCost === null) {
        for (const key of ["cost", "totalCost", "total_cost"]) {
          if (typeof object[key] === "number" && Number.isFinite(object[key])) {
            eventCost = object[key]
            break
          }
        }
      }
    })

    if (eventUsage) {
      if (!firstUsage && eventUsage.input > 0) firstUsage = { ...eventUsage }
      usageSamples += 1
      tokens.input += eventUsage.input
      tokens.output += eventUsage.output
      tokens.total += eventUsage.total
    }
    if (eventCost !== null) {
      costSamples += 1
      cost += eventCost
    }
  })

  return {
    schemaVersion: 1,
    format: "best-effort-opencode-jsonl",
    jsonLines: parsed.length,
    parseErrors,
    toolCalls: [...tools.values()].reduce((sum, value) => sum + value, 0),
    tools: Object.fromEntries([...tools.entries()].sort(([a], [b]) => a.localeCompare(b))),
    skillsLoaded: [...skills].sort(),
    subagents: [...subagents].sort(),
    tokens,
    firstUsage,
    usageSamples,
    cost,
    costSamples,
    v11: {
      promptCacheSamples: v11.promptCacheSamples,
      avgCacheableRatio: v11.promptCacheSamples ? v11.cacheableRatioSum / v11.promptCacheSamples : null,
      avgStableChars: v11.promptCacheSamples ? v11.stableChars / v11.promptCacheSamples : null,
      avgDynamicChars: v11.promptCacheSamples ? v11.dynamicChars / v11.promptCacheSamples : null,
      repeatedStableChars: v11.promptCacheSamples ? v11.repeatedStableChars : null,
      repeatedStableRatio: v11.stableChars > 0 ? v11.repeatedStableChars / v11.stableChars : null,
      evidenceRefOccurrences: v11.evidenceRefOccurrences || null,
      uniqueEvidenceRefs: v11.evidenceRefs.size || null,
      evidenceReuseRatio: v11.evidenceRefOccurrences
        ? 1 - (v11.evidenceRefs.size / v11.evidenceRefOccurrences)
        : null,
      visualRepairAttempts: v11.visualRepairAttempts || null,
      contextExpansions: v11.contextExpansions || null,
      modelEscalations: v11.modelEscalations || null,
    },
  }
}
