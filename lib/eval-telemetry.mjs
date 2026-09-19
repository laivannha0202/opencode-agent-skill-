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
  const usage = object?.usage
  if (!usage || typeof usage !== "object") return null

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
    usageSamples,
    cost,
    costSamples,
  }
}
