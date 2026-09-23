import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"

const HEALTH_WEIGHT = { healthy: 40, degraded: 15, unknown: 0, unavailable: -1000 }
const COST_PENALTY = { low: 0, medium: 5, high: 12 }
const LATENCY_PENALTY = { fast: 0, medium: 3, slow: 8 }

function clamp(value, min = 0, max = 1, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback
}

function commandExists(command) {
  if (!command) return false
  const finder = process.platform === "win32" ? "where" : "which"
  const result = spawnSync(finder, [command], { stdio: "ignore", windowsHide: true })
  return result.status === 0
}

async function packageDeclared(root, name) {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
    return Boolean(
      pkg.dependencies?.[name] ||
      pkg.devDependencies?.[name] ||
      pkg.optionalDependencies?.[name] ||
      pkg.peerDependencies?.[name],
    )
  } catch {
    return false
  }
}

function normalizeProvider(provider = {}, index = 0) {
  return {
    id: String(provider.id || `provider-${index + 1}`),
    kind: provider.kind || "builtin",
    capability: provider.capability || null,
    priority: Number.isFinite(Number(provider.priority)) ? Number(provider.priority) : 50,
    quality: clamp(provider.quality, 0, 1, 0.5),
    costClass: ["low", "medium", "high"].includes(provider.costClass) ? provider.costClass : "medium",
    latencyClass: ["fast", "medium", "slow"].includes(provider.latencyClass) ? provider.latencyClass : "medium",
    command: provider.command || null,
    path: provider.path || null,
    package: provider.package || null,
    metadata: provider.metadata || {},
  }
}

export function defaultCapabilityRegistry(root = process.cwd()) {
  return {
    schemaVersion: 1,
    root: path.resolve(root),
    capabilities: {
      "code.search": [
        { id: "ues-semantic-index", kind: "builtin", priority: 100, quality: 0.9, costClass: "low", latencyClass: "fast" },
      ],
      memory: [
        { id: "ues-memory", kind: "builtin", priority: 100, quality: 0.9, costClass: "low", latencyClass: "fast" },
      ],
      evidence: [
        { id: "ues-evidence-store", kind: "builtin", priority: 100, quality: 0.95, costClass: "low", latencyClass: "fast" },
      ],
      filesystem: [
        { id: "node-fs", kind: "builtin", priority: 100, quality: 0.95, costClass: "low", latencyClass: "fast" },
      ],
      git: [
        { id: "git-cli", kind: "command", command: "git", priority: 100, quality: 0.95, costClass: "low", latencyClass: "fast" },
      ],
      "agent.host": [
        { id: "pi-cli", kind: "command", command: "pi", priority: 100, quality: 0.95, costClass: "low", latencyClass: "fast" },
      ],
      github: [
        { id: "gh-cli", kind: "command", command: "gh", priority: 80, quality: 0.85, costClass: "low", latencyClass: "fast" },
      ],
      browser: [
        { id: "project-playwright", kind: "package", package: "playwright", priority: 90, quality: 0.9, costClass: "medium", latencyClass: "medium" },
        { id: "project-playwright-core", kind: "package", package: "playwright-core", priority: 70, quality: 0.75, costClass: "medium", latencyClass: "medium" },
      ],
    },
  }
}

async function readCapabilityConfig(root, file) {
  const target = file
    ? path.resolve(file)
    : process.env.UES_CAPABILITY_CONFIG
      ? path.resolve(process.env.UES_CAPABILITY_CONFIG)
      : path.join(path.resolve(root), ".ues-capabilities.json")
  if (!existsSync(target)) return null
  try {
    const parsed = JSON.parse(await readFile(target, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function mergeRegistry(base, extra) {
  if (!extra?.capabilities || typeof extra.capabilities !== "object") return base
  const capabilities = { ...base.capabilities }
  for (const [name, values] of Object.entries(extra.capabilities)) {
    const custom = Array.isArray(values) ? values : []
    const seen = new Set(custom.map((item) => item?.id).filter(Boolean))
    const inherited = (capabilities[name] || []).filter((item) => !seen.has(item.id))
    capabilities[name] = [...custom, ...inherited]
  }
  return { ...base, capabilities }
}

export async function loadCapabilityRegistry(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const base = options.registry || defaultCapabilityRegistry(root)
  if (options.registry) return base
  return mergeRegistry(base, await readCapabilityConfig(root, options.configFile))
}

export async function probeCapabilityProvider(provider, root = process.cwd()) {
  const normalized = normalizeProvider(provider)
  const checkedAt = new Date().toISOString()
  if (normalized.kind === "builtin") {
    return { ...normalized, status: "healthy", reason: "built-in", checkedAt }
  }
  if (normalized.kind === "command") {
    const available = commandExists(normalized.command)
    return {
      ...normalized,
      status: available ? "healthy" : "unavailable",
      reason: available ? `command:${normalized.command}` : `missing-command:${normalized.command}`,
      checkedAt,
    }
  }
  if (normalized.kind === "path") {
    const target = normalized.path ? path.resolve(root, normalized.path) : null
    const available = Boolean(target && existsSync(target))
    return {
      ...normalized,
      status: available ? "healthy" : "unavailable",
      reason: available ? `path:${normalized.path}` : `missing-path:${normalized.path || ""}`,
      checkedAt,
    }
  }
  if (normalized.kind === "package") {
    const declared = normalized.package ? await packageDeclared(root, normalized.package) : false
    const installed = normalized.package
      ? existsSync(path.join(root, "node_modules", normalized.package))
      : false
    const available = installed || declared
    return {
      ...normalized,
      status: installed ? "healthy" : declared ? "degraded" : "unavailable",
      reason: installed
        ? `installed-package:${normalized.package}`
        : declared
          ? `declared-package:${normalized.package}`
          : `missing-package:${normalized.package || ""}`,
      checkedAt,
    }
  }
  return { ...normalized, status: "unknown", reason: `unknown-kind:${normalized.kind}`, checkedAt }
}

export function selectCapabilityProvider(capability, providers = [], options = {}) {
  const observations = options.observations || {}
  const allowUnknown = options.allowUnknown === true
  const rows = providers.map((provider, index) => {
    const normalized = normalizeProvider(provider, index)
    const status = provider.status || "unknown"
    const observation = observations[normalized.id] || {}
    const failureRate = clamp(observation.failureRate, 0, 1, 0)
    const successBoost = clamp(observation.successRate, 0, 1, 0) * 10
    const healthWeight = HEALTH_WEIGHT[status] ?? HEALTH_WEIGHT.unknown
    const eligible = status === "healthy" || status === "degraded" || (allowUnknown && status === "unknown")
    const score =
      normalized.priority +
      normalized.quality * 20 +
      successBoost +
      healthWeight -
      (COST_PENALTY[normalized.costClass] ?? 5) -
      (LATENCY_PENALTY[normalized.latencyClass] ?? 3) -
      failureRate * 30
    return { ...normalized, status, eligible, failureRate, score: Number(score.toFixed(3)), reason: provider.reason || null }
  })
  const eligible = rows.filter((item) => item.eligible).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return {
    schemaVersion: 1,
    capability,
    selected: eligible[0] || null,
    fallbacks: eligible.slice(1),
    candidates: rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)),
    fallbackNeeded: eligible.length === 0,
  }
}

export async function capabilityFabricStatus(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const registry = await loadCapabilityRegistry(root, options)
  const capabilities = {}
  const rows = []
  for (const [name, providers] of Object.entries(registry.capabilities || {})) {
    const probed = []
    for (const provider of providers || []) probed.push(await probeCapabilityProvider(provider, root))
    const selected = selectCapabilityProvider(name, probed, {
      observations: options.observations?.[name] || {},
      allowUnknown: options.allowUnknown,
    })
    capabilities[name] = selected
    rows.push({
      capability: name,
      selected: selected.selected?.id || null,
      status: selected.selected?.status || "unavailable",
      fallbacks: selected.fallbacks.map((item) => item.id),
    })
  }
  return {
    schemaVersion: 1,
    root,
    generatedAt: new Date().toISOString(),
    rows,
    capabilities,
    healthyCapabilities: rows.filter((item) => item.selected).length,
    totalCapabilities: rows.length,
  }
}
