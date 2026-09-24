import { inferTaskCapabilities } from "./capability-registry.mjs"

const BROWSER_ROLES = new Set([
  "executor",
  "debugger",
  "verifier",
  "integration-verifier",
  "visual-verifier",
])

const VISUAL_SIGNAL =
  /(visual fidelity|visual regression|screenshot|figma|pixel|layout|responsive|viewport|accessibility snapshot|giao diện|\bui\b|\bcss\b|styling|kiểm tra hiển thị)/i

const PROVIDER_SIGNAL =
  /(playwright|browser automation|browser mcp|chromium|webkit|firefox)/i

const BROWSER_TOOL_NAME =
  /(^|[_:.])(browser|playwright)([_:.]|$)|^browser_|^playwright_|mcp.*(?:browser|playwright)/i

const ACTION_PRIORITY = [
  ["snapshot", 18],
  ["screenshot", 17],
  ["console", 16],
  ["network", 15],
  ["navigate", 14],
  ["viewport", 13],
  ["click", 12],
  ["fill", 11],
  ["type", 10],
  ["select", 9],
  ["press", 8],
  ["wait", 7],
  ["hover", 6],
  ["locator", 5],
  ["evaluate", 4],
  ["close", 1],
]

const BLOCKED_BUILTINS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "powershell",
  "edit",
  "write",
  "ues_cli",
  "ues_execute",
  "ues_dispatch",
])

function textForTool(tool = {}) {
  return [
    tool.name,
    tool.label,
    tool.description,
  ].filter(Boolean).join(" ")
}

function normalizeExplicitNames(values = []) {
  if (typeof values === "string") values = values.split(",")
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )]
}

export function visualEvidenceNeeded(text = "") {
  const value = String(text || "")
  const capabilities = inferTaskCapabilities(value, { coding: true })
  return capabilities.required.vision === true || VISUAL_SIGNAL.test(value)
}

export function browserEvidenceNeeded(text = "", role = "") {
  const normalizedRole = String(role || "").replace(/^ues-/, "")
  if (!BROWSER_ROLES.has(normalizedRole)) return false
  if (normalizedRole === "visual-verifier") return true

  const capabilities = inferTaskCapabilities(String(text || ""), { coding: true })
  return (
    capabilities.required.browser === true ||
    capabilities.required.vision === true ||
    VISUAL_SIGNAL.test(String(text || ""))
  )
}

export function selectBrowserMcpToolNames(tools = [], options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 14), 32))
  const explicit = normalizeExplicitNames(options.explicitNames)
  const rows = []
  const available = new Map()

  for (const raw of Array.isArray(tools) ? tools : []) {
    const name = String(raw?.name || "").trim()
    if (!name || BLOCKED_BUILTINS.has(name) || name.startsWith("ues_")) continue
    available.set(name, raw)

    const descriptor = textForTool(raw)
    const providerHit = PROVIDER_SIGNAL.test(descriptor)
    const nameHit = BROWSER_TOOL_NAME.test(name)
    if (!providerHit && !nameHit) continue

    let score = providerHit ? 100 : 70
    if (/playwright/i.test(descriptor)) score += 30
    if (/^browser_|(?:^|[_:.])browser[_:.]/i.test(name)) score += 20
    for (const [signal, weight] of ACTION_PRIORITY) {
      if (name.toLowerCase().includes(signal)) {
        score += weight
        break
      }
    }
    rows.push({ name, score })
  }

  const selected = []
  for (const name of explicit) {
    if (available.has(name) && !selected.includes(name)) selected.push(name)
  }

  for (const row of rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))) {
    if (selected.length >= limit) break
    if (!selected.includes(row.name)) selected.push(row.name)
  }

  return selected.slice(0, limit)
}
