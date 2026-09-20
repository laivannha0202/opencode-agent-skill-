const HIGH_RISK = /(auth|security|permission|payment|migration|schema|database|production|deploy|public api|breaking|secret|credential|phân quyền|bảo mật|thanh toán|cơ sở dữ liệu|triển khai|migrate|migration)/i
const LONG = /(whole repo|whole repository|entire repo|entire project|long[- ]running|multi[- ]file|cross[- ]module|resume|migration|refactor all|toàn bộ repo|toàn bộ repository|toàn bộ dự án|nhiều file|nhiều module|tiếp tục công việc|refactor toàn bộ)/i
const DEBUG = /(fix|bug|debug|crash|regression|failure|error|broken|sửa lỗi|lỗi|điều tra lỗi|không chạy)/i
const CONTRACT = /(public api|api contract|openapi|response schema|request schema|breaking api|hợp đồng api|api công khai)/i
const DATA = /(database|sql|migration|schema|transaction|index|cơ sở dữ liệu|dữ liệu|migrate)/i

function signal(name, matched, weight) {
  return matched ? { name, weight } : null
}

export function classifyEngineeringTask(text, facts = {}) {
  const value = String(text || "")
  const declaredHighRisk =
    ["high", "critical"].includes(String(facts.risk || "").toLowerCase()) ||
    /\b(?:risk|rủi ro)\s*[:=-]?\s*(?:high|critical|cao|nghiêm trọng)\b/i.test(value)
  const signals = [
    signal("long-request-text", value.length > 700, 1),
    signal("medium-request-text", value.length > 250, 1),
    signal("high-risk-domain", HIGH_RISK.test(value), 2),
    signal("declared-high-risk", declaredHighRisk, 2),
    signal("explicit-long-horizon", LONG.test(value), 2),
    signal("debugging", DEBUG.test(value), 1),
    signal("public-contract", CONTRACT.test(value) || facts.hasPublicContract, 2),
    signal("data-migration", DATA.test(value) && /migration|schema|migrate|di trú|chuyển đổi/i.test(value) || facts.hasMigration, 2),
    signal("many-changed-files", Number(facts.changedFiles || 0) > 5, 1),
    signal("very-many-changed-files", Number(facts.changedFiles || 0) > 12, 1),
    signal("large-repository", Number(facts.repoFiles || 0) > 1500, 1),
    signal("monorepo", facts.monorepo === true, 1),
  ].filter(Boolean)

  const score = signals.reduce((sum, item) => sum + item.weight, 0)
  const highRisk = declaredHighRisk || HIGH_RISK.test(value) || Boolean(facts.hasMigration) || Boolean(facts.hasPublicContract)
  const risk = highRisk ? "high" : score >= 3 ? "medium" : "low"
  const mode = score >= 4 ? "long-horizon" : score >= 2 ? "standard" : "inline"
  const modelTier = risk === "high" || score >= 4 ? "heavy" : score >= 2 ? "standard" : "light"
  const maxAttempts = risk === "high" ? 2 : 3
  const contextBudget = risk === "high" || mode === "long-horizon" ? 48_000 : mode === "standard" ? 32_000 : 16_000

  const domains = []
  if (/(auth|permission|tenant|token|session|phân quyền|xác thực)/i.test(value)) domains.push("auth-security")
  if (/(payment|checkout|refund|webhook|thanh toán|hoàn tiền)/i.test(value)) domains.push("payment")
  if (DATA.test(value)) domains.push("database")
  if (CONTRACT.test(value)) domains.push("api-contract")
  if (/(react native|expo|android|ios|gradle|xcode)/i.test(value)) domains.push("react-native")
  else if (/(next\.js|nextjs|app router|server component)/i.test(value)) domains.push("nextjs")
  else if (/\breact\b|useeffect|usestate|component/i.test(value)) domains.push("react")
  if (/(docker|kubernetes|terraform|github actions|ci\/cd|deploy|triển khai)/i.test(value)) domains.push("devops")

  return {
    schemaVersion: 2,
    score,
    risk,
    mode,
    modelTier,
    maxAttempts,
    contextBudget,
    requirePlanCheck: mode === "long-horizon" || risk === "high",
    requireIntegrationVerification: mode !== "inline" || risk === "high",
    domains: [...new Set(domains)],
    signals,
  }
}
