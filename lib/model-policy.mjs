const ROLE_TIERS = {
  "codebase-mapper": "standard",
  architect: "heavy",
  "plan-checker": "heavy",
  executor: "standard",
  debugger: "standard",
  researcher: "standard",
  reviewer: "standard",
  critic: "heavy",
  verifier: "standard",
  "integration-verifier": "heavy",
}

const ORDER = ["light", "standard", "heavy"]

export function defaultTier(role) {
  return ROLE_TIERS[role] || "standard"
}

export function resolveTier(role, attempt = 1, options = {}) {
  const base = options.baseTier || defaultTier(role)
  const index = Math.max(0, ORDER.indexOf(base))
  const maxEscalations = Number.isInteger(options.maxEscalations) ? Math.max(0, options.maxEscalations) : 2
  const escalation = Math.min(Math.max(0, Number(attempt || 1) - 1), maxEscalations)
  return ORDER[Math.min(ORDER.length - 1, index + escalation)]
}

export function resolveModel(role, attempt, config = {}) {
  const tier = resolveTier(role, attempt, {
    baseTier: config.roleTiers?.[role],
    maxEscalations: config.maxEscalations,
  })
  const model = config.tiers?.[tier] || null
  return { role, attempt: Number(attempt || 1), tier, model }
}

export function defaultModelPolicy() {
  return {
    schemaVersion: 1,
    enabled: false,
    maxEscalations: 2,
    tiers: { light: null, standard: null, heavy: null },
    roleTiers: { ...ROLE_TIERS },
  }
}
