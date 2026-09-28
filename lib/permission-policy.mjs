import { readFile, stat } from "node:fs/promises"

const EFFECTS = new Set(["allow", "deny", "ask"])

function normalizeSlashes(value) {
  return String(value || "").replaceAll("\\", "/")
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+.\-]/g, "\\$&")
}

function wildcardRegex(pattern, { caseInsensitive = false, shell = false } = {}) {
  let value = normalizeSlashes(pattern)
  const shellBare = shell && value.endsWith(" *")
    ? value.slice(0, -2)
    : null
  const compile = (input) => {
    let source = ""
    for (const char of input) {
      if (char === "*") source += ".*"
      else if (char === "?") source += "."
      else source += escapeRegex(char)
    }
    return source
  }
  const alternatives = shellBare === null
    ? [compile(value)]
    : [compile(value), compile(shellBare)]
  return new RegExp(`^(?:${alternatives.join("|")})$`, caseInsensitive ? "i" : "")
}

export function permissionPatternMatches(pattern, value, options = {}) {
  return wildcardRegex(String(pattern || ""), options).test(normalizeSlashes(value))
}

export function normalizePermissionRules(value) {
  const rules = Array.isArray(value) ? value : []
  return rules.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`permission rule ${index} must be an object`)
    }
    const action = String(rule.action || "").trim()
    const resource = String(rule.resource || "").trim()
    const effect = String(rule.effect || "").trim().toLowerCase()
    if (!action || !resource || !EFFECTS.has(effect)) {
      throw new Error(`permission rule ${index} requires action, resource and effect=allow|deny|ask`)
    }
    return { action, resource, effect }
  })
}

function resourceValue(action, value) {
  if (["read", "edit", "external_directory"].includes(String(action || ""))) {
    return normalizeSlashes(value)
  }
  return String(value || "")
}

function matchRule(rule, request, platform) {
  const caseInsensitive = platform === "win32"
  const actionMatches = permissionPatternMatches(rule.action, request.action, { caseInsensitive })
  if (!actionMatches) return false
  return permissionPatternMatches(
    rule.resource,
    resourceValue(request.action, request.resource),
    { caseInsensitive, shell: request.action === "shell" },
  )
}

export function evaluatePermissionRules(rules, request = {}, options = {}) {
  const normalized = normalizePermissionRules(rules)
  const action = String(request.action || "").trim()
  const resources = (Array.isArray(request.resources) ? request.resources : [request.resource])
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value))
  const platform = String(options.platform || process.platform)
  const defaultEffect = EFFECTS.has(options.defaultEffect) ? options.defaultEffect : "allow"
  if (!action) throw new Error("permission request requires action")
  if (!resources.length) resources.push("*")

  const decisions = resources.map((resource) => {
    let matchedRule = null
    for (let index = 0; index < normalized.length; index += 1) {
      const rule = normalized[index]
      if (matchRule(rule, { action, resource }, platform)) {
        matchedRule = { ...rule, index }
      }
    }
    return {
      resource,
      effect: matchedRule?.effect || defaultEffect,
      matchedRule,
    }
  })

  const effect = decisions.some((item) => item.effect === "deny")
    ? "deny"
    : decisions.some((item) => item.effect === "ask")
      ? "ask"
      : "allow"

  return {
    schemaVersion: 1,
    action,
    effect,
    defaultEffect,
    decisions,
  }
}

export function toolPermissionRequest(toolName, input = {}) {
  const name = String(toolName || "").trim()
  const lower = name.toLowerCase()
  if (lower === "bash" || lower === "powershell") {
    return { action: "shell", resources: [String(input.command || "")] }
  }
  if (lower === "read") {
    return { action: "read", resources: [String(input.path || input.file || input.filePath || "*")] }
  }
  if (["edit", "write", "write_file", "apply_patch", "ues_code_edit"].includes(lower)) {
    return { action: "edit", resources: [String(input.path || input.file || input.filePath || input.target || "*")] }
  }
  if (lower === "grep") {
    return { action: "grep", resources: [String(input.pattern || input.query || "*")] }
  }
  if (lower === "find" || lower === "glob") {
    return { action: "glob", resources: [String(input.pattern || input.glob || input.query || "*")] }
  }
  if (lower === "ues_dispatch") {
    return { action: "subagent", resources: [String(input.agent || input.target || "*")] }
  }
  if (lower === "ues_session") {
    return { action: "session", resources: [String(input.action || "*")] }
  }
  const action = lower.replace(/[^a-z0-9_]+/g, "_") || "tool"
  return { action, resources: ["*"] }
}

export function permissionRecoveryHint(request = {}, decision = null, options = {}) {
  const action = String(request.action || decision?.action || "tool").trim() || "tool"
  const resources = (
    Array.isArray(request.resources)
      ? request.resources
      : request.resource !== undefined
        ? [request.resource]
        : []
  ).map((value) => String(value)).filter(Boolean)
  const denied = Array.isArray(decision?.decisions)
    ? decision.decisions.filter((item) => item?.effect === "deny" || item?.effect === "ask")
    : []
  const resource = String(denied[0]?.resource || resources[0] || "*")
  const effect = String(options.effect || decision?.effect || "deny")
  const prefix = effect === "ask"
    ? "UES approval was not granted for this action."
    : "UES policy denied this action."

  return [
    prefix,
    `Do not repeat the same blocked ${action} request for ${resource}.`,
    "Continue by choosing the narrowest allowed, reversible alternative that still advances the task.",
    "Prefer read-only inspection or a less-privileged resource when possible.",
    "If no allowed path can satisfy the task, report the blocker with evidence instead of bypassing the guard.",
  ].join(" ")
}

function normalizedConfig(parsed) {
  if (Array.isArray(parsed)) {
    return { permissions: normalizePermissionRules(parsed), agents: {}, defaultEffect: "allow" }
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("permission config must be an array or object")
  }
  const permissions = normalizePermissionRules(parsed.permissions || [])
  const agents = {}
  for (const [agent, value] of Object.entries(parsed.agents || {})) {
    const rules = Array.isArray(value) ? value : value?.permissions
    agents[String(agent)] = normalizePermissionRules(rules || [])
  }
  const defaultEffect = EFFECTS.has(parsed.defaultEffect) ? parsed.defaultEffect : "allow"
  return { permissions, agents, defaultEffect }
}

export class PermissionPolicyStore {
  constructor(file) {
    this.file = String(file || "")
    this.cacheKey = null
    this.cached = null
  }

  async load() {
    if (!this.file) return { configured: false, config: null }
    const info = await stat(this.file).catch((error) => {
      if (error?.code === "ENOENT") return null
      throw error
    })
    if (!info?.isFile()) {
      this.cacheKey = null
      this.cached = null
      return { configured: false, config: null }
    }

    const cacheKey = `${info.mtimeMs}:${info.size}`
    if (this.cached && this.cacheKey === cacheKey) {
      return { configured: true, config: this.cached, cached: true }
    }

    const parsed = JSON.parse(await readFile(this.file, "utf8"))
    const config = normalizedConfig(parsed)
    this.cacheKey = cacheKey
    this.cached = config
    return { configured: true, config, cached: false }
  }

  async evaluate(request, options = {}) {
    const loaded = await this.load()
    if (!loaded.configured) return { configured: false, decision: null }
    const agent = String(options.agent || "")
    const agentRules = agent ? (loaded.config.agents[agent] || []) : []
    const rules = [...loaded.config.permissions, ...agentRules]
    const decision = evaluatePermissionRules(rules, request, {
      platform: options.platform,
      defaultEffect: loaded.config.defaultEffect,
    })
    return {
      configured: true,
      decision,
      agent: agent || null,
      cached: loaded.cached === true,
    }
  }
}
