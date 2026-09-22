const HIGH_RISK = /(npm publish|publish package|deploy|production|git push|force push|reset --hard|git clean|delete branch|drop table|truncate|rotate secret|credential|api key|purchase|payment|irreversible|public api break)/i
const MEDIUM_RISK = /(migration|schema|dependency upgrade|lockfile|generated code|shared config|auth|permission|security)/i
const REVERSIBLE = /(local|test|rename|format|refactor|temporary|fixture|internal|reversible)/i

export function classifyDecisionPolicy(text = "", facts = {}) {
  const value = String(text || "").trim()
  const explicitlyIrreversible = facts.irreversible === true
  const externalSideEffect = facts.externalSideEffect === true
  const destructive = facts.destructive === true || HIGH_RISK.test(value)
  const medium = MEDIUM_RISK.test(value)
  const reversible = facts.reversible === true || (!destructive && REVERSIBLE.test(value))
  const risk = destructive || explicitlyIrreversible || externalSideEffect ? "high" : medium ? "medium" : "low"
  const requiresUser = risk === "high" || facts.productDecision === true
  return {
    schemaVersion: 1, risk, reversible, destructive, externalSideEffect, requiresUser,
    autoResolvable: !requiresUser && (reversible || risk === "low"),
    reason: requiresUser ? "human-approval-required" : reversible ? "reversible-local-decision" : "bounded-engineering-decision",
  }
}

export function canAutoResolveDecision(text = "", facts = {}) {
  return classifyDecisionPolicy(text, facts).autoResolvable
}
