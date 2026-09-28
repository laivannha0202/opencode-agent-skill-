const HIGH_RISK = /(npm publish|publish package|deploy|production|git push|force push|reset --hard|git clean|delete branch|drop table|truncate|rotate secret|credential|api key|purchase|payment|irreversible|public api break)/i
const MEDIUM_RISK = /(migration|schema|dependency upgrade|lockfile|generated code|shared config|auth|permission|security)/i
const REVERSIBLE = /(local|test|rename|format|refactor|temporary|fixture|internal|reversible)/i

function confidenceForDecision(input = {}) {
  if (input.requiresUser === true && (input.destructive === true || input.externalSideEffect === true || input.explicitlyIrreversible === true)) return 0.99
  if (input.reversible === true && input.risk === "low") return 0.96
  if (input.risk === "medium") return 0.82
  if (input.requiresUser === true) return 0.90
  return 0.74
}

function confidenceBand(value) {
  const score = Number(value || 0)
  if (score >= 0.90) return "high"
  if (score >= 0.72) return "medium"
  return "low"
}

export function classifyDecisionPolicy(text = "", facts = {}) {
  const value = String(text || "").trim()
  const explicitlyIrreversible = facts.irreversible === true
  const externalSideEffect = facts.externalSideEffect === true
  const destructive = facts.destructive === true || HIGH_RISK.test(value)
  const medium = MEDIUM_RISK.test(value)
  const reversible = facts.reversible === true || (!destructive && REVERSIBLE.test(value))
  const risk = destructive || explicitlyIrreversible || externalSideEffect ? "high" : medium ? "medium" : "low"
  const requiresUser = risk === "high" || facts.productDecision === true
  const autoResolvable = !requiresUser && (reversible || risk === "low")
  const confidence = confidenceForDecision({
    requiresUser,
    destructive,
    externalSideEffect,
    explicitlyIrreversible,
    reversible,
    risk,
  })
  return {
    schemaVersion: 1,
    risk,
    reversible,
    destructive,
    externalSideEffect,
    requiresUser,
    autoResolvable,
    reason: requiresUser ? "human-approval-required" : reversible ? "reversible-local-decision" : "bounded-engineering-decision",
    decision: {
      schemaVersion: 1,
      kind: String(facts.decisionKind || "engineering-choice"),
      source: "deterministic",
      value: requiresUser ? "escalate-to-user" : autoResolvable ? "auto-resolve" : "bounded-review",
      confidence,
      confidenceBand: confidenceBand(confidence),
      crossCheckRecommended: confidence < 0.72 || risk === "medium",
    },
  }
}

export function canAutoResolveDecision(text = "", facts = {}) {
  return classifyDecisionPolicy(text, facts).autoResolvable
}
