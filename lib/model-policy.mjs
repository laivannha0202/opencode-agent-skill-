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

function tierIndex(value) {
  const index = ORDER.indexOf(value)
  return index < 0 ? 1 : index
}

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


export function resolveAdaptiveModel(role, attempt, taskPolicy = {}, config = {}) {
  const configuredBase = config.roleTiers?.[role] || defaultTier(role)
  const policyBase = taskPolicy.modelTier || configuredBase
  const baseTier = ORDER[Math.max(tierIndex(configuredBase), tierIndex(policyBase))]
  const resolved = resolveModel(role, attempt, {
    ...config,
    roleTiers: { ...(config.roleTiers || {}), [role]: baseTier },
  })
  const normalizedAttempt = Math.max(1, Number(attempt || 1))
  return {
    ...resolved,
    recoveryStage:
      normalizedAttempt <= 1 ? "initial" :
      normalizedAttempt === 2 ? "diagnose" :
      "deep-recovery",
    policy: {
      mode: taskPolicy.mode || null,
      risk: taskPolicy.risk || null,
      executionProfile: taskPolicy.executionProfile || null,
      score: Number(taskPolicy.score || 0),
      maxAttempts: Number(taskPolicy.maxAttempts || 0) || null,
      contextBudget: Number(taskPolicy.contextBudget || 0) || null,
    },
  }
}
