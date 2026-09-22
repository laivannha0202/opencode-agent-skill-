const BOOLEAN_CAPS = ["coding", "reasoning", "toolCalling", "vision", "browser", "filesystem", "longContext"]

const ROLE_REQUIREMENTS = {
  executor: { coding: true, toolCalling: true },
  debugger: { coding: true, reasoning: true, toolCalling: true },
  architect: { reasoning: true, longContext: true },
  reviewer: { coding: true, reasoning: true },
  verifier: { toolCalling: true },
  "integration-verifier": { coding: true, reasoning: true, toolCalling: true },
  "visual-verifier": { vision: true },
  "merge-arbiter": { coding: true, reasoning: true, toolCalling: true },
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

export function inferTaskCapabilities(text, facts = {}) {
  const value = String(text || "").toLowerCase()
  const required = {
    coding: facts.coding !== false,
    reasoning: facts.reasoning === true || /(architect|design decision|root cause|complex|high-risk|kiến trúc|nguyên nhân gốc)/.test(value),
    toolCalling: facts.toolCalling !== false,
    vision: facts.vision === true || /(screenshot|image reference|figma|visual fidelity|pixel|ảnh mẫu|hình ảnh|giao diện giống)/.test(value),
    browser: facts.browser === true || /(playwright|browser|e2e|web page|click|form flow|trình duyệt)/.test(value),
    filesystem: facts.filesystem !== false,
    longContext: facts.longContext === true || /(whole repo|entire project|large refactor|long-horizon|toàn bộ dự án|tác vụ dài)/.test(value),
  }
  const tags = []
  if (required.vision) tags.push("vision")
  if (required.browser) tags.push("browser")
  if (/(figma|design token|design source|ảnh mẫu)/.test(value)) tags.push("design-source")
  if (/(responsive|breakpoint|mobile|tablet|viewport)/.test(value)) tags.push("responsive")
  if (/(storybook|visual regression|snapshot)/.test(value)) tags.push("component-visual-testing")
  if (/(untrusted page|prompt injection|web content injection)/.test(value)) tags.push("browser-security")
  return { schemaVersion: 1, required, tags: uniq(tags) }
}

export function normalizeCapabilityProfile(profile = {}) {
  const normalized = {}
  for (const key of BOOLEAN_CAPS) normalized[key] = profile[key] === true
  return {
    ...normalized,
    latencyClass: ["fast", "medium", "slow"].includes(profile.latencyClass) ? profile.latencyClass : "medium",
    costClass: ["low", "medium", "high"].includes(profile.costClass) ? profile.costClass : "medium",
    quality: Number.isFinite(Number(profile.quality)) ? Math.max(0, Math.min(1, Number(profile.quality))) : 0.5,
  }
}

function classPenalty(value, order) {
  const index = order.indexOf(value)
  return index < 0 ? 1 : index
}

function tierPenalty(tier, preferredTier) {
  const order = ["light", "standard", "heavy"]
  const current = Math.max(0, order.indexOf(tier))
  const preferred = Math.max(0, order.indexOf(preferredTier))
  return Math.max(0, current - preferred)
}

export function selectCapabilityCandidate(requirements = {}, candidates = [], options = {}) {
  const required = { ...(ROLE_REQUIREMENTS[options.role] || {}), ...(requirements.required || requirements) }
  const rows = candidates.map((candidate) => {
    const profile = normalizeCapabilityProfile(candidate.capabilities || {})
    const missing = Object.entries(required)
      .filter(([key, needed]) => needed === true && BOOLEAN_CAPS.includes(key) && !profile[key])
      .map(([key]) => key)
    const score =
      profile.quality * 100 -
      classPenalty(profile.costClass, ["low", "medium", "high"]) * 8 -
      classPenalty(profile.latencyClass, ["fast", "medium", "slow"]) * 5 -
      tierPenalty(candidate.tier, options.preferredTier || candidate.tier) * 25
    return { ...candidate, capabilities: profile, missing, eligible: missing.length === 0, score }
  })
  const eligible = rows.filter((item) => item.eligible).sort((a, b) => b.score - a.score)
  return {
    selected: eligible[0] || null,
    candidates: rows,
    required,
    fallbackNeeded: eligible.length === 0,
  }
}

export function modelCandidatesFromPolicy(policy = {}) {
  const seen = new Set()
  const output = []
  for (const tier of ["light", "standard", "heavy"]) {
    const model = policy.tiers?.[tier]
    if (!model || seen.has(model)) continue
    seen.add(model)
    output.push({
      id: model,
      tier,
      capabilities: policy.capabilities?.[model] || {
        coding: true,
        reasoning: tier !== "light",
        toolCalling: true,
        filesystem: true,
        longContext: tier === "heavy",
      },
    })
  }
  return output
}

export function roleCapabilityRequirements(role) {
  return { ...(ROLE_REQUIREMENTS[role] || {}) }
}
